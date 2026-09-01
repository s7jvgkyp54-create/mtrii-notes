import React from "react";
import type { TextObject } from "@/lib/notes/types";
import { cn } from "@/lib/utils";

interface TextSelectionOverlayProps {
  object: TextObject;
  zoom: number;
  rotation: number;
  pageWidth: number;
  pageHeight: number;
  onResizeStart: (event: React.PointerEvent, handle: "l" | "r") => void;
  onEdit: () => void;
}

export function TextSelectionOverlay({
  object,
  zoom,
  rotation,
  pageWidth,
  pageHeight,
  onResizeStart,
  onEdit,
}: TextSelectionOverlayProps) {
  const wrapperStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: pageWidth * zoom,
    height: pageHeight * zoom,
    transformOrigin: "top left",
    transform:
      rotation === 90
        ? "rotate(90deg) translateY(-100%)"
        : rotation === 180
          ? "rotate(180deg) translate(-100%, -100%)"
          : rotation === 270
            ? "rotate(270deg) translateX(-100%)"
            : "none",
    pointerEvents: "none",
    zIndex: 40,
  };

  const handleStyle = {
    width: 12,
    height: "100%",
    position: "absolute" as const,
    top: 0,
    cursor: "ew-resize",
    pointerEvents: "auto" as const,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <div style={wrapperStyle}>
      <div
        className="absolute border-2 border-accent/70 shadow-sm"
        style={{
          left: object.x * zoom,
          top: object.y * zoom,
          width: object.w * zoom,
          height: object.h * zoom,
          pointerEvents: "auto",
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
      >
        {/* Left handle */}
        <div
          style={{ ...handleStyle, left: -6 }}
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e, "l");
          }}
        >
          <div className="h-4 w-1.5 rounded-full bg-accent" />
        </div>

        {/* Right handle */}
        <div
          style={{ ...handleStyle, right: -6 }}
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e, "r");
          }}
        >
          <div className="h-4 w-1.5 rounded-full bg-accent" />
        </div>
      </div>
    </div>
  );
}
