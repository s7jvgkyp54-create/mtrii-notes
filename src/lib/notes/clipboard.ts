import { cloneObject } from "./geometry";
import { APP_ID, type CanvasObject } from "./types";

export const NOTES_CLIPBOARD_MIME = "application/x-mtrii-notes-canvas+json";
export const NOTES_CLIPBOARD_VERSION = 1 as const;

const HTML_MARKER_ATTRIBUTE = "data-mtrii-notes-clipboard";
const MAX_PAYLOAD_LENGTH = 8 * 1024 * 1024;
const MAX_OBJECTS = 1_000;
const MAX_STROKE_POINTS = 250_000;

export interface NotesClipboardPayload {
  appId: typeof APP_ID;
  kind: "notes-canvas-objects";
  version: typeof NOTES_CLIPBOARD_VERSION;
  token: string;
  copiedAt: number;
  sourceNotebookId: string;
  sourcePageId: string;
  objects: CanvasObject[];
}

export type NotesClipboardWriteStatus = "rich" | "text-only" | "failed";

export function canDeleteCutSource(status: NotesClipboardWriteStatus) {
  return status === "rich";
}

export type CanvasPasteSource =
  | { kind: "notes"; payload: NotesClipboardPayload }
  | { kind: "images"; files: File[] }
  | { kind: "text"; text: string }
  | { kind: "none" };

interface ClipboardReader {
  readonly types?: readonly string[];
  readonly items?: Iterable<Pick<DataTransferItem, "kind" | "type" | "getAsFile">>;
  readonly files?: Iterable<File>;
  getData(type: string): string;
}

interface ClipboardWriter {
  readonly types?: readonly string[];
  setData(type: string, value: string): void;
  getData?(type: string): string;
}

interface ActiveClipboard {
  payload: NotesClipboardPayload;
  serialized: string;
  plainText: string;
}

let activeClipboard: ActiveClipboard | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, max = 2_000_000): value is string {
  return typeof value === "string" && value.length <= max;
}

function isId(value: unknown): value is string {
  return isBoundedString(value, 128) && value.length > 0;
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalString(value: unknown, allowed?: readonly string[]) {
  return value === undefined || (typeof value === "string" && (!allowed || allowed.includes(value)));
}

function isCanvasObject(value: unknown): value is CanvasObject {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== "string") return false;

  if (value.type === "stroke") {
    if (
      !["ballpoint", "fountain", "pencil", "highlighter"].includes(String(value.tool)) ||
      !isBoundedString(value.color, 256) ||
      !isFiniteCoordinate(value.width) ||
      value.width <= 0 ||
      !Array.isArray(value.points) ||
      value.points.length > MAX_STROKE_POINTS
    ) return false;
    return value.points.every((point) =>
      isRecord(point) &&
      isFiniteCoordinate(point.x) &&
      isFiniteCoordinate(point.y) &&
      isFiniteCoordinate(point.p),
    );
  }

  if (value.type === "text") {
    return (
      isFiniteCoordinate(value.x) &&
      isFiniteCoordinate(value.y) &&
      isFiniteCoordinate(value.w) && value.w > 0 &&
      isFiniteCoordinate(value.h) && value.h > 0 &&
      isBoundedString(value.text) &&
      isFiniteCoordinate(value.fontSize) && value.fontSize > 0 &&
      isBoundedString(value.color, 256) &&
      ["left", "center", "right"].includes(String(value.align)) &&
      isOptionalString(value.fontFamily) &&
      isOptionalString(value.fontWeight, ["normal", "bold"]) &&
      isOptionalString(value.fontStyle, ["normal", "italic"]) &&
      isOptionalString(value.textDecoration, ["none", "underline"]) &&
      (value.backgroundColor === undefined || value.backgroundColor === null || isBoundedString(value.backgroundColor, 256)) &&
      (value.backgroundOpacity === undefined || isFiniteCoordinate(value.backgroundOpacity)) &&
      (value.lineHeight === undefined || (isFiniteCoordinate(value.lineHeight) && value.lineHeight > 0)) &&
      (value.rotation === undefined || isFiniteCoordinate(value.rotation))
    );
  }

  if (value.type === "image") {
    return (
      isFiniteCoordinate(value.x) &&
      isFiniteCoordinate(value.y) &&
      isFiniteCoordinate(value.w) && value.w > 0 &&
      isFiniteCoordinate(value.h) && value.h > 0 &&
      isFiniteCoordinate(value.rotation) &&
      isId(value.assetId)
    );
  }

  if (value.type === "shape") {
    return (
      ["line", "arrow", "rect", "ellipse"].includes(String(value.shape)) &&
      isFiniteCoordinate(value.x1) &&
      isFiniteCoordinate(value.y1) &&
      isFiniteCoordinate(value.x2) &&
      isFiniteCoordinate(value.y2) &&
      isBoundedString(value.color, 256) &&
      isFiniteCoordinate(value.width) && value.width > 0
    );
  }

  return false;
}

function randomToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function deepCloneObjects(objects: CanvasObject[]) {
  if (typeof structuredClone === "function") return structuredClone(objects);
  return JSON.parse(JSON.stringify(objects)) as CanvasObject[];
}

export function createNotesClipboardPayload(input: {
  sourceNotebookId: string;
  sourcePageId: string;
  objects: CanvasObject[];
}): NotesClipboardPayload {
  return {
    appId: APP_ID,
    kind: "notes-canvas-objects",
    version: NOTES_CLIPBOARD_VERSION,
    token: randomToken(),
    copiedAt: Date.now(),
    sourceNotebookId: input.sourceNotebookId,
    sourcePageId: input.sourcePageId,
    objects: deepCloneObjects(input.objects),
  };
}

export function serializeNotesClipboardPayload(payload: NotesClipboardPayload) {
  return JSON.stringify(payload);
}

export function parseNotesClipboardPayload(serialized: string): NotesClipboardPayload | null {
  if (!serialized || serialized.length > MAX_PAYLOAD_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      value.appId !== APP_ID ||
      value.kind !== "notes-canvas-objects" ||
      value.version !== NOTES_CLIPBOARD_VERSION ||
      !isId(value.token) ||
      !isTimestamp(value.copiedAt) ||
      !isId(value.sourceNotebookId) ||
      !isId(value.sourcePageId) ||
      !Array.isArray(value.objects) ||
      value.objects.length === 0 ||
      value.objects.length > MAX_OBJECTS ||
      !value.objects.every(isCanvasObject)
    ) return null;
    return value as unknown as NotesClipboardPayload;
  } catch {
    return null;
  }
}

