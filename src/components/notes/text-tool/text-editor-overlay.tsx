import { useLayoutEffect, useRef, useState } from "react";
import type { TextObject } from "@/lib/notes/types";
import { registerActiveTextDraft } from "@/lib/notes/text-draft-registry";
import { measureTextHeight } from "./text-layout";

interface TextEditorOverlayProps {
  sessionId: string;
  notebookId: string;
  pageId: string;
  editing: TextObject;
  zoom: number;
  pageWidth: number;
  pageHeight: number;
  rotation: number;
  onDraftChange: (draft: TextObject) => void;
  onCommit: (draft: TextObject) => void;
  onCancel: () => void;
}

export function TextEditorOverlay({
  sessionId,
  notebookId,
  pageId,
  editing,
  zoom,
  pageWidth,
  pageHeight,
  rotation,
  onDraftChange,
  onCommit,
  onCancel,
}: TextEditorOverlayProps) {
  const [text, setText] = useState(editing.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const pendingBlurRef = useRef(false);
  const settledRef = useRef(false);
  const lifecycleRef = useRef(0);
  const latestRef = useRef({ editing, text, onDraftChange, onCommit, onCancel });
  latestRef.current = { editing, text, onDraftChange, onCommit, onCancel };

  function buildDraft(value: string) {
    const latest = latestRef.current.editing;
    const width = Math.max(1, latest.w);
    return {
      ...latest,
      text: value,
      w: width,
      h: measureTextHeight(
        value,
        width,
        latest.fontSize,
        latest.fontFamily,
        latest.fontWeight,
        latest.fontStyle,
        latest.lineHeight,
      ),
    } satisfies TextObject;
  }

  function publish(value: string) {
    const draft = buildDraft(value);
    latestRef.current.onDraftChange(draft);
    return draft;
  }
  const publishRef = useRef(publish);
  publishRef.current = publish;

  function finish(value: string) {
    if (settledRef.current) return;
    settledRef.current = true;
    const latest = latestRef.current;
    const draft = publishRef.current(value);
    // Match the existing editor contract: finishing an empty value cancels
    // the edit. The parent restores an existing object's session baseline,
    // while a brand-new empty object simply remains absent.
    if (!value.trim()) {
      latest.onCancel();
      return;
    }
    latest.onCommit(draft);
  }
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const height = measureTextHeight(
    text,
    editing.w,
    editing.fontSize,
    editing.fontFamily,
    editing.fontWeight,
    editing.fontStyle,
    editing.lineHeight,
  );

  // Match the saved canvas text box without zoom-dependent padding or borders.
  // Resize before paint so typing another line never flashes a scrollbar.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = `${height * zoom}px`;
    if (element.scrollHeight > element.clientHeight) {
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [height, text, editing.w, editing.fontFamily, editing.fontWeight, editing.fontStyle, zoom]);

  useLayoutEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    const element = textareaRef.current;
    const unregister = registerActiveTextDraft(
      { sessionId, notebookId, pageId, objectId: editing.id },
      () => {
        if (!settledRef.current) {
          publishRef.current(element?.value ?? latestRef.current.text);
        }
      },
    );
    element?.focus({ preventScroll: true });
    if (element) element.setSelectionRange(element.value.length, element.value.length);
    return () => {
      // The DOM ref is cleared before passive cleanup. Capture the live value
      // now, then ignore React StrictMode's simulated unmount/remount cycle.
      const value = element?.value ?? latestRef.current.text;
      unregister();
      queueMicrotask(() => {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reading the live counter is how StrictMode's simulated remount is distinguished from a real unmount
        if (lifecycleRef.current === lifecycle) finishRef.current(value);
      });
    };
  }, [editing.id, notebookId, pageId, sessionId]);

  const formattingSignature = [
    editing.x,
    editing.y,
    editing.w,
    editing.fontSize,
    editing.fontFamily,
    editing.fontWeight,
    editing.fontStyle,
    editing.textDecoration,
    editing.align,
    editing.color,
    editing.backgroundColor,
    editing.backgroundOpacity,
    editing.lineHeight,
    editing.rotation,
  ].join("|");
  const lastFormattingRef = useRef(formattingSignature);
  useLayoutEffect(() => {
    if (lastFormattingRef.current === formattingSignature) return;
    lastFormattingRef.current = formattingSignature;
    if (!settledRef.current) {
      publishRef.current(textareaRef.current?.value ?? latestRef.current.text);
    }
  }, [formattingSignature]);

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

  return (
    <div style={wrapperStyle}>
      {editing.backgroundColor ? (
        <div
          className="absolute"
          style={{
            left: editing.x * zoom,
            top: editing.y * zoom,
            width: Math.max(1, editing.w) * zoom,
            height: height * zoom,
            backgroundColor: editing.backgroundColor,
            opacity: Math.max(0, Math.min(1, editing.backgroundOpacity ?? 1)),
          }}
        />
      ) : null}
      <textarea
        ref={textareaRef}
        data-notes-text-editor="true"
        rows={1}
        aria-label="Nội dung hộp chữ"
        placeholder="Nhập nội dung…"
        className="absolute pointer-events-auto resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 text-fg outline outline-2 outline-accent outline-offset-2"
        style={{
          left: editing.x * zoom,
          top: editing.y * zoom,
          width: Math.max(1, editing.w) * zoom,
          minHeight: editing.fontSize * (editing.lineHeight ?? 1.4) * zoom,
          fontSize: editing.fontSize * zoom,
          color: editing.color,
          fontFamily: `"${editing.fontFamily || "Be Vietnam Pro"}", "Segoe UI", sans-serif`,
          fontWeight: editing.fontWeight || "normal",
          fontStyle: editing.fontStyle || "normal",
          textDecoration: editing.textDecoration || "none",
          textAlign: editing.align || "left",
          lineHeight: editing.lineHeight ?? 1.4,
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          tabSize: 4,
        }}
        value={text}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          publishRef.current(value);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const element = event.currentTarget;
          setText(element.value);
          publishRef.current(element.value);
          if (pendingBlurRef.current) {
            pendingBlurRef.current = false;
            queueMicrotask(() => finishRef.current(element.value));
          }
        }}
        onKeyDown={(event) => {
          if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settledRef.current = true;
            onCancel();
          } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            finish(event.currentTarget.value);
          }
        }}
        onBlur={(event) => {
          if (composingRef.current) {
            pendingBlurRef.current = true;
            return;
          }
          finish(event.currentTarget.value);
        }}
      />
    </div>
  );
}
