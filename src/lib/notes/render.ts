import type { CanvasObject, PaperStyle, ShapeObject, StrokeObject } from "./types";

export function drawPaper(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  paper: PaperStyle,
) {
  ctx.fillStyle = paper.color;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.strokeStyle = paper.lineColor;
  ctx.fillStyle = paper.lineColor;
  ctx.lineWidth = 0.55;
  const inset = 36;

  if (paper.pattern === "lined") {
    ctx.save();
    ctx.strokeStyle = "#D9A3A3";
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(64, 0);
    ctx.lineTo(64, h);
    ctx.stroke();
    ctx.restore();
    const gap = 28;
    for (let y = 56; y < h - 28; y += gap) {
      ctx.beginPath();
      ctx.moveTo(inset, y);
      ctx.lineTo(w - 24, y);
      ctx.stroke();
    }
  } else if (paper.pattern === "grid") {
    const gap = 22;
    for (let x = inset; x < w - 16; x += gap) {
      ctx.beginPath();
      ctx.moveTo(x, 24);
      ctx.lineTo(x, h - 24);
      ctx.stroke();
    }
    for (let y = 24; y < h - 16; y += gap) {
      ctx.beginPath();
      ctx.moveTo(inset, y);
      ctx.lineTo(w - 24, y);
      ctx.stroke();
    }
  } else if (paper.pattern === "dots") {
    const gap = 22;
    for (let y = 28; y < h - 16; y += gap) {
      for (let x = inset; x < w - 16; x += gap) {
        ctx.beginPath();
        ctx.arc(x, y, 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (paper.pattern === "cornell") {
    ctx.beginPath();
    ctx.moveTo(w * 0.28, 36);
    ctx.lineTo(w * 0.28, h * 0.78);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(28, h * 0.78);
    ctx.lineTo(w - 24, h * 0.78);
    ctx.stroke();
    const gap = 26;
    for (let y = 56; y < h * 0.78 - 8; y += gap) {
      ctx.beginPath();
      ctx.moveTo(w * 0.28 + 12, y);
      ctx.lineTo(w - 24, y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function strokePath(ctx: CanvasRenderingContext2D, pts: StrokeObject["points"]) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1]!.x, pts[1]!.y);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
      const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
      ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
    }
    const last = pts[pts.length - 1]!;
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeObject) {
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  if (s.tool === "highlighter") {
    ctx.globalAlpha = 0.38;
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    strokePath(ctx, pts);
    ctx.restore();
    return;
  }
  if (s.tool === "pencil") {
    ctx.globalAlpha = 0.78;
    ctx.strokeStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = s.width;
    strokePath(ctx, pts);
    ctx.restore();
    return;
  }
  if (s.tool === "fountain") {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0]!.x, pts[0]!.y, (s.width * (0.4 + pts[0]!.p * 0.75)) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        ctx.beginPath();
        ctx.lineWidth = s.width * (0.32 + ((a.p + b.p) / 2) * 0.95);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = s.width;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0]!.x, pts[0]!.y, s.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    strokePath(ctx, pts);
  }
  ctx.restore();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(10, width * 3.2);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(ang - 0.4), y2 - len * Math.sin(ang - 0.4));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(ang + 0.4), y2 - len * Math.sin(ang + 0.4));
  ctx.stroke();
}

export function drawShape(ctx: CanvasRenderingContext2D, s: ShapeObject) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.shape === "line" || s.shape === "arrow") {
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    if (s.shape === "arrow") drawArrowHead(ctx, s.x1, s.y1, s.x2, s.y2, s.width);
  } else if (s.shape === "rect") {
    ctx.strokeRect(
      Math.min(s.x1, s.x2),
      Math.min(s.y1, s.y2),
      Math.abs(s.x2 - s.x1),
      Math.abs(s.y2 - s.y1),
    );
  } else {
    const x = Math.min(s.x1, s.x2);
    const y = Math.min(s.y1, s.y2);
    const w = Math.abs(s.x2 - s.x1);
    const h = Math.abs(s.y2 - s.y1);
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2 || 0.5, h / 2 || 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawText(ctx: CanvasRenderingContext2D, t: Extract<CanvasObject, { type: "text" }>) {
  ctx.save();
  ctx.fillStyle = t.color;
  ctx.font = `${t.fontSize}px "Be Vietnam Pro", "Segoe UI", sans-serif`;
  ctx.textAlign = t.align;
  ctx.textBaseline = "top";
  const x = t.align === "center" ? t.x + t.w / 2 : t.align === "right" ? t.x + t.w : t.x;
  const lines = t.text.split("\n");
  const lh = t.fontSize * 1.35;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, t.y + i * lh, t.w);
  });
  ctx.restore();
}

export function drawLasso(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = "#0F766E";
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = "rgba(15,118,110,0.08)";
  ctx.fill();
  ctx.restore();
}

export function strokeToSvgPath(s: StrokeObject) {
  const pts = s.points;
  if (!pts.length) return "";
  let d = `M ${pts[0]!.x.toFixed(2)} ${pts[0]!.y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i]!.x.toFixed(2)} ${pts[i]!.y.toFixed(2)}`;
  }
  return d;
}
