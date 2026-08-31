import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft, FolderOpen, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { APP_ID, APP_NAME, APP_VERSION, BACKUP_FORMAT_VERSION, SCHEMA_VERSION } from "@/lib/notes/types";
import { useNotesStore } from "@/lib/notes/store";
import { useNotesNavigate } from "@/lib/notes/navigation";
import { formatBytes, relativeVi } from "@/lib/utils";
import { NotesMark } from "./logo";
import type { BackupPreview } from "@/lib/notes/io";
import { isNativeStorage, openDataFolder } from "@/lib/notes/db";
import { checkForGithubUpdates, type UpdateCheckResult } from "@/lib/notes/updater";
import { UpdateDialog } from "./update-dialog";

export function SettingsView() {
  const navigate = useNotesNavigate();
  const settings = useNotesStore((s) => s.settings);
  const usage = useNotesStore((s) => s.storageUsage);
  const quota = useNotesStore((s) => s.storageQuota);
  const lastSaveAt = useNotesStore((s) => s.lastSaveAt);
  const backups = useNotesStore((s) => s.backups);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const nativeStorage = isNativeStorage();

  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const res = await checkForGithubUpdates(settings.githubRepo || "", APP_VERSION);
      useNotesStore.getState().persistSettings({ lastUpdateCheckAt: Date.now() });

      if (!res.ok) {
        toast.error(res.message || "Không thể kiểm tra bản cập nhật.");
        return;
      }

      if (res.result?.updateAvailable) {
        setUpdateInfo(res.result);
        setShowUpdateDialog(true);
        toast.success(`Đã có bản cập nhật mới: v${res.result.latestVersion}`);
      } else {
        toast.success(`Bạn đang sử dụng phiên bản mới nhất (v${APP_VERSION}).`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Đã xảy ra lỗi khi kiểm tra cập nhật.");
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <div className="min-h-svh bg-bg text-fg">
      <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/" })}>
          <ArrowLeft /> Thư viện
        </Button>
        <h1 className="text-lg font-semibold">Cài đặt</h1>
      </header>
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Giao diện</h2>
          <Row label="Nền tối" hint="Giấy viết vẫn giữ màu sáng để dễ đọc.">
            <Switch
              checked={settings.theme === "dark"}
              onCheckedChange={(v) => useNotesStore.getState().persistSettings({ theme: v ? "dark" : "light" })}
            />
          </Row>
          <Row label="Chỉ viết bằng bút" hint="Ngón tay dùng để cuộn trang; chỉ bút mới để lại nét.">
            <Switch
              checked={settings.penOnly}
              onCheckedChange={(v) => useNotesStore.getState().persistSettings({ penOnly: v })}
            />
          </Row>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Dữ liệu</h2>
          <div className="rounded-xl border border-border bg-surface-2 p-4">
            <div className="flex items-start gap-3">
              <HardDrive className="mt-0.5 size-4 text-accent" />
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {nativeStorage ? "Kho Windows (SQLite + tệp cục bộ)" : "Kho trình duyệt (IndexedDB)"}
                </p>
                {nativeStorage ? (
                  <p className="mt-1 text-muted">
                    Dữ liệu nằm tại <span className="font-mono text-xs">%LOCALAPPDATA%\{APP_ID}\</span>. PDF và ảnh
                    được sao chép vào kho riêng; xóa tệp nguồn không làm hỏng sổ.
                  </p>
                ) : (
                  <p className="mt-1 text-muted">
                    Định danh <span className="font-mono text-xs">{APP_ID}</span>. Dữ liệu gắn với trình duyệt trên
                    thiết bị này, không tải lên máy chủ. Xóa cookie/site data của trang sẽ mất sổ.
                  </p>
                )}
                <p className="mt-3 tabular-nums">
                  Dung lượng: {formatBytes(usage)}
                  {quota ? ` / ${formatBytes(quota)}` : ""}
                </p>
                <p className="text-muted">
                  Lần lưu gần nhất: {lastSaveAt ? relativeVi(lastSaveAt) : "Chưa có"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    if (nativeStorage) {
                      void openDataFolder().catch((error) => toast.error(String(error)));
                    } else {
                      toast.message("Trên web không mở được thư mục Windows. Dữ liệu nằm trong IndexedDB của trang này.");
                    }
                  }}
                >
                  <FolderOpen className="size-3.5" /> Mở thư mục dữ liệu
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Sao lưu và khôi phục</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await useNotesStore.getState().exportBackup("full");
                  toast.success("Đã tạo tệp sao lưu");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Xuất thất bại");
                }
              }}
            >
              Xuất toàn bộ dữ liệu
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              Nhập bản sao lưu
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void useNotesStore
                  .getState()
                  .runAutoBackup()
                  .then(() => toast.success("Đã sao lưu"))
              }
            >
              Sao lưu ngay
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".notesbackup,.mtriibackup,.zip"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  const p = await useNotesStore.getState().previewBackup(f);
                  setFile(f);
                  setPreview(p);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Không đọc được bản sao lưu");
                }
              }}
            />
          </div>
          <Row
            label="Sao lưu tự động mỗi ngày"
            hint="Chỉ chạy khi ứng dụng đang mở. Nếu bỏ lỡ, lần mở tiếp theo sẽ chạy bù. Ứng dụng đóng thì không tự chạy nền."
          >
            <Switch
              checked={settings.autoBackup}
              onCheckedChange={(v) => useNotesStore.getState().persistSettings({ autoBackup: v })}
            />
          </Row>
          <Row label={`Giữ ${settings.backupKeep} bản gần nhất`}>
            <input
              type="number"
              min={1}
              max={30}
              className="h-10 w-20 rounded-md border border-border bg-surface-2 px-2 text-sm"
              value={settings.backupKeep}
              onChange={(e) =>
                useNotesStore.getState().persistSettings({ backupKeep: Math.max(1, Number(e.target.value) || 7) })
              }
            />
          </Row>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface-2">
            {backups.length === 0 ? (
              <li className="px-3 py-4 text-sm text-muted">Chưa có bản sao lưu trong kho.</li>
            ) : (
              backups.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{b.name}</p>
                    <p className="text-xs text-muted">
                      {b.kind === "auto" ? "Tự động" : "Thủ công"} · {b.notebookCount} sổ · {formatBytes(b.byteLength)} ·{" "}
                      {relativeVi(b.createdAt)}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void useNotesStore.getState().downloadStoredBackup(b.id)}>
                    Tải
                  </Button>
                </li>
              ))
            )}
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Giới thiệu và cập nhật</h2>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-4">
            <NotesMark className="size-12" />
            <div>
              <p className="font-semibold">{APP_NAME}</p>
              <p className="text-sm text-muted">
                Phiên bản {APP_VERSION} · schema {SCHEMA_VERSION} · backup v{BACKUP_FORMAT_VERSION}
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <Row
              label="GitHub Repository"
              hint="Địa chỉ kho mã nguồn GitHub để kiểm tra bản phát hành mới (ví dụ: username/repo-name hoặc link github.com/username/repo)."
            >
              <div className="w-64 max-w-full">
                <Input
                  value={settings.githubRepo || ""}
                  placeholder="username/repo-name"
                  onChange={(e) =>
                    useNotesStore.getState().persistSettings({ githubRepo: e.target.value })
                  }
                  className="font-mono text-xs"
                />
              </div>
            </Row>

            <Row
              label="Tự kiểm tra cập nhật khi mở"
              hint="Tự động kiểm tra GitHub Releases mỗi khi khởi động ứng dụng mà không chặn công việc của bạn."
            >
              <Switch
                checked={settings.autoCheckUpdates}
                onCheckedChange={(v) => useNotesStore.getState().persistSettings({ autoCheckUpdates: v })}
              />
            </Row>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                variant="outline"
                disabled={checkingUpdate}
                onClick={() => void handleCheckUpdate()}
                className="gap-2"
              >
                {checkingUpdate ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Đang kiểm tra...
                  </>
                ) : (
                  <>
                    <RefreshCw className="size-4" />
                    Kiểm tra bản cập nhật mới
                  </>
                )}
              </Button>
              {settings.lastUpdateCheckAt && (
                <span className="text-xs text-muted">
                  Lần kiểm tra gần nhất: {relativeVi(settings.lastUpdateCheckAt)}
                </span>
              )}
            </div>
          </div>

          <p className="mt-4 text-xs text-muted leading-relaxed">
            Mẹo: Khi bạn tạo Release mới trên GitHub và đính kèm bộ cài <span className="font-mono text-fg">.exe</span>, ứng dụng sẽ tự động phát hiện và hướng dẫn nâng cấp ngay tại đây.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Đồng bộ và tính năng nâng cao</h2>
          <p className="text-sm text-muted">
            Đồng bộ nhiều máy chưa bật — tách biệt với sao lưu. Không đặt file đang ghi vào OneDrive/Google Drive.
            OCR chữ viết tay, AI hỏi đáp, flashcard, thước kẻ và laser chưa khả dụng; không trả kết quả giả.
          </p>
        </section>
      </div>

      <Dialog
        open={!!preview}
        onOpenChange={(o) => {
          if (!o) {
            setPreview(null);
            setFile(null);
          }
        }}
        title="Nhập bản sao lưu"
        description={
          preview
            ? `${preview.manifest.notebookCount} sổ · ${preview.manifest.pageCount} trang · tạo ${preview.manifest.createdAt.slice(0, 10)}`
            : undefined
        }
        className="w-[min(92vw,520px)]"
      >
        {preview ? (
          <div className="text-sm">
            <p className="font-medium">Sổ trong gói</p>
            <ul className="mt-1 mb-3 list-disc pl-4 text-muted">
              {preview.notebookNames.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {preview.warnings.length ? (
              <p className="mb-3 text-warn">{preview.warnings.join(" · ")}</p>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              Thay thế toàn bộ thư viện hiện tại (sẽ sao lưu dữ liệu đang có trước)
            </label>
            <p className="mt-2 text-xs text-muted">
              Mặc định gộp vào thư viện, cấp ID mới, không ghi đè âm thầm.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Hủy
              </Button>
              <Button
                onClick={async () => {
                  if (!file) return;
                  try {
                    const r = await useNotesStore.getState().importBackupFile(file, replace ? "replace" : "merge");
                    toast.success(`Đã nhập ${r.names.length} sổ`);
                    if (r.warnings.length) toast.message(r.warnings.join(" · "));
                    setPreview(null);
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Nhập thất bại");
                  }
                }}
              >
                Xác nhận nhập
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <UpdateDialog
        updateInfo={updateInfo}
        open={showUpdateDialog}
        onOpenChange={setShowUpdateDialog}
      />
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}