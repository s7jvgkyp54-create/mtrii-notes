#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Clone)]
struct StoragePaths {
    root: PathBuf,
    database: PathBuf,
    assets: PathBuf,
    backups: PathBuf,
}

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

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn paths(app: &AppHandle) -> Result<StoragePaths, String> {
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
                } else if let (Ok(curr_meta), Ok(old_meta)) = (fs::metadata(&db_path), fs::metadata(&old_db)) {
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

    // Partition 2: Self-Healing Mirror Replication
    // If main DB exists, maintain a real-time mirror copy in partition 2
    if db_path.exists() {
        if let Ok(meta) = fs::metadata(&db_path) {
            if meta.len() > 0 {
                let _ = fs::copy(&db_path, &mirror_db);
            }
        }
    } else if mirror_db.exists() {
        // Self-Healing: restore from Partition 2 mirror if primary was somehow missing
        let _ = fs::copy(&mirror_db, &db_path);
    }

    Ok(StoragePaths {
        database: db_path,
        root,
        assets,
        backups,
    })
}

fn connect(app: &AppHandle) -> Result<Connection, String> {
    let p = paths(app)?;
    let connection = Connection::open(p.database).map_err(err)?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

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
        _ => return Err("Loại dữ liệu không hợp lệ".to_string()),
    };
    Ok(())
}

fn query_json(connection: &Connection, sql: &str, bind: Option<&str>) -> Result<Vec<Value>, String> {
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
    rows.into_iter()
        .map(|row| serde_json::from_str(&row).map_err(err))
        .collect()
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

fn put_asset_row(connection: &Connection, payload: &AssetPayload, relative: &str) -> Result<(), String> {
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
fn native_put_json(app: AppHandle, entity: String, id: String, value: Value) -> Result<(), String> {
    let connection = connect(&app)?;
    put_value(&connection, &entity, &id, &value)
}

#[tauri::command]
fn native_delete(app: AppHandle, entity: String, id: String) -> Result<(), String> {
    let connection = connect(&app)?;
    match entity.as_str() {
        "folders" => connection.execute("DELETE FROM folders WHERE id=?1", params![id]),
        "notebooks" => connection.execute("DELETE FROM notebooks WHERE id=?1", params![id]),
        "pages" => {
            connection
                .execute("DELETE FROM page_objects WHERE page_id=?1", params![id.clone()])
                .map_err(err)?;
            connection.execute("DELETE FROM pages WHERE id=?1", params![id])
        }
        "pageObjects" => connection.execute("DELETE FROM page_objects WHERE page_id=?1", params![id]),
        "bookmarks" => connection.execute("DELETE FROM bookmarks WHERE id=?1", params![id]),
        _ => return Err("Loại dữ liệu không hợp lệ".to_string()),
    }
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn native_get_kv(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let connection = connect(&app)?;
    let data = connection
        .query_row("SELECT data FROM kv WHERE key=?1", params![key], |row| row.get::<_, String>(0))
        .optional()
        .map_err(err)?;
    data.map(|json| serde_json::from_str(&json).map_err(err)).transpose()
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
        put_value(&transaction, "pageObjects", &value_id(value, "pageId")?, value)?;
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
fn native_open_browser_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(err)?;
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
            .args(["-L", "-f", "-s", "-S", "-o", &file_path.to_string_lossy(), &url])
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
        .invoke_handler(tauri::generate_handler![
            native_initialize,
            native_get_all,
            native_get_by_notebook,
            native_put_json,
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
            native_open_data_folder,
            native_open_browser_url,
            native_install_update,
            native_download_and_install_update,
        ])
        .run(tauri::generate_context!())
        .expect("Không thể khởi động Notes");
}
