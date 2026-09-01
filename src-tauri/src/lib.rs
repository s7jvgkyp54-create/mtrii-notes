#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
mod oauth;

#[tauri::command]
async fn start_google_oauth(
    client_id: String,
    client_secret: String,
) -> Result<oauth::OAuthTokens, String> {
    let (redirect_uri, rx) = oauth::start_local_server()?;

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=https://www.googleapis.com/auth/drive.readonly",
        client_id, urlencoding::encode(&redirect_uri)
    );

    // Open browser
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", &auth_url.replace("&", "^&")])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&auth_url).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open")
        .arg(&auth_url)
        .spawn();

    // Wait for code (with a 2-minute timeout handled by the server loop)
    let code = rx
        .recv()
        .map_err(|_| "Timeout hoac loi khi cho ma xac thuc".to_string())?;

    // Exchange for tokens
    oauth::exchange_code(&client_id, &client_secret, &code, &redirect_uri).await
}

#[tauri::command]
async fn download_drive_file(
    app: tauri::AppHandle,
    access_token: String,
    file_id: String,
    mime_type: String,
    file_name: String,
) -> Result<String, String> {
    let paths = paths(&app)?;
    let asset_id = uuid::Uuid::new_v4().to_string();

    let client = reqwest::Client::new();
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?alt=media",
        file_id
    );

    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| format!("Loi khi goi API Google Drive: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Google Drive tra ve loi: {}", res.status()));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;

    let ext = if mime_type == "application/pdf" {
        "pdf"
    } else {
        "png"
    };
    let filename = format!("{}.{}", asset_id, ext);
    let path = paths.assets.join(&filename);

    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    // Also save to database
    let db_path = paths.database.clone();
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    conn.execute(
        "INSERT INTO assets (id, kind, mime, name, byteLength, createdAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![asset_id, if ext == "pdf" { "pdf" } else { "image" }, mime_type, file_name, bytes.len() as i64, now],
    ).map_err(|e| e.to_string())?;

    Ok(asset_id)
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Clone)]
struct StoragePaths {
    root: PathBuf,
    database: PathBuf,
    mirror_database: PathBuf,
    assets: PathBuf,
    backups: PathBuf,
}