export function notesClipboardPlainText(objects: CanvasObject[]) {
  return objects
    .filter((object): object is Extract<CanvasObject, { type: "text" }> => object.type === "text")
    .map((object) => object.text)
    .join("\n");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function notesClipboardHtml(serialized: string, plainText: string) {
  const marker = encodeURIComponent(serialized);
  return `<div ${HTML_MARKER_ATTRIBUTE}="${marker}" style="white-space: pre-wrap">${escapeHtml(plainText)}</div>`;
}

function clipboardSnapshot(payload: NotesClipboardPayload): ActiveClipboard | null {
  try {
    const serialized = serializeNotesClipboardPayload(payload);
    const verified = parseNotesClipboardPayload(serialized);
    if (!verified) return null;
    return {
      payload: verified,
      serialized,
      plainText: notesClipboardPlainText(verified.objects),
    };
  } catch {
    return null;
  }
}

function activateClipboard(snapshot: ActiveClipboard) {
  activeClipboard = {
    ...snapshot,
    payload: deepClonePayload(snapshot.payload),
  };
}

function trySetData(data: ClipboardWriter, type: string, value: string) {
  try {
    data.setData(type, value);
  } catch {
    return false;
  }

  const advertised = Array.from(data.types ?? []).some(
    (candidate) => candidate.toLowerCase() === type.toLowerCase(),
  );
  if (typeof data.getData !== "function") return advertised;
  try {
    const readback = data.getData(type);
    const matches = type === "text/plain"
      ? normalizeClipboardText(readback) === normalizeClipboardText(value)
      : readback === value;
    // Empty text cannot distinguish a successful write from a silent no-op;
    // require the flavor to be advertised as well.
    return matches && (value.length > 0 || advertised);
  } catch {
    return false;
  }
}

/**
 * Writes one snapshot to the real copy/cut event. The in-memory snapshot is
 * activated only after the OS clipboard carries a matching rich marker.
 */
export function writeNotesClipboardData(
  data: ClipboardWriter | null,
  payload: NotesClipboardPayload,
): NotesClipboardWriteStatus {
  if (!data) {
    activeClipboard = null;
    return "failed";
  }

  const snapshot = clipboardSnapshot(payload);
  if (!snapshot) {
    activeClipboard = null;
    return "failed";
  }
  const customWritten = trySetData(data, NOTES_CLIPBOARD_MIME, snapshot.serialized);
  const htmlWritten = trySetData(
    data,
    "text/html",
    notesClipboardHtml(snapshot.serialized, snapshot.plainText),
  );
  const textWritten = trySetData(data, "text/plain", snapshot.plainText);

  // The text flavor is also our freshness witness. If it was not committed,
  // a later paste cannot prove that the marker still belongs to the current
  // system clipboard, so Cut must not be allowed to delete its source.
  if ((customWritten || htmlWritten) && textWritten) {
    activateClipboard(snapshot);
    return "rich";
  }

  activeClipboard = null;
  return textWritten && snapshot.plainText.length > 0 ? "text-only" : "failed";
}

function deepClonePayload(payload: NotesClipboardPayload): NotesClipboardPayload {
  return { ...payload, objects: deepCloneObjects(payload.objects) };
}

function normalizeClipboardText(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function htmlPayload(html: string) {
  if (!html || html.length > MAX_PAYLOAD_LENGTH * 4) return "";
  const match = html.match(new RegExp(`${HTML_MARKER_ATTRIBUTE}=["']([^"']+)["']`, "i"));
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function tryGetData(data: ClipboardReader, type: string) {
  try {
    return data.getData(type) || "";
  } catch {
    return "";
  }
}

/**
 * A serialized object is trusted only when it exactly matches the snapshot
 * written by this running Notes session and its user-facing text flavor still
 * matches. This is what prevents an old in-memory image from replacing newer
 * external text.
 */
export function readNotesClipboardData(data: ClipboardReader | null): NotesClipboardPayload | null {
  if (!data || !activeClipboard) return null;

  const custom = tryGetData(data, NOTES_CLIPBOARD_MIME);
  const clipboardText = normalizeClipboardText(tryGetData(data, "text/plain"));
  if (clipboardText !== normalizeClipboardText(activeClipboard.plainText)) return null;

  // A WebView can preserve a stale custom flavor while accepting the newer
  // HTML fallback. Check both independently instead of letting custom MIME A
  // mask a valid HTML marker B.
  const candidates = [custom, htmlPayload(tryGetData(data, "text/html"))];
  for (const serialized of candidates) {
    if (!serialized || serialized !== activeClipboard.serialized) continue;
    const parsed = parseNotesClipboardPayload(serialized);
    if (parsed?.token === activeClipboard.payload.token) {
      return deepClonePayload(activeClipboard.payload);
    }
  }
  return null;
}

function uniqueImageFiles(data: ClipboardReader) {
  const files: File[] = [];
  const seen = new Set<File>();
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.toLowerCase().startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file && !seen.has(file)) {
      files.push(file);
      seen.add(file);
    }
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.toLowerCase().startsWith("image/") && !seen.has(file)) {
        files.push(file);
        seen.add(file);
      }
    }
  }
  return files;
}

export function canvasPasteSource(data: ClipboardReader | null): CanvasPasteSource {
  if (!data) return { kind: "none" };
  const notes = readNotesClipboardData(data);
  if (notes) return { kind: "notes", payload: notes };

  const files = uniqueImageFiles(data);
  if (files.length > 0) return { kind: "images", files };

  const text = tryGetData(data, "text/plain");
  return text.length > 0 ? { kind: "text", text } : { kind: "none" };
}

export function cloneNotesClipboardObjects(
  payload: NotesClipboardPayload,
  dx: number,
  dy: number,
) {
  return payload.objects.map((object) => cloneObject(object, dx, dy));
}

export function resetNotesClipboardForTests() {
  activeClipboard = null;
}
