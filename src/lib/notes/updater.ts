import { isDesktopRuntime } from "./desktop-db";

export type UpdateCheckResult = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseTitle: string;
  releaseNotes: string;
  publishedAt: string;
  releaseUrl: string;
  downloadUrl: string | null;
  assetName: string | null;
  assetSize: number | null;
};

export function cleanVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

export function parseRepoSlug(input: string): string | null {
  if (!input) return null;
  let s = input.trim();
  s = s.replace(/^https?:\/\/github\.com\//i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

export function compareSemver(v1: string, v2: string): number {
  const p1 = cleanVersion(v1).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const p2 = cleanVersion(v2).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] ?? 0;
    const b = p2[i] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

export async function checkForGithubUpdates(
  repoInput: string,
  currentVersion: string,
): Promise<{ ok: boolean; result?: UpdateCheckResult; message?: string }> {
  const slug = parseRepoSlug(repoInput);
  if (!slug) {
    return {
      ok: false,
      message: "Chưa cấu hình đường dẫn GitHub Repository (ví dụ: your-username/mtrii-notes).",
    };
  }

  if (slug === "username/mtrii-notes") {
    return {
      ok: false,
      message: "Vui lòng nhập chính xác GitHub username/repo của bạn trong Cài đặt.",
    };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (res.status === 404) {
      return {
        ok: false,
        message: `Không tìm thấy bản phát hành nào trên repository "${slug}". Hãy tạo Release đầu tiên trên GitHub.`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        message: `Lỗi kết nối GitHub API (${res.status} ${res.statusText}).`,
      };
    }

    const data = await res.json();
    const latestTag = data.tag_name || data.name || "";
    const latestVer = cleanVersion(latestTag);
    const currVer = cleanVersion(currentVersion);

    const updateAvailable = compareSemver(latestVer, currVer) > 0;

    // Search for Windows installer .exe asset
    let downloadUrl: string | null = null;
    let assetName: string | null = null;
    let assetSize: number | null = null;

    if (Array.isArray(data.assets) && data.assets.length > 0) {
      const exeAsset =
        data.assets.find((a: { name: string }) => a.name?.toLowerCase().endsWith(".exe")) ||
        data.assets[0];
      if (exeAsset) {
        downloadUrl = exeAsset.browser_download_url || null;
        assetName = exeAsset.name || null;
        assetSize = exeAsset.size || null;
      }
    }

    return {
      ok: true,
      result: {
        updateAvailable,
        currentVersion: currVer,
        latestVersion: latestVer,
        releaseTitle: data.name || latestTag,
        releaseNotes: data.body || "Không có ghi chú phát hành.",
        publishedAt: data.published_at || new Date().toISOString(),
        releaseUrl: data.html_url || `https://github.com/${slug}/releases`,
        downloadUrl,
        assetName,
        assetSize,
      },
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: `Không thể kết nối đến GitHub để kiểm tra cập nhật: ${err}`,
    };
  }
}

export async function openExternalUrl(url: string) {
  if (isDesktopRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("native_open_browser_url", { url });
      return;
    } catch {
      // Fallback
    }
  }
  window.open(url, "_blank");
}

export async function downloadAndInstallUpdate(
  downloadUrl: string,
  assetName: string,
  onProgress?: (progress: number, loaded: number, total: number) => void,
): Promise<void> {
  if (!isDesktopRuntime()) {
    throw new Error("Tính năng cài đặt tự động chỉ khả dụng trên ứng dụng Mtrii Notes Desktop.");
  }

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Tải bản cập nhật thất bại: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

  let loadedBytes = 0;
  const chunks: Uint8Array[] = [];

  if (response.body && response.body.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loadedBytes += value.length;
        if (totalBytes > 0 && onProgress) {
          const pct = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
          onProgress(pct, loadedBytes, totalBytes);
        }
      }
    }
  } else {
    const buffer = await response.arrayBuffer();
    chunks.push(new Uint8Array(buffer));
    loadedBytes = buffer.byteLength;
    if (onProgress) onProgress(100, loadedBytes, loadedBytes);
  }

  // Combine chunks into single Uint8Array
  const combined = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("native_install_update", {
    filename: assetName || "MtriiNotes-Update.exe",
    bytes: Array.from(combined),
  });
}