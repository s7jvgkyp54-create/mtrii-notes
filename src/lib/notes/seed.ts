import { nid } from "@/lib/utils";
import type { CanvasObject, Folder, Notebook, PageRecord, PaperStyle } from "./types";
import { DEFAULT_PAPER, pageDimensions } from "./types";
import { putAsset, putFolder, putNotebook, putObjects, putPage } from "./db";

const lined: PaperStyle = { pattern: "lined", color: "#FFFEFB", lineColor: "#D6D3CD" };
const dots: PaperStyle = { pattern: "dots", color: "#FBF3E3", lineColor: "#D9D3C7" };

function now() {
  return Date.now();
}

export async function seedLibrary() {
  const t = now();
  const root: Folder = {
    id: nid(),
    parentId: null,
    name: "Học tập",
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
  };
  await putFolder(root);

  const guideId = nid();
  const dim = pageDimensions("a4", "portrait");
  const p1: PageRecord = {
    id: nid(),
    notebookId: guideId,
    index: 0,
    paper: DEFAULT_PAPER,
    rotation: 0,
    width: dim.width,
    height: dim.height,
    pdfPage: null,
    createdAt: t,
    updatedAt: t,
  };
  const p2: PageRecord = {
    ...p1,
    id: nid(),
    index: 1,
    paper: lined,
  };

  const title: CanvasObject = {
    id: nid(),
    type: "text",
    x: 72,
    y: 64,
    w: 450,
    h: 48,
    text: "Chào mừng đến với Sổ Tay",
    fontSize: 26,
    color: "#1C1917",
    align: "left",
  };
  const body: CanvasObject = {
    id: nid(),
    type: "text",
    x: 72,
    y: 130,
    w: 450,
    h: 220,
    text: "Sổ tay số của bạn — viết, nhập PDF, đánh dấu và xuất lại.\n\n• Bút bi / bút máy / bút chì / bút đánh dấu\n• Tẩy cả nét hoặc một phần nét\n• Lasso để di chuyển, xoay, đổi màu\n• Hộp chữ tiếng Việt, chèn ảnh, hình vẽ\n• Dữ liệu lưu trên máy (trình duyệt), không cần đăng nhập",
    fontSize: 13,
    color: "#44403C",
    align: "left",
  };
  const underline: CanvasObject = {
    id: nid(),
    type: "stroke",
    tool: "fountain",
    color: "#0F766E",
    width: 2.4,
    points: Array.from({ length: 28 }, (_, i) => ({
      x: 72 + i * 11,
      y: 108 + Math.sin(i / 6) * 1.2,
      p: 0.55 + (i % 5) * 0.06,
    })),
  };
  const hi: CanvasObject = {
    id: nid(),
    type: "stroke",
    tool: "highlighter",
    color: "#FACC15",
    width: 16,
    points: [
      { x: 70, y: 196, p: 0.5 },
      { x: 280, y: 196, p: 0.5 },
    ],
  };

  const p2text: CanvasObject = {
    id: nid(),
    type: "text",
    x: 80,
    y: 56,
    w: 430,
    h: 280,
    text: "PDF và sao lưu\n\nNhập PDF bằng nút Nhập trên thư viện hoặc kéo thả tệp. Nét viết gắn theo tọa độ trang nên không lệch khi thu phóng.\n\nXuất PDF để đọc ở phần mềm khác (đã gộp ghi chú). Xuất .notesbackup để chuyển máy — giữ nét chỉnh sửa được, ảnh và PDF gốc.\n\nCtrl+Z hoàn tác · Ctrl+Y làm lại · Space+kéo để pan.",
    fontSize: 13,
    color: "#1C1917",
    align: "left",
  };

  const guide: Notebook = {
    id: guideId,
    folderId: null,
    name: "Hướng dẫn sử dụng Sổ Tay",
    favorite: true,
    cover: { color: "#0F766E" },
    defaultPaper: DEFAULT_PAPER,
    pageSize: "a4",
    orientation: "portrait",
    pdfAssetId: null,
    thumbnail: null,
    pageCount: 2,
    createdAt: t,
    updatedAt: t,
    lastOpenedAt: t,
    lastPageIndex: 0,
    lastZoom: 1,
    deletedAt: null,
  };

  await putNotebook(guide);
  await putPage(p1);
  await putPage(p2);
  await putObjects(p1.id, [hi, underline, title, body]);
  await putObjects(p2.id, [p2text]);

  const journalId = nid();
  const jdim = pageDimensions("a5", "portrait");
  const journal: Notebook = {
    id: journalId,
    folderId: root.id,
    name: "Sổ tay",
    favorite: false,
    cover: { color: "#1E3A5F" },
    defaultPaper: lined,
    pageSize: "a5",
    orientation: "portrait",
    pdfAssetId: null,
    thumbnail: null,
    pageCount: 3,
    createdAt: t - 3600_000,
    updatedAt: t - 3600_000,
    lastOpenedAt: null,
    lastPageIndex: 0,
    lastZoom: 1.1,
    deletedAt: null,
  };
  await putNotebook(journal);
  for (let i = 0; i < 3; i++) {
    const page: PageRecord = {
      id: nid(),
      notebookId: journalId,
      index: i,
      paper: i === 2 ? dots : lined,
      rotation: 0,
      width: jdim.width,
      height: jdim.height,
      pdfPage: null,
      createdAt: t,
      updatedAt: t,
    };
    await putPage(page);
    await putObjects(page.id, []);
  }

  // Sample PDF is optional and can be slow (fontkit). Don't block first paint.
  void seedSamplePdf().catch(() => undefined);
}

