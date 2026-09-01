import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, Image as ImageIcon, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

interface RasterPdfExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (options: { dpi: 150 | 200 | 300 }) => void;
  isExporting: boolean;
}

export function RasterPdfExportDialog({
  open,
  onOpenChange,
  onConfirm,
  isExporting,
}: RasterPdfExportDialogProps) {
  const [dpi, setDpi] = useState<150 | 200 | 300>(200);

  return (
    <Dialog open={open} onOpenChange={isExporting ? () => {} : onOpenChange} title="Xuất PDF dạng ảnh phẳng">
      <div className="mt-2 flex flex-col gap-4">
        <p className="text-sm text-muted">
          Ảnh phẳng kết hợp trang PDF gốc và toàn bộ ghi chú thành ảnh. Tuy dung lượng file sẽ lớn hơn nhưng có khả năng tương thích cao nhất trên mọi thiết bị.
        </p>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => setDpi(150)}
            disabled={isExporting}
            className={cn(
              "flex items-center gap-3 rounded-md border p-3 text-left transition-colors cursor-pointer",
              dpi === 150 ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-surface-2",
              isExporting && "opacity-50 cursor-not-allowed",
            )}
          >
            <div className="flex-1">
              <p className="text-sm font-medium">Tiết kiệm (150 DPI)</p>
              <p className="text-xs opacity-80">Dung lượng nhẹ, tốc độ xuất nhanh</p>
            </div>
            {dpi === 150 && <Check className="size-5" />}
          </button>

          <button
            onClick={() => setDpi(200)}
            disabled={isExporting}
            className={cn(
              "flex items-center gap-3 rounded-md border p-3 text-left transition-colors cursor-pointer",
              dpi === 200 ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-surface-2",
              isExporting && "opacity-50 cursor-not-allowed",
            )}
          >
            <div className="flex-1">
              <p className="text-sm font-medium">Tiêu chuẩn (200 DPI)</p>
              <p className="text-xs opacity-80">Cân bằng giữa chất lượng và dung lượng</p>
            </div>
            {dpi === 200 && <Check className="size-5" />}
          </button>

          <button
            onClick={() => setDpi(300)}
            disabled={isExporting}
            className={cn(
              "flex items-center gap-3 rounded-md border p-3 text-left transition-colors cursor-pointer",
              dpi === 300 ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-surface-2",
              isExporting && "opacity-50 cursor-not-allowed",
            )}
          >
            <div className="flex-1">
              <p className="text-sm font-medium">Chất lượng cao (300 DPI)</p>
              <p className="text-xs opacity-80">Rõ nét để in ấn, dung lượng file rất lớn</p>
            </div>
            {dpi === 300 && <Check className="size-5" />}
          </button>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isExporting}>
            Hủy
          </Button>
          <Button onClick={() => onConfirm({ dpi })} disabled={isExporting}>
            {isExporting ? "Đang xuất..." : "Bắt đầu xuất"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
