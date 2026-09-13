import {
  createDecodedResourceCache,
  type ResourceLease,
  type ResourcePriority,
} from "./decoded-resource-cache.ts";
import { acquireObjectUrl } from "./object-url-registry.ts";

// The 40-page baseline needed six 1536×1024 images (~36 MiB decoded) for the
// visible + near-page working set. A 96 MiB budget keeps over 2.5× that set warm
// while capping the previous 24-entry baseline (~144 MiB for the same images).
// width × height × 4 is an estimate; browser/GPU overhead is intentionally not
// represented as exact process memory.
export const IMAGE_CACHE_MAX_ENTRIES = 24;
export const IMAGE_CACHE_MAX_BYTES = 96 * 1024 * 1024;
export const IMAGE_CACHE_MAX_CONCURRENT = 4;
// The 300 ms hysteresis covered quick boundary reversals in the scroll fixture
// without allowing a fast 40-page pass to pin a second full working set.
export const IMAGE_CACHE_RELEASE_GRACE_MS = 300;

// Large originals stay byte-for-byte intact in durable storage. Canvas views
// decode a resolution tier matched to the pixels they can actually display.
// 4096 px covers a full A4 page at 300-DPI raster export, while normal canvas
// viewing selects much smaller tiers and avoids retaining full 4K/8K sources.
export const IMAGE_PREVIEW_TIERS = [256, 512, 1024, 2048, 3072, 4096] as const;
export const IMAGE_PREVIEW_MAX_DIMENSION = IMAGE_PREVIEW_TIERS.at(-1)!;

export type AssetImage = HTMLImageElement | ImageBitmap;
export type AssetImagePriority = ResourcePriority;
export interface AssetImageLease extends ResourceLease<AssetImage> {
  readonly assetId: string;
  readonly maxDimension: number;
}

export interface RasterDimensions {
  width: number;
  height: number;
}

function abortError() {
  const error = new Error("Đã hủy tải ảnh không còn được sử dụng.");
  error.name = "AbortError";
  return error;
}

function previewTier(requestedMaxDimension: number) {
  const requested = Number.isFinite(requestedMaxDimension)
    ? Math.max(1, requestedMaxDimension)
    : 1024;
  return (
    IMAGE_PREVIEW_TIERS.find((candidate) => candidate >= requested) ?? IMAGE_PREVIEW_MAX_DIMENSION
  );
}

function variantKey(assetId: string, tier: number) {
  return `${tier}\u0000${assetId}`;
}

function parseVariantKey(key: string) {
  const separator = key.indexOf("\u0000");
  if (separator < 1) throw new Error("Khóa biến thể ảnh không hợp lệ.");
  return {
    tier: Number(key.slice(0, separator)),
    assetId: key.slice(separator + 1),
  };
}

function disposeImage(image: AssetImage) {
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    image.close();
    return;
  }
  const element = image as HTMLImageElement;
  element.onload = null;
  element.onerror = null;
  element.removeAttribute("src");
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

interface IsoBox {
  type: string;
  contentStart: number;
  end: number;
}

