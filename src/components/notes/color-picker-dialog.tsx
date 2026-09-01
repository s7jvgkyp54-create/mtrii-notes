import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const PRESET_COLORS = [
  "#2563eb", // blue-600
  "#0891b2", // cyan-600
  "#0d9488", // teal-600
  "#16a34a", // green-600
  "#84cc16", // lime-500
  "#eab308", // yellow-500
  "#f59e0b", // amber-500
  "#ea580c", // orange-600
  "#dc2626", // red-600
  "#db2777", // pink-600
  "#9333ea", // purple-600
  "#4f46e5", // indigo-600
  "#475569", // slate-600
  "#000000", // black
];

interface ColorPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialColor?: string;
  onSelect: (color: string) => void;
}

export function ColorPickerDialog({
  open,
  onOpenChange,
  title,
  initialColor = "#2563eb",
  onSelect,
}: ColorPickerDialogProps) {
  const [color, setColor] = useState(initialColor);

  useEffect(() => {
    if (open) setColor(initialColor);
  }, [open, initialColor]);

  const handleSave = () => {
    onSelect(color);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <div className="mt-4 flex flex-col gap-5">
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={cn(
                "size-8 rounded-full border-2 transition-transform cursor-pointer hover:scale-110",
                color.toLowerCase() === c.toLowerCase()
                  ? "border-accent ring-2 ring-accent ring-offset-2 ring-offset-bg"
                  : "border-transparent",
              )}
              style={{ backgroundColor: c }}
              aria-label={`Chọn màu ${c}`}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="size-10 cursor-pointer p-1"
          />
          <Input
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="flex-1 uppercase font-mono text-sm"
            placeholder="#HEXCODE"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button onClick={handleSave}>Lưu</Button>
        </div>
      </div>
    </Dialog>
  );
}
