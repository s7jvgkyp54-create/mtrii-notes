import { useEffect, useRef, useState } from "react";
import type { TextObject } from "@/lib/notes/types";
import { cn } from "@/lib/utils";

interface TextEditorOverlayProps {
  editing: TextObject;
  zoom: number;
  pageWidth: number;
  pageHeight: number;
  rotation: number;
  onCommit: (text: string, w: number, h: number) => void;
  onCancel: () => void;
}

export function TextEditorOverlay({
  editing,
  zoom,
  pageWidth,
  pageHeight,
  rotation,
  onCommit,
  onCancel,
}: TextEditorOverlayProps) {
  const [text, setText] = useState(editing.text);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastCommitRef = useRef(false);
  const mountedTimeRef = useRef(Date.now());

  const callbacksRef = useRef({ onCommit, onCancel });
  useEffect(() => {
    callbacksRef.current = { onCommit, onCancel };
  }, [onCommit, onCancel]);

  // Auto-resize
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(editing.fontSize * 1.5 * zoom, el.scrollHeight)}px`;
  }, [text, editing.fontSize, zoom]);

  // Flush on unmount if there's uncommitted text
  useEffect(() => {
    return () => {
      if (lastCommitRef.current) return;
      const el = textareaRef.current;
      if (el) {
        const final = el.value.trimEnd();
        if (final) {
          const w = Math.max(120, el.offsetWidth / zoom);
          const h = Math.max(editing.fontSize * 1.5, el.scrollHeight / zoom);
          callbacksRef.current.onCommit(final, w, h);
        } else if (!editing.text) {
          callbacksRef.current.onCancel();
        }
      }
    };
  }, [editing.text, zoom]);

  const handleCommit = (el: HTMLTextAreaElement) => {
    if (isComposing) return;
    const final = el.value.trimEnd();
    lastCommitRef.current = true;
    if (final) {
      const w = Math.max(120, el.offsetWidth / zoom);
      const h = Math.max(editing.fontSize * 1.5, el.scrollHeight / zoom);
      onCommit(final, w, h);
    } else {
      onCancel();
    }
  };

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

  const bgColor = editing.backgroundColor
    ? `${editing.backgroundColor}${Math.round((editing.backgroundOpacity ?? 1) * 255)
        .toString(16)
        .padStart(2, "0")}`
    : "transparent";

  return (
    <div style={wrapperStyle}>
      <textarea
        ref={textareaRef}
        autoFocus
        rows={2}
        placeholder="Nhập nội dung…"
        className={cn(
          "absolute resize overflow-auto rounded-md border-2 border-accent bg-surface-2/95 p-2 text-fg outline-none shadow-lg",
          "pointer-events-auto",
        )}
        style={{
          left: editing.x * zoom,
          top: editing.y * zoom,
          width: Math.max(120, editing.w * zoom),
          minHeight: editing.fontSize * 1.5 * zoom,
          fontSize: editing.fontSize * zoom,
          color: editing.color,
          fontFamily: `"${editing.fontFamily || "Be Vietnam Pro"}", sans-serif`,
          fontWeight: editing.fontWeight || "normal",
          fontStyle: editing.fontStyle || "normal",
          textDecoration: editing.textDecoration || "none",
          textAlign: editing.align || "left",
          backgroundColor: bgColor,
          lineHeight: editing.lineHeight ?? 1.4,
        }}
        value={text}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={(e) => {
          setIsComposing(false);
          // Composition end might also update text if we rely on synthetic events
          setText(e.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            lastCommitRef.current = true;
            if (editing.text) {
              onCommit(editing.text, editing.w, editing.h);
            } else {
              onCancel();
            }
          } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            handleCommit(event.currentTarget);
          }
        }}
        onBlur={(e) => {
          if (Date.now() - mountedTimeRef.current < 200) {
            // Browser fired mousedown/blur sequence immediately after creation. Force focus back.
            e.currentTarget.focus();
            return;
          }
          handleCommit(e.currentTarget);
        }}
      />
    </div>
  );
}