function validDimensions(dimensions: RasterDimensions | null): dimensions is RasterDimensions {
  return Boolean(
    dimensions &&
    Number.isInteger(dimensions.width) &&
    Number.isInteger(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0,
  );
}

function isoBoxes(bytes: Uint8Array, start: number, end: number) {
  const boxes: IsoBox[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) break;
      const size64 = view.getBigUint64(offset + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(size64);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, contentStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

// AVIF stores the dimensions of an item in an ispe property. Resolve the ispe
// associated with the primary item instead of guessing from the largest box:
// an AVIF may also contain a differently sized thumbnail or auxiliary image.
function readAvifDimensions(bytes: Uint8Array): RasterDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const topLevel = isoBoxes(bytes, 0, bytes.length);
  const fileType = topLevel.find((box) => box.type === "ftyp");
  if (!fileType || fileType.contentStart + 4 > fileType.end) return null;
  const brands = ascii(bytes, fileType.contentStart, fileType.end - fileType.contentStart);
  if (!brands.includes("avif") && !brands.includes("avis")) return null;

  const meta = topLevel.find((box) => box.type === "meta");
  if (!meta || meta.contentStart + 4 > meta.end) return null;
  const metaChildren = isoBoxes(bytes, meta.contentStart + 4, meta.end);
  const primaryBox = metaChildren.find((box) => box.type === "pitm");
  const propertiesBox = metaChildren.find((box) => box.type === "iprp");
  if (!primaryBox || !propertiesBox || primaryBox.contentStart + 6 > primaryBox.end) return null;

  const primaryVersion = bytes[primaryBox.contentStart]!;
  const primaryIdOffset = primaryBox.contentStart + 4;
  const primaryId =
    primaryVersion === 0
      ? view.getUint16(primaryIdOffset)
      : primaryIdOffset + 4 <= primaryBox.end
        ? view.getUint32(primaryIdOffset)
        : null;
  if (primaryId === null) return null;

  const propertyChildren = isoBoxes(bytes, propertiesBox.contentStart, propertiesBox.end);
  const propertyContainer = propertyChildren.find((box) => box.type === "ipco");
  const associations = propertyChildren.filter((box) => box.type === "ipma");
  if (!propertyContainer || associations.length === 0) return null;

  const dimensionsByProperty = new Map<number, RasterDimensions>();
  isoBoxes(bytes, propertyContainer.contentStart, propertyContainer.end).forEach((box, index) => {
    if (box.type !== "ispe" || box.contentStart + 12 > box.end) return;
    const dimensions = {
      width: view.getUint32(box.contentStart + 4),
      height: view.getUint32(box.contentStart + 8),
    };
    if (validDimensions(dimensions)) dimensionsByProperty.set(index + 1, dimensions);
  });

  for (const associationBox of associations) {
    if (associationBox.contentStart + 8 > associationBox.end) continue;
    const version = bytes[associationBox.contentStart]!;
    const flags =
      (bytes[associationBox.contentStart + 1]! << 16) |
      (bytes[associationBox.contentStart + 2]! << 8) |
      bytes[associationBox.contentStart + 3]!;
    const widePropertyIndex = (flags & 1) !== 0;
    let offset = associationBox.contentStart + 4;
    const entryCount = view.getUint32(offset);
    offset += 4;
    for (let entry = 0; entry < entryCount; entry += 1) {
      const itemIdBytes = version < 1 ? 2 : 4;
      if (offset + itemIdBytes + 1 > associationBox.end) break;
      const itemId = itemIdBytes === 2 ? view.getUint16(offset) : view.getUint32(offset);
      offset += itemIdBytes;
      const associationCount = bytes[offset]!;
      offset += 1;
      for (let association = 0; association < associationCount; association += 1) {
        const propertyBytes = widePropertyIndex ? 2 : 1;
        if (offset + propertyBytes > associationBox.end) return null;
        const rawIndex = propertyBytes === 2 ? view.getUint16(offset) : bytes[offset]!;
        offset += propertyBytes;
        if (itemId !== primaryId) continue;
        const propertyIndex = rawIndex & (widePropertyIndex ? 0x7fff : 0x7f);
        const dimensions = dimensionsByProperty.get(propertyIndex);
        if (dimensions) return dimensions;
      }
    }
  }
  return null;
}

function readSvgDimensions(bytes: Uint8Array): RasterDimensions | null {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  if (!/<svg(?:\s|>)/i.test(head)) return null;
  const openingTag = head.match(/<svg\b[^>]*>/i)?.[0];
  if (!openingTag) return null;
  const parseLength = (name: string) => {
    const value = openingTag.match(
      new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)(?:px)?\\s*["']`, "i"),
    )?.[1];
    return value ? Number(value) : Number.NaN;
  };
  const width = parseLength("width");
  const height = parseLength("height");
  if (validDimensions({ width, height })) return { width, height };
  const viewBox = openingTag
    .match(
      /\bviewBox\s*=\s*["']\s*[-+0-9.eE]+[ ,]+[-+0-9.eE]+[ ,]+([-+0-9.eE]+)[ ,]+([-+0-9.eE]+)\s*["']/i,
    )
    ?.slice(1, 3)
    .map(Number);
  const dimensions = viewBox ? { width: viewBox[0]!, height: viewBox[1]! } : null;
  return validDimensions(dimensions) ? dimensions : null;
}

export function readRasterDimensionsFromBytes(bytes: Uint8Array): RasterDimensions | null {
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (ascii(bytes, 0, 3) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
    };
  }

  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const kind = ascii(bytes, 12, 4);
    if (kind === "VP8X") {
      const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
      return { width, height };
    }
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame && length >= 7) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
  }

  return readSvgDimensions(bytes) ?? readAvifDimensions(bytes);
}

