import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { subscribeTransientAssetInvalidation } from "@/lib/notes/db";
import { releaseCanvasBackingStore } from "@/lib/notes/canvas-memory";
import {
  acquireAssetImage,
  getAssetImageDimensions,
  type AssetImage,
  type AssetImageLease,
} from "@/lib/notes/image-cache";

interface RenderedImage {
  source: string;
  width: number;
  height: number;
}

const DOCUMENT_IMAGE_MAX_DIMENSION = 2048;
const DOCUMENT_IMAGE_NEAR_MARGIN_PX = 480;

function documentPreviewDimension(cssWidth: number, visible: boolean) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const desired = Math.max(256, Math.ceil(cssWidth * dpr));
  if (desired <= 512) return 512;
  if (desired <= 1024 || !visible) return 1024;
  return DOCUMENT_IMAGE_MAX_DIMENSION;
}

// Stored document images share the same count/byte/concurrency-bounded preview
// cache as canvas notes. Only near nodes own a lease and a canvas backing store;
// the measured placeholder keeps document layout stable after they scroll far.
const ImageView = (props: any) => {
  const { node } = props;
  const assetIdOrUrl = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const storedAsset = assetIdOrUrl.startsWith("asset-id:");
  const assetId = storedAsset ? assetIdOrUrl.slice("asset-id:".length) : null;
  const [nearViewport, setNearViewport] = useState(false);
  const [visibleInViewport, setVisibleInViewport] = useState(false);
  const [assetRevision, setAssetRevision] = useState(0);
  const [targetDimension, setTargetDimension] = useState(512);
  const [rendered, setRendered] = useState<RenderedImage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const leaseRef = useRef<AssetImageLease | null>(null);

  const setCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas && canvasRef.current) releaseCanvasBackingStore(canvasRef.current);
    canvasRef.current = canvas;
  }, []);

  useEffect(() => {
    setDimensions(null);
    setRendered(null);
    setLoadFailed(false);
    releaseCanvasBackingStore(canvasRef.current);
  }, [assetIdOrUrl]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !storedAsset || !("IntersectionObserver" in window)) {
      setNearViewport(true);
      setVisibleInViewport(true);
      return;
    }
    const nearObserver = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { rootMargin: `${DOCUMENT_IMAGE_NEAR_MARGIN_PX}px 0px` },
    );
    const visibleObserver = new IntersectionObserver(
      ([entry]) => setVisibleInViewport(entry.isIntersecting),
      { rootMargin: "0px" },
    );
    nearObserver.observe(host);
    visibleObserver.observe(host);
    return () => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
    };
  }, [assetIdOrUrl, storedAsset]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !storedAsset) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = documentPreviewDimension(
          host.getBoundingClientRect().width || 512,
          visibleInViewport,
        );
        setTargetDimension((current) => (current === next ? current : next));
      });
    };
    update();
    if (!("ResizeObserver" in window)) return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [assetIdOrUrl, storedAsset, visibleInViewport]);

  useEffect(() => {
    if (!assetId) return;
    return subscribeTransientAssetInvalidation((invalidatedId) => {
      if (invalidatedId === null || invalidatedId === assetId) {
        setAssetRevision((revision) => revision + 1);
      }
    });
  }, [assetId]);

  useEffect(() => {
    leaseRef.current?.setPriority(visibleInViewport ? "visible" : "near");
  }, [visibleInViewport]);

  useEffect(() => {
    if (!storedAsset || !assetId || !nearViewport) {
      leaseRef.current = null;
      setRendered(null);
      setLoadFailed(false);
      releaseCanvasBackingStore(canvasRef.current);
      return;
    }

    let active = true;
    const lease = acquireAssetImage(
      assetId,
      visibleInViewport ? "visible" : "near",
      targetDimension,
    );
    leaseRef.current = lease;
    setLoadFailed(false);

    const paint = (image: AssetImage) => {
      if (!active) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { width, height } = getAssetImageDimensions(image);
      if (width < 1 || height < 1) throw new Error("Preview ảnh không có kích thước hợp lệ.");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Không thể khởi tạo vùng vẽ preview ảnh.");
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      if (!active) return;
      setDimensions({ width, height });
      setRendered({ source: assetIdOrUrl, width, height });
    };

    void lease.promise.then(paint).catch((error) => {
      if (!active || (error instanceof Error && error.name === "AbortError")) return;
      releaseCanvasBackingStore(canvasRef.current);
      setRendered(null);
      setLoadFailed(true);
      console.error(error);
    });

    return () => {
      active = false;
      if (leaseRef.current === lease) leaseRef.current = null;
      lease.release();
    };
  }, [
    assetId,
    assetIdOrUrl,
    assetRevision,
    nearViewport,
    storedAsset,
    targetDimension,
    visibleInViewport,
  ]);

  const placeholderStyle = dimensions
    ? {
        aspectRatio: `${dimensions.width} / ${dimensions.height}`,
        maxWidth: `${dimensions.width}px`,
      }
    : undefined;
  const storedImageReady = rendered?.source === assetIdOrUrl;
  const renderedAspectRatio = rendered
    ? { aspectRatio: `${rendered.width} / ${rendered.height}` }
    : undefined;

  return (
    <NodeViewWrapper className="my-4 flex justify-center">
      <div ref={hostRef} className="group relative flex w-full justify-center">
        {storedAsset ? (
          <>
            <canvas
              ref={setCanvasRef}
              role="img"
              aria-label={node.attrs.alt || node.attrs.title || "Ảnh trong ghi chú"}
              width={1}
              height={1}
              style={storedImageReady ? renderedAspectRatio : undefined}
              className={`${storedImageReady ? "block" : "hidden"} h-auto max-w-full rounded-md shadow-sm`}
            />
            {!storedImageReady ? (
              <div
                style={placeholderStyle}
                className={`flex w-full max-w-sm items-center justify-center rounded-md bg-surface-2 text-sm text-muted-foreground ${dimensions ? "min-h-8" : "h-32"} ${nearViewport && !loadFailed ? "animate-pulse" : ""}`}
              >
                {nearViewport ? (loadFailed ? "Không tải được ảnh" : "Đang tải ảnh...") : null}
              </div>
            ) : null}
          </>
        ) : assetIdOrUrl ? (
          <img
            src={assetIdOrUrl}
            alt={node.attrs.alt || ""}
            title={node.attrs.title || ""}
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth && image.naturalHeight) {
                setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
              }
            }}
            className="max-w-full rounded-md shadow-sm"
          />
        ) : null}
      </div>
    </NodeViewWrapper>
  );
};

export const NotesImageExtension = Node.create({
  name: "image",
  inline: false,
  group: "block",
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
