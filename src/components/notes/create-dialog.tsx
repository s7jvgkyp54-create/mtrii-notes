import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COVER_COLORS, DEFAULT_PAPER, PAPER_COLORS, type PaperPattern, type PageSizeName } from "@/lib/notes/types";
import { cn, contrastInk } from "@/lib/utils";

const PATTERNS: { id: PaperPattern; label: string }[] = [
  { id: "blank", label: "Trắng" },
  { id: "lined", label: "Kẻ dòng" },
  { id: "grid", label: "Ô vuông" },
  { id: "dots", label: "Chấm" },
  { id: "cornell", label: "Cornell" },
];

export function CreateNotebookDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (v: {
    name: string;
    cover: string;
    paper: typeof DEFAULT_PAPER;
    pageSize: PageSizeName;
    orientation: "portrait" | "landscape";
  }) => void;
}) {
  const [name, setName] = useState("Sổ không tên");
  const [cover, setCover] = useState(COVER_COLORS[0]!);
  const [pattern, setPattern] = useState<PaperPattern>("lined");
  const [paperColor, setPaperColor] = useState(PAPER_COLORS[0]!.color);
  const [size, setSize] = useState<PageSizeName>("a4");
  const [ori, setOri] = useState<"portrait" | "landscape">("portrait");

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Tạo sổ mới" description="Chọn bìa, khổ giấy và mẫu trang.">
      <div className="flex flex-col gap-4">
        <label className="text-sm font-medium">
          Tên sổ
          <Input className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <p className="mb-2 text-sm font-medium">Bìa</p>
          <div className="flex flex-wrap gap-2">
            {COVER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => setCover(c)}
                className={cn(
                  "size-8 rounded-full border-2",
                  cover === c ? "border-fg" : "border-transparent",
                )}
                style={{ background: c, color: contrastInk(c) }}
              />
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Mẫu giấy</p>
          <div className="flex flex-wrap gap-1.5">
            {PATTERNS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPattern(p.id)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-medium",
                  pattern === p.id ? "bg-accent text-accent-fg" : "bg-overlay text-fg",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            {PAPER_COLORS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-label={p.label}
                onClick={() => setPaperColor(p.color)}
                className={cn("size-6 rounded-full border", paperColor === p.color ? "border-fg" : "border-border")}
                style={{ background: p.color }}
              />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm font-medium">
            Khổ
            <select
              className="mt-1.5 h-10 w-full rounded-md border border-border bg-surface-2 px-2 text-sm"
              value={size}
              onChange={(e) => setSize(e.target.value as PageSizeName)}
            >
              <option value="a4">A4</option>
              <option value="a5">A5</option>
              <option value="letter">Letter</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Hướng
            <select
              className="mt-1.5 h-10 w-full rounded-md border border-border bg-surface-2 px-2 text-sm"
              value={ori}
              onChange={(e) => setOri(e.target.value as "portrait" | "landscape")}
            >
              <option value="portrait">Dọc</option>
              <option value="landscape">Ngang</option>
            </select>
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button
            onClick={() => {
              onCreate({
                name: name.trim() || "Sổ không tên",
                cover,
                paper: { pattern, color: paperColor, lineColor: "#D6D3CD" },
                pageSize: size,
                orientation: ori,
              });
              onOpenChange(false);
            }}
          >
            Tạo sổ
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
