import { getAsset, objectUrlFor } from "./db";

const MAX_IMAGES = 24;
const imageCache = new Map<string, Promise<HTMLImageElement>>();

export async function loadAssetImage(assetId: string) {
  const cached = imageCache.get(assetId);
  if (cached) {
    imageCache.delete(assetId);
    imageCache.set(assetId, cached);
    return cached;
  }

  const loading = getAsset(assetId).then(
    (asset) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        if (!asset) {
          reject(new Error("Không tìm thấy ảnh trong kho Notes."));
          return;
        }
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Không tải được ảnh."));
        image.src = objectUrlFor(assetId, asset.blob);
      }),
  );
  imageCache.set(assetId, loading);
  loading.catch(() => imageCache.delete(assetId));

  while (imageCache.size > MAX_IMAGES) {
    const oldest = imageCache.keys().next().value as string | undefined;
    if (!oldest || oldest === assetId) break;
    imageCache.delete(oldest);
  }
  return loading;
}
