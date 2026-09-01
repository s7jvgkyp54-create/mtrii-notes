import React from "react";
import type { TextObject } from "@/lib/notes/types";
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
}: TextContextToolbarProps) {
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
    zIndex: 50,
  };

  const topPx = object.y * zoom;
  const leftPx = object.x * zoom;
  // Position above the object, or below if too close to top
  const toolbarTop = topPx > 60 ? topPx - 50 : topPx + object.h * zoom + 10;

  return (
    <div style={wrapperStyle}>
      <div
        className="absolute flex items-center gap-1 rounded-lg border bg-surface/90 p-1.5 shadow-md backdrop-blur-sm pointer-events-auto"
        style={{
          left: leftPx,
          top: toolbarTop,
          // Prevent it from going off the right edge
          maxWidth: Math.min(600, pageWidth * zoom - leftPx),
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
        >
          <AlignLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.align === "center" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ align: "center" })}
        >
          <AlignCenter className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", object.align === "right" && "bg-overlay text-fg")}
          onClick={() => onUpdate({ align: "right" })}
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
                   onClick={() => onUpdate({ backgroundColor: c, backgroundOpacity: object.backgroundOpacity || 1 })}
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
