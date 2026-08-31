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

export async function downloadAndInstallUpdate(downloadUrl: string): Promise<void> {
  if (isDesktopRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("native_download_and_install_update", { url: downloadUrl });
    return;
  }
  window.open(downloadUrl, "_blank");
}