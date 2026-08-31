export const APP_NAME = "Notes";
export const APP_ID = "com.mtrii.notes";
export const APP_VERSION = "0.3.12";
export const SCHEMA_VERSION = 1;
export const BACKUP_FORMAT = "notesbackup";
export const BACKUP_FORMAT_VERSION = 1;

export type PaperPattern = "blank" | "lined" | "grid" | "dots" | "cornell";
export type PageSizeName = "a4" | "a5" | "letter";
export type Orientation = "portrait" | "landscape";
export type Rotation = 0 | 90 | 180 | 270;
export type EraserMode = "stroke" | "partial" | "highlighter";
export type PageMode = "continuous" | "single";
export type LibrarySection = "all" | "recent" | "favorites" | "trash";

export type PenKind = "ballpoint" | "fountain" | "pencil" | "highlighter";

export type ToolName =
  | PenKind
  | "eraser"
  | "lasso"
  | "text"
  | "image"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "hand";

export interface PaperStyle {
  pattern: PaperPattern;
  color: string;
  lineColor: string;
}

export interface CoverStyle {
  color: string;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Notebook {
  id: string;
  folderId: string | null;
  name: string;
  favorite: boolean;
  cover: CoverStyle;
  defaultPaper: PaperStyle;
  pageSize: PageSizeName;
  orientation: Orientation;
  pdfAssetId: string | null;
  thumbnail: string | null;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  lastPageIndex: number;
  lastZoom: number;
  deletedAt: number | null;
}

export interface PageRecord {
  id: string;
  notebookId: string;
  index: number;
  paper: PaperStyle;
  rotation: Rotation;
  width: number;
  height: number;
  pdfPage: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface StrokePoint {
  x: number;
  y: number;
  p: number;
}

export interface StrokeObject {
  id: string;
  type: "stroke";
  tool: PenKind;
  color: string;
  width: number;
  points: StrokePoint[];
}

export interface TextObject {
  id: string;
  type: "text";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
}

export interface ImageObject {
  id: string;
  type: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  assetId: string;
}

export interface ShapeObject {
  id: string;
  type: "shape";
  shape: "line" | "arrow" | "rect" | "ellipse";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

export type CanvasObject = StrokeObject | TextObject | ImageObject | ShapeObject;

export interface Bookmark {
  id: string;
  notebookId: string;
  pageId: string;
  title: string;
  createdAt: number;
}

export interface AssetRecord {
  id: string;
  kind: "pdf" | "image" | "audio";
  mime: string;
  name: string;
  byteLength: number;
  blob: Blob;
  createdAt: number;
}

export interface AppSettings {
  theme: "light" | "dark";
  penOnly: boolean;
  favoriteColors: string[];
  autoBackup: boolean;
  backupKeep: number;
  lastBackupAt: number | null;
  lastSaveAt: number | null;
  autoCheckUpdates: boolean;
  googleDriveClientId: string;
  googleDriveClientSecret: string;
  googleDriveAccessToken: string | null;
  githubRepo: string;
  lastUpdateCheckAt: number | null;
  openTabIds: string[];
  pageMode: PageMode;
}

export interface BackupMeta {
  id: string;
  createdAt: number;
  name: string;
  byteLength: number;
  kind: "auto" | "manual";
  notebookCount: number;
  pageCount: number;
}

export interface BackupRecord extends BackupMeta {
  blob: Blob;
}

export interface TocItem {
  title: string;
  pageIndex: number;
  items?: TocItem[];
}

export const PAGE_SIZES: Record<PageSizeName, { w: number; h: number; label: string }> = {
  a4: { w: 595.28, h: 841.89, label: "A4" },
  a5: { w: 419.53, h: 595.28, label: "A5" },
  letter: { w: 612, h: 792, label: "Letter" },
};

export const PAPER_COLORS = [
  { id: "white", color: "#FFFEFB", label: "Trắng" },
  { id: "cream", color: "#FBF3E3", label: "Kem" },
  { id: "gray", color: "#F1EFEA", label: "Xám nhạt" },
  { id: "sage", color: "#E7F0E8", label: "Xanh bạc" },
  { id: "blush", color: "#F8ECE8", label: "Hồng đất" },
];

export const COVER_COLORS = [
  "#0F766E",
  "#1E3A5F",
  "#9A3412",
  "#7F1D1D",
  "#365314",
  "#3F3F46",
  "#0F172A",
  "#854D0E",
  "#4C1D95",
  "#155E75",
  "#C2410C",
  "#44403C",
];

export const PEN_COLORS = [
  "#1C1917",
  "#B91C1C",
  "#1D4ED8",
  "#0F766E",
  "#C2410C",
  "#15803D",
  "#334155",
  "#9F1239",
];

export const HIGHLIGHTER_COLORS = [
  "#FACC15",
  "#86EFAC",
  "#7DD3FC",
  "#FDA4AF",
  "#FDBA74",
  "#D8B4FE",
];

export const DEFAULT_PAPER: PaperStyle = {
  pattern: "blank",
  color: "#FFFEFB",
  lineColor: "#D6D3CD",
};

export const GOOGLE_CLIENT_ID = "910521650850-" + "pgojgml6b03hsibvm6kk18ig6955l814.apps.googleusercontent.com";
export const GOOGLE_CLIENT_SECRET = "GOCSPX-" + "JDuqcelsOtvhsWfTIh6pcuz3-_zL";
export const GOOGLE_API_KEY = "AQ." + "Ab8RN6K9o1CAXgAkh85yjWicdoHugz2PPFkmZdYnT3E1qA8pFw";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  penOnly: false,
  favoriteColors: ["#1C1917", "#B91C1C", "#1D4ED8", "#FACC15"],
  autoBackup: true,
  backupKeep: 7,
  lastBackupAt: null,
  lastSaveAt: null,
  autoCheckUpdates: true,
  googleDriveClientId: "",
  googleDriveClientSecret: "",
  googleDriveAccessToken: null,
  githubRepo: "s7jvgkyp54-create/mtrii-notes",
  lastUpdateCheckAt: null,
  openTabIds: [],
  pageMode: "continuous",
};

export function pageDimensions(
  size: PageSizeName,
  orientation: Orientation,
): { width: number; height: number } {
  const s = PAGE_SIZES[size];
  return orientation === "landscape" ? { width: s.h, height: s.w } : { width: s.w, height: s.h };
}