async function seedSamplePdf() {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const { default: fontkit } = await import("@pdf-lib/fontkit");
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  let font;
  try {
    const res = await fetch("/fonts/BeVietnamPro-Regular.ttf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    font = await pdf.embedFont(bytes, { subset: true });
  } catch {
    return;
  }
  const ink = rgb(0.11, 0.1, 0.09);
  const mute = rgb(0.35, 0.32, 0.28);
  const teal = rgb(0.06, 0.46, 0.43);

  const p1 = pdf.addPage([595.28, 841.89]);
  p1.drawText("Tài liệu mẫu", { font, size: 28, x: 72, y: 760, color: teal });
  p1.drawText("Sổ Tay — nhập PDF và viết lên trên", { font, size: 12, x: 72, y: 728, color: mute });
  const para = [
    "Đây là trang PDF vector, không phải ảnh chụp. Hãy dùng bút đánh dấu",
    "để tô câu này, thêm hộp chữ tiếng Việt, hoặc viết ghi chú bên lề.",
    "",
    "Nét viết được lưu theo tọa độ trang. Thu phóng, cuộn, xoay trang",
    "không làm lệch ghi chú so với nội dung gốc.",
    "",
    "Xuất PDF sẽ gộp lớp ghi chú. Muốn sửa từng nét sau này, hãy xuất",
    "bản sao .notesbackup chứ không chỉ file PDF đã gộp.",
  ];
  para.forEach((line, i) => {
    p1.drawText(line, { font, size: 13, x: 72, y: 660 - i * 22, color: ink });
  });

  const p2 = pdf.addPage([595.28, 841.89]);
  p2.drawText("Mục cần ôn", { font, size: 22, x: 72, y: 760, color: teal });
  ["Định lý Pythagoras", "Hàm số bậc hai", "Văn nghị luận — lập luận", "Từ vựng học kỳ 1"].forEach(
    (item, i) => {
      p2.drawText(`${i + 1}.  ${item}`, { font, size: 14, x: 88, y: 700 - i * 36, color: ink });
    },
  );

  const bytes = await pdf.save();
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
  const assetId = nid();
  const t = now();
  await putAsset({
    id: assetId,
    kind: "pdf",
    mime: "application/pdf",
    name: "tai-lieu-mau.pdf",
    byteLength: blob.size,
    blob,
    createdAt: t,
  });

  const nbId = nid();
  const nb: Notebook = {
    id: nbId,
    folderId: null,
    name: "Tài liệu mẫu PDF",
    favorite: false,
    cover: { color: "#9A3412" },
    defaultPaper: DEFAULT_PAPER,
    pageSize: "a4",
    orientation: "portrait",
    pdfAssetId: assetId,
    thumbnail: null,
    pageCount: 2,
    createdAt: t,
    updatedAt: t,
    lastOpenedAt: null,
    lastPageIndex: 0,
    lastZoom: 1,
    deletedAt: null,
  };
  await putNotebook(nb);
  for (let i = 0; i < 2; i++) {
    const page: PageRecord = {
      id: nid(),
      notebookId: nbId,
      index: i,
      paper: DEFAULT_PAPER,
      rotation: 0,
      width: 595.28,
      height: 841.89,
      pdfPage: i + 1,
      createdAt: t,
      updatedAt: t,
    };
    await putPage(page);
    await putObjects(page.id, []);
  }
}