// Read dimensions from common image headers without allocating the original
// decoded bitmap. Unknown formats fail closed instead of risking an unbounded
// decode: ImageTrack exposes frame metadata, but not reliable coded dimensions.
async function readRasterDimensions(blob: Blob, signal: AbortSignal) {
  const bytes = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  if (signal.aborted) throw abortError();
  return readRasterDimensionsFromBytes(bytes);
}

async function decodeWithImageElement(
  assetId: string,
  blob: Blob,
  signal: AbortSignal,
  maximumDimension: number,
) {
  const urlLease = acquireObjectUrl(assetId, blob);
  const image = new Image();
  image.crossOrigin = "anonymous";
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (next: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        next();
      };
      const onLoad = () => finish(resolve);
      const onError = () => finish(() => reject(new Error("Không tải được ảnh.")));
      const onAbort = () =>
        finish(() => {
          image.removeAttribute("src");
          reject(abortError());
        });

      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else image.src = urlLease.url;
    });
    if (Math.max(image.naturalWidth, image.naturalHeight) > maximumDimension) {
      throw new Error("Trình duyệt không hỗ trợ tạo preview giới hạn cho ảnh lớn này.");
    }
    return image;
  } catch (error) {
    disposeImage(image);
    throw error;
  } finally {
    urlLease.release();
  }
}

export function getAssetImageDimensions(image: AssetImage): RasterDimensions {
  if ("naturalWidth" in image) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  return { width: image.width, height: image.height };
}

export function boundedBitmapOptions(dimensions: RasterDimensions, maximumDimension: number) {
  if (!validDimensions(dimensions)) throw new RangeError("Kích thước ảnh không hợp lệ.");
  const maximum = Math.max(1, Math.floor(maximumDimension));
  const largest = Math.max(dimensions.width, dimensions.height);
  const options: ImageBitmapOptions = { resizeQuality: "high" };
  if (largest <= maximum) return options;
  if (dimensions.width >= dimensions.height) options.resizeWidth = maximum;
  else options.resizeHeight = maximum;
  return options;
}

async function decodeStoredImage(cacheKey: string, signal: AbortSignal) {
  const { assetId, tier } = parseVariantKey(cacheKey);
  // Keep the metadata helpers importable in the Node test runner without
  // initializing IndexedDB. The durable read still happens only on a real load.
  const { getAsset } = await import("./db.ts");
  const asset = await getAsset(assetId);
  if (signal.aborted) throw abortError();
  if (!asset || asset.kind !== "image") {
    throw new Error("Không tìm thấy ảnh trong kho Notes.");
  }

  const dimensions = await readRasterDimensions(asset.blob, signal);
  if (signal.aborted) throw abortError();
  if (!validDimensions(dimensions)) {
    throw new Error("Không thể xác định kích thước ảnh để tạo preview an toàn.");
  }

  let image: AssetImage;
  if (typeof createImageBitmap === "function") {
    const options = boundedBitmapOptions(dimensions, tier);
    try {
      const bitmap = await createImageBitmap(asset.blob, options);
      if (signal.aborted) {
        bitmap.close();
        throw abortError();
      }
      if (
        Math.max(bitmap.width, bitmap.height) > tier ||
        bitmap.width > dimensions.width ||
        bitmap.height > dimensions.height
      ) {
        bitmap.close();
        throw new Error("Preview ảnh vượt quá giới hạn kích thước yêu cầu.");
      }
      image = bitmap;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if (Math.max(dimensions.width, dimensions.height) > tier) {
        throw new Error("Trình duyệt không hỗ trợ tạo preview giới hạn cho ảnh lớn này.", {
          cause: error,
        });
      }
      image = await decodeWithImageElement(assetId, asset.blob, signal, tier);
    }
  } else {
    if (Math.max(dimensions.width, dimensions.height) > tier) {
      throw new Error("Trình duyệt không hỗ trợ tạo preview giới hạn cho ảnh lớn này.");
    }
    image = await decodeWithImageElement(assetId, asset.blob, signal, tier);
  }

  const { width, height } = getAssetImageDimensions(image);
  return {
    value: image,
    estimatedBytes: Math.max(0, width * height * 4),
    dispose: () => disposeImage(image),
  };
}

