import { Star } from "lucide-react";
import { cn, contrastInk } from "@/lib/utils";
import type { Notebook } from "@/lib/notes/types";

export function NotebookCover({
  notebook,
  className,
}: {
  notebook: Notebook;
  className?: string;
}) {
  const ink = contrastInk(notebook.cover.color);
  return (
    <div className={cn("aspect-notebook relative w-full", className)}>
      <div className="absolute inset-y-1 right-0 w-1.5 rounded-r-sm bg-paper" />
      <div className="absolute inset-y-0.5 right-1 w-1 bg-paper/90" />
      <div
        className="notebook-cover absolute inset-0 mr-2 overflow-hidden rounded-sm rounded-r-md"
        style={{ background: notebook.cover.color }}
      >
        <div className="absolute inset-y-0 left-0 w-2 bg-black/20" />
        <div className="absolute inset-x-0 top-0 h-1/4 bg-white/10" />
        {notebook.pdfAssetId ? (
          <span
            className="absolute top-3 right-3 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
            style={{ background: "color-mix(in oklab, white 22%, transparent)", color: ink }}
          >
            PDF
          </span>
        ) : null}
        {notebook.favorite ? (
          <Star className="absolute top-3 left-4 size-3.5 fill-current" style={{ color: ink }} />
        ) : null}
        <p
          className="absolute right-3 bottom-6 left-4 line-clamp-3 text-sm font-semibold leading-snug"
          style={{ color: ink }}
        >
          {notebook.name}
        </p>
      </div>
    </div>
  );
}