static STORAGE_PATHS: OnceLock<StoragePaths> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetMeta {
    id: String,
    kind: String,
    mime: String,
    name: String,
    byte_length: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AssetPayload {
    meta: AssetMeta,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupMeta {
    id: String,
    created_at: i64,
    name: String,
    byte_length: i64,
    kind: String,
    notebook_count: i64,
    page_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupPayload {
    meta: BackupMeta,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportPayload {
    folders: Vec<Value>,
    notebooks: Vec<Value>,
    pages: Vec<Value>,
    page_objects: Vec<Value>,
    assets: Vec<AssetPayload>,
    bookmarks: Vec<Value>,
    settings: Option<Value>,
    app_meta: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct JsonWrite {
    entity: String,
    id: String,
    value: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupData {
    folders: Vec<Value>,
    notebooks: Vec<Value>,
    settings: Option<Value>,
    meta: Option<Value>,
}

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn paths(app: &AppHandle) -> Result<StoragePaths, String> {
    if let Some(cached) = STORAGE_PATHS.get() {
        return Ok(cached.clone());
    }
    // Partition 1: Permanent Isolated Vault (AppData/Roaming/NotesData)
    // Completely separated from installation folder, app identifiers, or uninstallers.
    let base_roaming = app.path().app_data_dir().map_err(err)?;
    let root = if let Some(roaming_parent) = base_roaming.parent() {
        roaming_parent.join("NotesData")
    } else {
        base_roaming.clone()
    };

    let assets = root.join("assets");
    let backups = root.join("backups");
    let mirror_dir = root.join("mirror_vault");
    fs::create_dir_all(&root).map_err(err)?;
    fs::create_dir_all(&assets).map_err(err)?;
    fs::create_dir_all(&backups).map_err(err)?;
    fs::create_dir_all(&mirror_dir).map_err(err)?;
    let db_path = root.join("notes.sqlite3");
    let mirror_db = mirror_dir.join("notes_mirror.sqlite3");

    // Universal Data Collector: scan all previous local and roaming folders
    let mut candidate_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(local_data) = app.path().app_local_data_dir() {
        if let Some(local_parent) = local_data.parent() {
            candidate_dirs.push(local_parent.join("com.mtrii.notes"));
            candidate_dirs.push(local_parent.join("com.notes.desktop"));
            candidate_dirs.push(local_parent.join("Notes"));
        }
    }
    if let Some(roaming_parent) = base_roaming.parent() {
        candidate_dirs.push(roaming_parent.join("com.mtrii.notes"));
        candidate_dirs.push(roaming_parent.join("com.notes.desktop"));
        candidate_dirs.push(roaming_parent.join("Notes"));
    }

    for candidate in &candidate_dirs {
        if candidate != &root && candidate.exists() {
            let old_db = candidate.join("notes.sqlite3");
            if old_db.exists() {
                let should_copy = if !db_path.exists() {
                    true
                } else if let (Ok(curr_meta), Ok(old_meta)) =
                    (fs::metadata(&db_path), fs::metadata(&old_db))
                {
                    old_meta.len() > curr_meta.len() && curr_meta.len() <= 81920
                } else {
                    false
                };
                if should_copy {
                    let _ = fs::copy(&old_db, &db_path);
                }
            }
            let old_assets = candidate.join("assets");
            if old_assets.exists() {
                if let Ok(entries) = fs::read_dir(&old_assets) {
                    for entry in entries.flatten() {
                        let target = assets.join(entry.file_name());
                        if !target.exists() {
                            let _ = fs::copy(entry.path(), target);
                        }
                    }
                }
            }
            let old_backups = candidate.join("backups");
            if old_backups.exists() {
                if let Ok(entries) = fs::read_dir(&old_backups) {
                    for entry in entries.flatten() {
                        let target = backups.join(entry.file_name());
                        if !target.exists() {
                            let _ = fs::copy(entry.path(), target);
                        }
                    }
                }
            }
        }
    }

    // Partition 2: restore only during initialization. A fresh mirror is made
    // after pending writes are flushed so the WAL is checkpointed first.
    if !db_path.exists() && mirror_db.exists() {
        // Self-Healing: restore from Partition 2 mirror if primary was somehow missing
        let _ = fs::copy(&mirror_db, &db_path);
    }

    let resolved = StoragePaths {
        database: db_path,
        mirror_database: mirror_db,
        root,
        assets,
        backups,
    };
    let _ = STORAGE_PATHS.set(resolved.clone());
    Ok(resolved)
}

fn run_migrations(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(err)?;
    transaction
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS folders (
              id TEXT PRIMARY KEY,
              data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notebooks (
              id TEXT PRIMARY KEY,
              data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pages (
              id TEXT PRIMARY KEY,
              notebook_id TEXT NOT NULL,
              sort_index INTEGER NOT NULL,
              data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS pages_by_notebook
              ON pages(notebook_id, sort_index);
            CREATE TABLE IF NOT EXISTS page_objects (
              page_id TEXT PRIMARY KEY,
              data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bookmarks (
              id TEXT PRIMARY KEY,
              notebook_id TEXT NOT NULL,
              data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS bookmarks_by_notebook
              ON bookmarks(notebook_id);
            CREATE TABLE IF NOT EXISTS assets (
              id TEXT PRIMARY KEY,
              relative_path TEXT NOT NULL,
              meta_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS backups (
              id TEXT PRIMARY KEY,
              created_at INTEGER NOT NULL,
              relative_path TEXT NOT NULL,
              meta_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kv (
              key TEXT PRIMARY KEY,
              data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS migrations (
              version INTEGER PRIMARY KEY,
              applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            INSERT OR IGNORE INTO migrations(version) VALUES (1);
            "#,
        )
        .map_err(err)?;
    transaction.commit().map_err(err)?;

    let has_v2 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM migrations WHERE version=2)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(err)?;
    if !has_v2 {
        let transaction = connection.transaction().map_err(err)?;
        transaction
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS tombstones (
                  id TEXT PRIMARY KEY,
                  deleted_at INTEGER NOT NULL,
                  data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pomodoro_history (
                  id TEXT PRIMARY KEY,
                  started_at INTEGER NOT NULL,
                  data TEXT NOT NULL
                );
                INSERT INTO migrations(version) VALUES (2);
                "#,
            )
            .map_err(err)?;
        transaction.commit().map_err(err)?;
    }

    let has_v3 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM migrations WHERE version=3)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(err)?;
    if !has_v3 {
        let transaction = connection.transaction().map_err(err)?;
        transaction
            .execute_batch(
                r#"
                CREATE INDEX IF NOT EXISTS backups_by_created_at
                  ON backups(created_at DESC);
                CREATE INDEX IF NOT EXISTS pomodoro_history_by_started_at
                  ON pomodoro_history(started_at DESC);
                INSERT INTO migrations(version) VALUES (3);
                "#,
            )
            .map_err(err)?;
        transaction.commit().map_err(err)?;
    }

    let has_v4 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM migrations WHERE version=4)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(err)?;
    if !has_v4 {
        let transaction = connection.transaction().map_err(err)?;
        transaction
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS documents (
                  id TEXT PRIMARY KEY,
                  data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS note_links (
                  id TEXT PRIMARY KEY,
                  data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS note_versions (
                  id TEXT PRIMARY KEY,
                  data TEXT NOT NULL
                );
                INSERT INTO migrations(version) VALUES (4);
                "#,
            )
            .map_err(err)?;
        transaction.commit().map_err(err)?;
    }
    Ok(())
}

fn connect(app: &AppHandle) -> Result<Connection, String> {
    let p = paths(app)?;
    let mut connection = Connection::open(p.database).map_err(err)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(err)?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            "#,
        )
        .map_err(err)?;
    run_migrations(&mut connection)?;
    Ok(connection)
}

fn json_text(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(err)
}

fn value_id(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Thiếu trường {field}"))
}

fn put_value(connection: &Connection, entity: &str, id: &str, value: &Value) -> Result<(), String> {
    let data = json_text(value)?;
    match entity {
        "folders" => connection
            .execute(
                "INSERT INTO folders(id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                params![id, data],
            )
            .map_err(err)?,
        "notebooks" => connection
            .execute(
                "INSERT INTO notebooks(id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                params![id, data],
            )
            .map_err(err)?,
        "pages" => {
            let notebook_id = value_id(value, "notebookId")?;
            let index = value
                .get("index")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Thiếu thứ tự trang".to_string())?;
            connection
                .execute(
                    "INSERT INTO pages(id, notebook_id, sort_index, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET notebook_id=excluded.notebook_id, sort_index=excluded.sort_index, data=excluded.data",
                    params![id, notebook_id, index, data],
                )
                .map_err(err)?
        }
        "pageObjects" => connection
            .execute(
                "INSERT INTO page_objects(page_id, data) VALUES (?1, ?2) ON CONFLICT(page_id) DO UPDATE SET data=excluded.data",
                params![id, data],
            )
            .map_err(err)?,
        "bookmarks" => {
            let notebook_id = value_id(value, "notebookId")?;
            connection
                .execute(
                    "INSERT INTO bookmarks(id, notebook_id, data) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET notebook_id=excluded.notebook_id, data=excluded.data",
                    params![id, notebook_id, data],
                )
                .map_err(err)?
        }
        "tombstones" => {
            let deleted_at = value
                .get("deletedAt")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Thiếu thời gian xóa".to_string())?;
            connection
                .execute(
                    "INSERT INTO tombstones(id, deleted_at, data) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at, data=excluded.data",
                    params![id, deleted_at, data],
                )
                .map_err(err)?
        }
        "pomodoroHistory" => {
            let started_at = value
                .get("startTime")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Thiếu thời gian Pomodoro".to_string())?;
            connection
                .execute(
                    "INSERT INTO pomodoro_history(id, started_at, data) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, data=excluded.data",
                    params![id, started_at, data],
                )
                .map_err(err)?
        }
        _ => return Err("Loại dữ liệu không hợp lệ".to_string()),
    };
    Ok(())
}

fn query_json(
    connection: &Connection,
    sql: &str,
    bind: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut statement = connection.prepare(sql).map_err(err)?;
    let rows = if let Some(value) = bind {
        statement
            .query_map(params![value], |row| row.get::<_, String>(0))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?
    } else {
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?
    };
    let mut values = Vec::with_capacity(rows.len());
    for row in rows {
        match serde_json::from_str(&row) {
            Ok(value) => values.push(value),
            Err(error) => {
                // Preserve the raw row in SQLite but isolate it from startup.
                // Never print the row itself because it may contain private notes.
                eprintln!("[notes] isolated invalid JSON row: {error}");
            }
        }
    }
    Ok(values)
}

fn query_kv_value(connection: &Connection, key: &str) -> Result<Option<Value>, String> {
    let data = connection
        .query_row("SELECT data FROM kv WHERE key=?1", params![key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(err)?;
    let Some(contents) = data else {
        return Ok(None);
    };
    match serde_json::from_str(&contents) {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            eprintln!("[notes] isolated invalid kv value for {key}: {error}");
            Ok(None)
        }
    }
}

fn safe_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Ok(())
    } else {
        Err("Định danh tệp không hợp lệ".to_string())
    }
}

fn extension(meta: &AssetMeta) -> &'static str {
    if meta.kind == "pdf" || meta.mime == "application/pdf" {
        "pdf"
    } else if meta.mime.contains("png") {
        "png"
    } else if meta.mime.contains("webp") {
        "webp"
    } else if meta.mime.contains("gif") {
        "gif"
    } else if meta.kind == "audio" {
        "audio"
    } else {
        "jpg"
    }
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let temp = target.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temp, bytes).map_err(err)?;
    fs::OpenOptions::new()
        .write(true)
        .open(&temp)
        .map_err(err)?
        .sync_all()
        .map_err(err)?;
    if target.exists() {
        fs::remove_file(target).map_err(err)?;
    }
    if fs::rename(&temp, target).is_ok() {
        return Ok(());
    }

    // Some Windows security/indexing products briefly hold a newly-created
    // file and reject rename. Preserve the completed bytes with a flushed
    // copy, then remove the orphaned temp file as a compatibility fallback.
    fs::copy(&temp, target).map_err(err)?;
    fs::OpenOptions::new()
        .write(true)
        .open(target)
        .map_err(err)?
        .sync_all()
        .map_err(err)?;
    fs::remove_file(&temp).map_err(err)?;
    Ok(())
}

fn cleanup_stale_temps(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let is_temp = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".tmp"));
        if !is_temp {
            continue;
        }
        let old_enough = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > Duration::from_secs(60 * 60));
        if old_enough {
            let _ = fs::remove_file(path);
        }
    }
}

fn put_asset_row(
    connection: &Connection,
    payload: &AssetPayload,
    relative: &str,
) -> Result<(), String> {
    let meta_json = serde_json::to_string(&payload.meta).map_err(err)?;
    connection
        .execute(
            "INSERT INTO assets(id, relative_path, meta_json) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path, meta_json=excluded.meta_json",
            params![payload.meta.id, relative, meta_json],
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn native_initialize(app: AppHandle) -> Result<(), String> {
    let p = paths(&app)?;
    cleanup_stale_temps(&p.assets);
    cleanup_stale_temps(&p.backups);
    connect(&app).map(|_| ())
}

#[tauri::command]
fn native_get_all(app: AppHandle, entity: String) -> Result<Vec<Value>, String> {
    let connection = connect(&app)?;
    let sql = match entity.as_str() {
        "folders" => "SELECT data FROM folders",
        "notebooks" => "SELECT data FROM notebooks",
        "pages" => "SELECT data FROM pages ORDER BY notebook_id, sort_index",
        "pageObjects" => "SELECT data FROM page_objects",
        "bookmarks" => "SELECT data FROM bookmarks",
        "tombstones" => "SELECT data FROM tombstones ORDER BY deleted_at",
        "pomodoroHistory" => "SELECT data FROM pomodoro_history ORDER BY started_at",
        _ => return Err("Loại dữ liệu không hợp lệ".to_string()),
    };
    query_json(&connection, sql, None)
}

#[tauri::command]
fn native_get_by_notebook(
    app: AppHandle,
    entity: String,
    notebook_id: String,
) -> Result<Vec<Value>, String> {
    let connection = connect(&app)?;
    let sql = match entity.as_str() {
        "pages" => "SELECT data FROM pages WHERE notebook_id=?1 ORDER BY sort_index",
        "bookmarks" => "SELECT data FROM bookmarks WHERE notebook_id=?1",
        "pageObjects" => "SELECT po.data FROM page_objects po INNER JOIN pages p ON p.id=po.page_id WHERE p.notebook_id=?1 ORDER BY p.sort_index",
        _ => return Err("Không thể lọc loại dữ liệu này theo sổ".to_string()),
    };
    query_json(&connection, sql, Some(&notebook_id))
}

#[tauri::command]
fn native_load_startup_data(app: AppHandle) -> Result<StartupData, String> {
    let connection = connect(&app)?;
    Ok(StartupData {
        folders: query_json(&connection, "SELECT data FROM folders", None)?,
        notebooks: query_json(&connection, "SELECT data FROM notebooks", None)?,
        settings: query_kv_value(&connection, "settings")?,
        meta: query_kv_value(&connection, "meta")?,
    })
}

#[tauri::command]
fn native_put_json(app: AppHandle, entity: String, id: String, value: Value) -> Result<(), String> {
    let connection = connect(&app)?;
    put_value(&connection, &entity, &id, &value)
}

#[tauri::command]
fn native_put_json_batch(app: AppHandle, writes: Vec<JsonWrite>) -> Result<(), String> {
    let mut connection = connect(&app)?;
    put_values_batch(&mut connection, writes)
}

fn put_values_batch(connection: &mut Connection, writes: Vec<JsonWrite>) -> Result<(), String> {
    if writes.is_empty() {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(err)?;
    for write in writes {
        put_value(&transaction, &write.entity, &write.id, &write.value)?;
    }
    transaction.commit().map_err(err)?;
    Ok(())
}

#[tauri::command]
fn native_flush_storage(app: AppHandle) -> Result<(), String> {
    let storage = paths(&app)?;
    let connection = connect(&app)?;
    connection
        .execute_batch("PRAGMA wal_checkpoint(FULL);")
        .map_err(err)?;
    drop(connection);
    let bytes = fs::read(&storage.database).map_err(err)?;
    atomic_write(&storage.mirror_database, &bytes)
}

#[tauri::command]
fn native_delete(app: AppHandle, entity: String, id: String) -> Result<(), String> {
    let connection = connect(&app)?;
    match entity.as_str() {
        "folders" => connection.execute("DELETE FROM folders WHERE id=?1", params![id]),
        "notebooks" => connection.execute("DELETE FROM notebooks WHERE id=?1", params![id]),
        "pages" => {
            connection
                .execute(
                    "DELETE FROM page_objects WHERE page_id=?1",
                    params![id.clone()],
                )
                .map_err(err)?;
            connection.execute("DELETE FROM pages WHERE id=?1", params![id])
        }
        "pageObjects" => {
            connection.execute("DELETE FROM page_objects WHERE page_id=?1", params![id])
        }
        "bookmarks" => connection.execute("DELETE FROM bookmarks WHERE id=?1", params![id]),
        "tombstones" => connection.execute("DELETE FROM tombstones WHERE id=?1", params![id]),
        "pomodoroHistory" => {
            connection.execute("DELETE FROM pomodoro_history WHERE id=?1", params![id])
        }
        _ => return Err("Loại dữ liệu không hợp lệ".to_string()),
    }
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn native_get_kv(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let connection = connect(&app)?;
    query_kv_value(&connection, &key)
}

#[tauri::command]
fn native_put_kv(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let connection = connect(&app)?;
    connection
        .execute(
            "INSERT INTO kv(key, data) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
            params![key, json_text(&value)?],
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn native_put_asset(app: AppHandle, payload: AssetPayload) -> Result<(), String> {
    safe_id(&payload.meta.id)?;
    let p = paths(&app)?;
    let file_name = format!("{}.{}", payload.meta.id, extension(&payload.meta));
    let target = p.assets.join(&file_name);
    atomic_write(&target, &payload.bytes)?;
    let connection = connect(&app)?;
    put_asset_row(&connection, &payload, &format!("assets/{file_name}"))
}

#[tauri::command]
fn native_get_asset(app: AppHandle, id: String) -> Result<Option<AssetPayload>, String> {
    let p = paths(&app)?;
    let connection = connect(&app)?;
    let row = connection
        .query_row(
            "SELECT meta_json, relative_path FROM assets WHERE id=?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(err)?;
    let Some((meta_json, relative_path)) = row else {
        return Ok(None);
    };
    let meta = serde_json::from_str(&meta_json).map_err(err)?;
    let bytes = fs::read(p.root.join(relative_path)).map_err(err)?;
    Ok(Some(AssetPayload { meta, bytes }))
}

#[tauri::command]
fn native_delete_asset(app: AppHandle, id: String) -> Result<(), String> {
    let p = paths(&app)?;
    let connection = connect(&app)?;
    let relative = connection
        .query_row(
            "SELECT relative_path FROM assets WHERE id=?1",
            params![id.clone()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(err)?;
    connection
        .execute("DELETE FROM assets WHERE id=?1", params![id])
        .map_err(err)?;
    if let Some(relative) = relative {
        let file = p.root.join(relative);
        if file.exists() {
            fs::remove_file(file).map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn native_list_asset_ids(app: AppHandle) -> Result<Vec<String>, String> {
    let connection = connect(&app)?;
    let mut statement = connection.prepare("SELECT id FROM assets").map_err(err)?;
    let ids = statement
        .query_map([], |row| row.get(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(ids)
}

#[tauri::command]
fn native_put_backup(app: AppHandle, payload: BackupPayload) -> Result<(), String> {
    safe_id(&payload.meta.id)?;
    let p = paths(&app)?;
    let file_name = format!("{}.notesbackup", payload.meta.id);
    atomic_write(&p.backups.join(&file_name), &payload.bytes)?;
    let connection = connect(&app)?;
    connection
        .execute(
            "INSERT INTO backups(id, created_at, relative_path, meta_json) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, relative_path=excluded.relative_path, meta_json=excluded.meta_json",
            params![payload.meta.id, payload.meta.created_at, format!("backups/{file_name}"), serde_json::to_string(&payload.meta).map_err(err)?],
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn native_get_backup(app: AppHandle, id: String) -> Result<Option<BackupPayload>, String> {
    let p = paths(&app)?;
    let connection = connect(&app)?;
    let row = connection
        .query_row(
            "SELECT meta_json, relative_path FROM backups WHERE id=?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(err)?;
    let Some((meta_json, relative_path)) = row else {
        return Ok(None);
    };
    Ok(Some(BackupPayload {
        meta: serde_json::from_str(&meta_json).map_err(err)?,
        bytes: fs::read(p.root.join(relative_path)).map_err(err)?,
    }))
}

#[tauri::command]
fn native_list_backups(app: AppHandle) -> Result<Vec<Value>, String> {
    let connection = connect(&app)?;
    query_json(
        &connection,
        "SELECT meta_json FROM backups ORDER BY created_at DESC",
        None,
    )
}

#[tauri::command]
fn native_delete_backup(app: AppHandle, id: String) -> Result<(), String> {
    let p = paths(&app)?;
    let connection = connect(&app)?;
    let relative = connection
        .query_row(
            "SELECT relative_path FROM backups WHERE id=?1",
            params![id.clone()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(err)?;
    connection
        .execute("DELETE FROM backups WHERE id=?1", params![id])
        .map_err(err)?;
    if let Some(relative) = relative {
        let file = p.root.join(relative);
        if file.exists() {
            fs::remove_file(file).map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn native_import_dump(app: AppHandle, payload: ImportPayload, replace: bool) -> Result<(), String> {
    let p = paths(&app)?;
    let mut imported_files = HashSet::new();
    for asset in &payload.assets {
        safe_id(&asset.meta.id)?;
        let file_name = format!("{}.{}", asset.meta.id, extension(&asset.meta));
        atomic_write(&p.assets.join(&file_name), &asset.bytes)?;
        imported_files.insert(file_name);
    }

    let mut connection = connect(&app)?;
    let transaction = connection.transaction().map_err(err)?;
    if replace {
        transaction
            .execute_batch(
                "DELETE FROM folders; DELETE FROM notebooks; DELETE FROM page_objects; DELETE FROM pages; DELETE FROM assets; DELETE FROM bookmarks; DELETE FROM kv WHERE key IN ('settings','meta');",
            )
            .map_err(err)?;
    }
    for value in &payload.folders {
        put_value(&transaction, "folders", &value_id(value, "id")?, value)?;
    }
    for value in &payload.notebooks {
        put_value(&transaction, "notebooks", &value_id(value, "id")?, value)?;
    }
    for value in &payload.pages {
        put_value(&transaction, "pages", &value_id(value, "id")?, value)?;
    }
    for value in &payload.page_objects {
        put_value(
            &transaction,
            "pageObjects",
            &value_id(value, "pageId")?,
            value,
        )?;
    }
    for value in &payload.bookmarks {
        put_value(&transaction, "bookmarks", &value_id(value, "id")?, value)?;
    }
    for asset in &payload.assets {
        let file_name = format!("{}.{}", asset.meta.id, extension(&asset.meta));
        put_asset_row(&transaction, asset, &format!("assets/{file_name}"))?;
    }
    if replace {
        if let Some(settings) = &payload.settings {
            transaction
                .execute(
                    "INSERT INTO kv(key, data) VALUES ('settings', ?1)",
                    params![json_text(settings)?],
                )
                .map_err(err)?;
        }
        if let Some(meta) = &payload.app_meta {
            transaction
                .execute(
                    "INSERT INTO kv(key, data) VALUES ('meta', ?1)",
                    params![json_text(meta)?],
                )
                .map_err(err)?;
        }
    }
    transaction.commit().map_err(err)?;

    if replace {
        for entry in fs::read_dir(&p.assets).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_file() && !imported_files.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_size(&path)
            } else {
                entry.metadata().map(|meta| meta.len()).unwrap_or(0)
            }
        })
        .sum()
}

#[tauri::command]
fn native_system_diagnostics(app: AppHandle) -> Result<Value, String> {
    let storage = paths(&app)?;
    let database_bytes = fs::metadata(&storage.database)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let migrations = Connection::open(&storage.database)
        .ok()
        .and_then(|connection| {
            let mut statement = connection
                .prepare("SELECT version FROM migrations ORDER BY version")
                .ok()?;
            let result = statement
                .query_map([], |row| row.get::<_, i64>(0))
                .ok()?
                .collect::<Result<Vec<_>, _>>()
                .ok();
            result
        })
        .unwrap_or_default();
    let write_probe = storage.root.join(format!(".write-check-{}", Uuid::new_v4()));
    let writable = fs::write(&write_probe, b"ok")
        .and_then(|_| fs::remove_file(&write_probe))
        .is_ok();
    let webview_version = tauri::webview_version().ok();
    #[cfg(target_os = "windows")]
    let platform = {
        let mut command = std::process::Command::new("cmd");
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .args(["/C", "ver"])
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Windows".to_string())
    };
    #[cfg(not(target_os = "windows"))]
    let platform = std::env::consts::OS.to_string();
    Ok(json!({
        "platform": platform,
        "appVersion": app.package_info().version.to_string(),
        "webviewVersion": webview_version,
        "databaseBytes": database_bytes,
        "storageBytes": directory_size(&storage.root),
        "migrations": migrations,
        "writable": writable,
    }))
}

#[tauri::command]
fn native_export_diagnostics(app: AppHandle, contents: String) -> Result<String, String> {
    if contents.len() > 1024 * 1024 {
        return Err("Nhật ký chẩn đoán vượt quá giới hạn 1 MB".to_string());
    }
    let storage = paths(&app)?;
    let diagnostics = storage.root.join("diagnostics");
    fs::create_dir_all(&diagnostics).map_err(err)?;
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(err)?
        .as_secs();
    let file_name = format!("notes-diagnostic-{timestamp}.json");
    atomic_write(&diagnostics.join(&file_name), contents.as_bytes())?;

    let mut logs = fs::read_dir(&diagnostics)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    logs.sort_by_key(|entry| {
        std::cmp::Reverse(
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH),
        )
    });
    for old in logs.into_iter().skip(10) {
        let _ = fs::remove_file(old.path());
    }
    Ok(file_name)
}

#[tauri::command]
fn native_storage_usage(app: AppHandle) -> Result<u64, String> {
    Ok(directory_size(&paths(&app)?.root))
}

#[tauri::command]
fn native_open_data_folder(app: AppHandle) -> Result<(), String> {
    let root = paths(&app)?.root;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(root)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = root;
        Err("Chức năng này chỉ dành cho Windows".to_string())
    }
}

#[tauri::command]
fn native_open_backup_folder(app: AppHandle) -> Result<(), String> {
    let backups = paths(&app)?.backups;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(backups)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = backups;
        Err("Chức năng này chỉ dành cho Windows".to_string())
    }
}

#[tauri::command]
fn native_open_browser_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.args(["/c", "start", "", &url]).spawn().map_err(err)?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Ok(())
    }
}

#[tauri::command]
fn native_install_update(filename: String, bytes: Vec<u8>) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join(filename);
    fs::write(&file_path, bytes).map_err(err)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&file_path)
            .args(["/S"])
            .spawn()
            .map_err(err)?;
        std::process::exit(0);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

#[tauri::command]
fn native_download_and_install_update(url: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join("Notes-Update.exe");
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("curl.exe");
        cmd.creation_flags(CREATE_NO_WINDOW);
        let status = cmd
            .args([
                "-L",
                "-f",
                "-s",
                "-S",
                "-o",
                &file_path.to_string_lossy(),
                &url,
            ])
            .status();

        let success = match status {
            Ok(s) => s.success(),
            Err(_) => false,
        };

        if !success {
            let mut ps_cmd = std::process::Command::new("powershell");
            ps_cmd.creation_flags(CREATE_NO_WINDOW);
            let ps_status = ps_cmd
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('{}', '{}')",
                        url,
                        file_path.display()
                    ),
                ])
                .status()
                .map_err(err)?;

            if !ps_status.success() {
                return Err("Tải file cập nhật từ GitHub thất bại.".to_string());
            }
        }

        std::process::Command::new(&file_path)
            .args(["/S"])
            .spawn()
            .map_err(err)?;
        std::process::exit(0);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            start_google_oauth,
            download_drive_file,
            native_initialize,
            native_get_all,
            native_get_by_notebook,
            native_load_startup_data,
            native_put_json,
            native_put_json_batch,
            native_flush_storage,
            native_delete,
            native_get_kv,
            native_put_kv,
            native_put_asset,
            native_get_asset,
            native_delete_asset,
            native_list_asset_ids,
            native_put_backup,
            native_get_backup,
            native_list_backups,
            native_delete_backup,
            native_import_dump,
            native_storage_usage,
            native_system_diagnostics,
            native_export_diagnostics,
            native_open_data_folder,
            native_open_backup_folder,
            native_open_browser_url,
            native_install_update,
            native_download_and_install_update,
        ])
        .run(tauri::generate_context!())
        .expect("Không thể khởi động Notes");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_create_optional_tables_and_commit_versions() {
        let mut connection = Connection::open_in_memory().expect("open in-memory sqlite");
        run_migrations(&mut connection).expect("run migrations");
        let versions = {
            let mut statement = connection
                .prepare("SELECT version FROM migrations ORDER BY version")
                .expect("prepare versions");
            statement
                .query_map([], |row| row.get::<_, i64>(0))
                .expect("query versions")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect versions")
        };
        assert_eq!(versions, vec![1, 2, 3]);
        for table in ["tombstones", "pomodoro_history"] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    params![table],
                    |row| row.get(0),
                )
                .expect("check table");
            assert!(exists, "missing {table}");
        }
    }

    #[test]
    fn invalid_json_rows_are_isolated_without_deletion() {
        let connection = Connection::open_in_memory().expect("open in-memory sqlite");
        connection
            .execute("CREATE TABLE records(data TEXT NOT NULL)", [])
            .expect("create records");
        connection
            .execute("INSERT INTO records(data) VALUES (?1), (?2)", params![r#"{"id":"ok"}"#, "{broken"])
            .expect("insert records");
        let values = query_json(&connection, "SELECT data FROM records", None).expect("query json");
        assert_eq!(values, vec![json!({ "id": "ok" })]);
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .expect("count rows");
        assert_eq!(row_count, 2, "quarantine must not delete the invalid row");
    }

    #[test]
    fn pomodoro_history_round_trips_after_migration() {
        let mut connection = Connection::open_in_memory().expect("open in-memory sqlite");
        run_migrations(&mut connection).expect("run migrations");
        let value = json!({
            "id": "timer-1",
            "startTime": 1234,
            "endTime": 2345,
            "durationMs": 1111,
            "phase": "focus",
            "status": "completed",
            "taskName": null,
            "notebookId": null,
            "pageId": null
        });
        put_value(&connection, "pomodoroHistory", "timer-1", &value).expect("store history");
        let values = query_json(
            &connection,
            "SELECT data FROM pomodoro_history ORDER BY started_at",
            None,
        )
        .expect("load history");
        assert_eq!(values, vec![value]);
    }

    #[test]
    fn batch_write_rolls_back_every_row_when_one_value_is_invalid() {
        let mut connection = Connection::open_in_memory().expect("open in-memory sqlite");
        run_migrations(&mut connection).expect("run migrations");
        let writes = vec![
            JsonWrite {
                entity: "pages".into(),
                id: "page-ok".into(),
                value: json!({ "id": "page-ok", "notebookId": "book-1", "index": 0 }),
            },
            JsonWrite {
                entity: "pages".into(),
                id: "page-invalid".into(),
                value: json!({ "id": "page-invalid", "index": 1 }),
            },
        ];
        assert!(put_values_batch(&mut connection, writes).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
            .expect("count pages");
        assert_eq!(count, 0, "a failed batch must roll back all earlier rows");
    }

    #[test]
    fn large_library_fixture_round_trips_two_thousand_notebooks() {
        let mut connection = Connection::open_in_memory().expect("open in-memory sqlite");
        run_migrations(&mut connection).expect("run migrations");
        let writes = (0..2_000)
            .map(|index| JsonWrite {
                entity: "notebooks".into(),
                id: format!("book-{index}"),
                value: json!({
                    "id": format!("book-{index}"),
                    "name": format!("Fixture {index}"),
                    "updatedAt": index,
                    "favorite": index % 7 == 0,
                    "deletedAt": Value::Null
                }),
            })
            .collect();
        put_values_batch(&mut connection, writes).expect("store fixture");
        let values = query_json(&connection, "SELECT data FROM notebooks", None)
            .expect("read fixture");
        assert_eq!(values.len(), 2_000);
    }
}
