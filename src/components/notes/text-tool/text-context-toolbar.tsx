import React, { useLayoutEffect, useRef, useState } from "react";
import type { TextObject } from "@/lib/notes/types";
import { displaySize, pageBBoxToDisplay } from "@/lib/notes/geometry";
import type { PageRecord } from "@/lib/notes/types";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Copy,
  Trash2,
  Edit2,
} from "lucide-react";
import { PEN_COLORS, HIGHLIGHTER_COLORS } from "@/lib/notes/types";

interface TextContextToolbarProps {
  object: TextObject;
  zoom: number;
  rotation: number;
  pageWidth: number;
  pageHeight: number;
  onUpdate: (patch: Partial<TextObject>) => void;
  onDelete: () => void;
  onEdit: () => void;
  onCopy: () => void;
}

export function TextContextToolbar({
  object,
  zoom,
  rotation,
  pageWidth,
  pageHeight,
  onUpdate,
  onDelete,
  onEdit,
  onCopy,
}: TextContextToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(46);
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    const updateHeight = () => setToolbarHeight(element.offsetHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pageGeometry = { width: pageWidth, height: pageHeight, rotation } as PageRecord;
  const display = displaySize(pageGeometry);
  const bounds = pageBBoxToDisplay(object, pageGeometry);
  const wrapperStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: display.w * zoom,
    height: display.h * zoom,
    pointerEvents: "none",
    zIndex: 50,
  };

  const topPx = bounds.y * zoom;
  const toolbarWidth = Math.min(460, Math.max(1, display.w * zoom - 16));
  const leftPx = Math.max(8, Math.min(bounds.x * zoom, display.w * zoom - toolbarWidth - 8));
  // A narrow page wraps the controls into rows; reserve their actual height.
  const preferredTop = topPx > toolbarHeight + 8
    ? topPx - toolbarHeight - 8
    : topPx + bounds.h * zoom + 8;
  const toolbarTop = Math.max(8, Math.min(preferredTop, display.h * zoom - toolbarHeight - 8));

  return (
    <div style={wrapperStyle}>
      <div
        ref={toolbarRef}
        className="absolute flex items-center gap-1 rounded-lg border bg-surface/90 p-1.5 shadow-md backdrop-blur-sm pointer-events-auto"
        style={{
          left: leftPx,
          top: toolbarTop,
          width: "max-content",
          maxWidth: toolbarWidth,
          flexWrap: "wrap",
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onEdit}
          title="Sửa chữ"
        >
          <Edit2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onCopy}
          title="Sao chép"
          aria-label="Sao chép"
        >
          <Copy className="size-4" />
        </Button>
        
        <div className="mx-1 h-5 w-px bg-border" />
        
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.fontWeight === "bold" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ fontWeight: object.fontWeight === "bold" ? "normal" : "bold" })}
          title="In đậm"
        >
          <Bold className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.fontStyle === "italic" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ fontStyle: object.fontStyle === "italic" ? "normal" : "italic" })}
          title="In nghiêng"
        >
          <Italic className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.textDecoration === "underline" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ textDecoration: object.textDecoration === "underline" ? "none" : "underline" })}
          title="Gạch chân"
        >
          <Underline className="size-4" />
        </Button>

        <div className="mx-1 h-5 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.align === "left" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ align: "left" })}
          title="Căn trái"
        >
          <AlignLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.align === "center" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ align: "center" })}
          title="Căn giữa"
        >
          <AlignCenter className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.align === "right" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ align: "right" })}
          title="Căn phải"
        >
          <AlignRight className="size-4" />
        </Button>

        <div className="mx-1 h-5 w-px bg-border" />
        
        <Popover
          trigger={
            <Button variant="ghost" size="icon" className="size-8" title="Màu chữ">
              <span className="block size-4 rounded-full border border-border/50" style={{ backgroundColor: object.color }} />
            </Button>
          }
        >
          <div className="w-48 p-2">
             <div className="flex flex-wrap gap-1.5">
               {PEN_COLORS.map((c) => (
                 <button
                   key={c}
                   className={cn(
                     "size-7 rounded-full border-2",
                     object.color === c ? "border-fg" : "border-transparent",
                   )}
                   style={{ backgroundColor: c }}
                   onClick={() => onUpdate({ color: c })}
                 />
               ))}
             </div>
          </div>
        </Popover>

        <Popover
          trigger={
            <Button variant="ghost" size="icon" className="size-8" title="Màu nền">
              <span className="block size-4 rounded-sm border border-border/50" style={{ backgroundColor: object.backgroundColor || "transparent" }} />
            </Button>
          }
        >
          <div className="w-48 p-2">
             <div className="mb-2 flex items-center justify-between">
               <span className="text-xs font-medium">Màu nền</span>
               {object.backgroundColor ? (
                 <button
                   className="text-[10px] text-danger hover:underline"
                   onClick={() => onUpdate({ backgroundColor: null })}
                 >
                   Xoá màu
                 </button>
               ) : null}
             </div>
             <div className="flex flex-wrap gap-1.5 mb-3">
               {HIGHLIGHTER_COLORS.map((c) => (
                 <button
                   key={c}
                   className={cn(
                     "size-7 rounded-full border-2",
                     object.backgroundColor === c ? "border-fg" : "border-transparent",
                   )}
                   style={{ backgroundColor: c }}
                   onClick={() => onUpdate({ backgroundColor: c, backgroundOpacity: object.backgroundOpacity ?? 1 })}
                 />
               ))}
             </div>
             {object.backgroundColor && (
               <div className="space-y-1">
                 <div className="flex justify-between text-xs">
                   <span>Độ đậm</span>
                   <span>{Math.round((object.backgroundOpacity ?? 1) * 100)}%</span>
                 </div>
                 <Slider
                   value={object.backgroundOpacity ?? 1}
                   min={0.1}
                   max={1}
                   step={0.1}
                   onValueChange={(val) => onUpdate({ backgroundOpacity: val })}
                 />
               </div>
             )}
          </div>
        </Popover>
        
        <div className="mx-1 h-5 w-px bg-border" />
        
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-danger hover:bg-danger/10 hover:text-danger"
          onClick={onDelete}
          title="Xoá hộp chữ"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}