const cache = createDecodedResourceCache<AssetImage>({
  load: decodeStoredImage,
  maxEntries: IMAGE_CACHE_MAX_ENTRIES,
  maxBytes: IMAGE_CACHE_MAX_BYTES,
  maxConcurrent: IMAGE_CACHE_MAX_CONCURRENT,
  releaseGraceMs: IMAGE_CACHE_RELEASE_GRACE_MS,
});

function chooseLoadedTier(assetId: string, requestedTier: number) {
  for (const tier of IMAGE_PREVIEW_TIERS) {
    if (tier < requestedTier) continue;
    if (cache.peek(variantKey(assetId, tier))) return tier;
  }
  return requestedTier;
}

export function acquireAssetImage(
  assetId: string,
  priority: AssetImagePriority = "visible",
  requestedMaxDimension = 1024,
): AssetImageLease {
  const requestedTier = previewTier(requestedMaxDimension);
  const tier = chooseLoadedTier(assetId, requestedTier);
  const owned = cache.acquire(variantKey(assetId, tier), priority);
  return {
    assetId,
    maxDimension: tier,
    get promise() {
      return owned.promise;
    },
    get value() {
      return owned.value;
    },
    setPriority(nextPriority) {
      owned.setPriority(nextPriority);
    },
    release() {
      owned.release();
    },
  };
}

export function getLoadedAssetImage(assetId: string, requestedMaxDimension = 1024) {
  const requestedTier = previewTier(requestedMaxDimension);
  for (const tier of IMAGE_PREVIEW_TIERS) {
    if (tier < requestedTier) continue;
    const value = cache.peek(variantKey(assetId, tier));
    if (value) return value;
  }
  return cache.peek(variantKey(assetId, requestedTier));
}

export async function loadAssetImage(
  assetId: string,
  priority: AssetImagePriority = "background",
  requestedMaxDimension = 1024,
) {
  const lease = acquireAssetImage(assetId, priority, requestedMaxDimension);
  try {
    return await lease.promise;
  } finally {
    lease.release();
  }
}

export async function withAssetImage<T>(
  assetId: string,
  priority: AssetImagePriority,
  consume: (image: AssetImage) => T | Promise<T>,
  requestedMaxDimension = 1024,
) {
  const lease = acquireAssetImage(assetId, priority, requestedMaxDimension);
  try {
    return await consume(await lease.promise);
  } finally {
    lease.release();
  }
}

export function invalidateAssetImage(assetId: string) {
  for (const tier of IMAGE_PREVIEW_TIERS) cache.invalidate(variantKey(assetId, tier));
}

export function invalidateAllAssetImages() {
  cache.invalidateAll();
}

export function trimUnusedAssetImages(aggressive = false) {
  cache.trimUnused({ aggressive });
}

export function getImageCacheStats() {
  const stats = cache.getStats();
  return {
    ...stats,
    readyEntries: stats.ready,
    pendingEntries: stats.queued + stats.loading,
    estimatedDecodedBytes: stats.estimatedBytes,
  };
}
