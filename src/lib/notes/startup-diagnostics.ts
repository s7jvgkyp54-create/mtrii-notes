import { startupMonitor } from "./startup";

export interface SystemDiagnostics {
  platform: string;
  appVersion?: string;
  webviewVersion?: string | null;
  databaseBytes?: number;
  storageBytes?: number;
  migrations?: number[];
  writable?: boolean;
}

function isDesktopRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function scrub(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
    .replace(/([A-Za-z]:\\|\/Users\/|\/home\/)[^\s)\]]+/g, "<local-path>")
    .slice(0, 4_000);
}

async function invokeNative<T>(command: string, args: Record<string, unknown> = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  if (isDesktopRuntime()) return invokeNative<SystemDiagnostics>("native_system_diagnostics");
  return {
    platform: typeof navigator === "undefined" ? "server" : navigator.userAgent,
    webviewVersion: null,
    storageBytes: 0,
    writable: true,
  };
}

export async function exportStartupDiagnostics(error?: Error) {
  const runtimePerformance = await import("./performance")
    .then((module) => module.getRuntimePerformance())
    .catch(() => undefined);
  const system = await getSystemDiagnostics().catch((diagnosticError) => ({
    platform: "unknown",
    diagnosticError:
      diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
  }));
  const report = startupMonitor.report({
    system,
    runtimePerformance,
    capturedError: error
      ? { name: error.name, message: scrub(error.message), stack: error.stack ? scrub(error.stack) : undefined }
      : undefined,
  });
  const contents = JSON.stringify(report, null, 2);
  if (isDesktopRuntime()) {
    return invokeNative<string>("native_export_diagnostics", { contents });
  }
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `notes-diagnostic-${new Date().toISOString().replaceAll(":", "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  return anchor.download;
}

export async function openBackupFolder() {
  if (!isDesktopRuntime()) throw new Error("Thư mục sao lưu chỉ có trong bản Windows.");
  await invokeNative("native_open_backup_folder");
}
