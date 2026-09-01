import { useEffect, useState } from "react";
import {
  Archive,
  CheckCircle2,
  FileDown,
  FolderOpen,
  HardDriveDownload,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  exportStartupDiagnostics,
  getSystemDiagnostics,
  openBackupFolder,
} from "@/lib/notes/startup-diagnostics";
import {
  BOOT_STAGES,
  startupMonitor,
  type BootFailure,
  type BootSnapshot,
} from "@/lib/notes/startup";
import { useNotesStore } from "@/lib/notes/store";
import { DEFAULT_SETTINGS } from "@/lib/notes/types";
import * as db from "@/lib/notes/db";
import { NotesMark } from "./logo";

function stageLabel(stage: BootSnapshot["stage"]) {
  return BOOT_STAGES.find((item) => item.id === stage)?.label ?? "Đang chuẩn bị";
}

function reload() {
  window.location.reload();
}

function ActionMessage({ message, error }: { message: string; error?: boolean }) {
  return (
    <p
      className={error ? "mt-4 text-sm text-danger" : "mt-4 text-sm text-success"}
      role={error ? "alert" : "status"}
    >
      {message}
    </p>
  );
}

export function StartupLoading({ snapshot }: { snapshot: BootSnapshot }) {
  // The first server and client render must agree. Start at zero elapsed time,
  // then switch to the wall clock after hydration.
  const [now, setNow] = useState(snapshot.startedAt);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedMs = Math.max(0, now - snapshot.startedAt);
  const stageIndex = Math.max(0, BOOT_STAGES.findIndex((item) => item.id === snapshot.stage));
  const progress = Math.max(8, Math.round(((stageIndex + 1) / BOOT_STAGES.length) * 100));
  const stalled = elapsedMs >= 8_000;

  return (
    <main className="flex min-h-svh items-center justify-center bg-bg px-5 py-10 text-fg">
      <section className="w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-soft)] sm:p-8">
        <div className="flex items-center gap-3">
          <span className="grid size-12 place-items-center rounded-lg bg-accent-soft text-accent">
            <NotesMark className="size-9" />
          </span>
          <div>
            <p className="text-lg font-semibold tracking-tight">Notes</p>
            <p className="text-sm text-muted">
              {snapshot.safeMode ? "Chế độ an toàn" : "Đang khởi động…"}
            </p>
          </div>
        </div>

        <div className="mt-8 flex items-start gap-3" aria-live="polite">
          <LoaderCircle className="mt-0.5 size-5 animate-spin text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{stageLabel(snapshot.stage)}</p>
            <p className="mt-1 text-sm text-muted">
              {snapshot.events.at(-1)?.detail || `Đã chạy ${(elapsedMs / 1_000).toFixed(1)} giây`}
            </p>
          </div>
        </div>

        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-overlay" aria-hidden>
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-[var(--motion-fast)]"
            style={{ width: `${progress}%` }}
          />
        </div>

        {stalled ? (
          <div className="mt-6 border-t border-border pt-5">
            <p className="text-sm font-semibold">Bước này mất nhiều thời gian hơn dự kiến</p>
            <p className="mt-1 text-sm leading-6 text-muted">
              Bạn có thể tiếp tục chờ hoặc mở Notes mà không khôi phục phiên trước. Dữ liệu không bị xóa.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  startupMonitor.requestSkipLastSession();
                  reload();
                }}
              >
                <SkipForward /> Bỏ qua phiên trước
              </Button>
              <Button
                onClick={() => {
                  startupMonitor.requestSafeMode();
                  reload();
                }}
              >
                <ShieldCheck /> Chế độ an toàn
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

interface RecoveryScreenProps {
  snapshot?: BootSnapshot;
  failure?: BootFailure;
  error?: Error;
  crashPrompt?: boolean;
  onContinue?: () => void;
}

export function RecoveryScreen({
  snapshot = startupMonitor.getSnapshot(),
  failure = snapshot.failure,
  error,
  crashPrompt,
  onContinue,
}: RecoveryScreenProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const stage = failure?.stage ?? snapshot.stage;
  const code = failure?.code ?? "NTS-STARTUP-RECOVERY";

  async function runAction(name: string, action: () => Promise<string | void>) {
    setBusy(name);
    setMessage(null);
    try {
      const result = await action();
      setMessage({ text: result || "Đã hoàn tất." });
    } catch (actionError) {
      setMessage({
        text: actionError instanceof Error ? actionError.message : "Không thể hoàn tất thao tác.",
        error: true,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-svh bg-bg px-4 py-8 text-fg sm:px-6">
      <section className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-soft)]">
        <div className="border-b border-border p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              {crashPrompt ? <ShieldCheck className="size-6" /> : <TriangleAlert className="size-6" />}
            </span>
            <div>
              <p className="text-sm font-medium text-accent">Khôi phục an toàn</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
                {crashPrompt
                  ? "Notes phát hiện hai lần thoát bất thường"
                  : "Notes không thể khởi động hoàn chỉnh"}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
                {crashPrompt
                  ? "Nên mở ở chế độ an toàn để bỏ qua phiên trước và các tính năng phụ. Ghi chú, PDF và bản sao lưu vẫn được giữ nguyên."
                  : "Ứng dụng đã dừng ở màn hình sửa lỗi thay vì để cửa sổ trắng. Hãy thử lại hoặc dùng chế độ an toàn; không thao tác nào bên dưới tự xóa dữ liệu."}
              </p>
            </div>
          </div>

          <dl className="mt-6 grid gap-3 rounded-lg border border-border bg-surface-2 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Bước gặp lỗi</dt>
              <dd className="mt-1 font-medium">{stageLabel(stage)}</dd>
            </div>
            <div>
              <dt className="text-muted">Mã chẩn đoán</dt>
              <dd className="mt-1 font-mono text-xs font-semibold">{code}</dd>
            </div>
          </dl>

          <div className="mt-6 flex flex-wrap gap-2">
            {crashPrompt && onContinue ? (
              <Button variant="outline" onClick={onContinue}>
                <CheckCircle2 /> Tiếp tục bình thường
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  startupMonitor.clearRecoveryFlags();
                  reload();
                }}
              >
                <RefreshCw /> Khởi động lại
              </Button>
            )}
            <Button
              onClick={() => {
                startupMonitor.requestSafeMode();
                reload();
              }}
            >
              <ShieldCheck /> Mở chế độ an toàn
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                startupMonitor.requestSkipLastSession();
                reload();
              }}
            >
              <SkipForward /> Bỏ qua ghi chú gần nhất
            </Button>
          </div>
        </div>

        <div className="grid gap-3 p-6 sm:grid-cols-2 sm:p-8">
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() =>
              void runAction("webview", async () => {
                const diagnostic = await getSystemDiagnostics();
                if (!diagnostic.webviewVersion) {
                  throw new Error(
                    "Không phát hiện được WebView2. Hãy sửa hoặc cài lại Microsoft Edge WebView2 Runtime.",
                  );
                }
                return `WebView2 ${diagnostic.webviewVersion} đang hoạt động.`;
              })
            }
          >
            <Stethoscope /> {busy === "webview" ? "Đang kiểm tra…" : "Kiểm tra WebView2"}
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void runAction("folder", async () => openBackupFolder())}
          >
            <FolderOpen /> Mở thư mục sao lưu
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() =>
              void runAction("backup", async () => {
                await useNotesStore.getState().exportBackup("full");
                return "Đã tạo bản sao lưu đầy đủ.";
              })
            }
          >
            <Archive /> Sao lưu dữ liệu
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() =>
              void runAction("diagnostics", async () => {
                const file = await exportStartupDiagnostics(error);
                return `Đã xuất nhật ký chẩn đoán: ${file}`;
              })
            }
          >
            <FileDown /> Xuất nhật ký chẩn đoán
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() =>
              void runAction("settings", async () => {
                await db.putSettings(structuredClone(DEFAULT_SETTINGS));
                startupMonitor.requestSafeMode();
                window.setTimeout(reload, 300);
                return "Đã đặt lại cài đặt giao diện; dữ liệu ghi chú được giữ nguyên.";
              })
            }
          >
            <RotateCcw /> Đặt lại cài đặt giao diện
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() =>
              void runAction("cache", async () => {
                startupMonitor.clearRecoveryFlags();
                return "Đã làm mới cache khởi động. Ghi chú và PDF không bị thay đổi.";
              })
            }
          >
            <HardDriveDownload /> Làm mới cache an toàn
          </Button>
        </div>
        {message ? (
          <div className="border-t border-border px-6 pb-6 sm:px-8 sm:pb-8">
            <ActionMessage message={message.text} error={message.error} />
          </div>
        ) : null}
      </section>
    </main>
  );
}
