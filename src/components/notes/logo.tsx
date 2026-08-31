import { cn } from "@/lib/utils";

export function NotesMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect x="5" y="6" width="20" height="22" rx="3" fill="currentColor" opacity="0.12" />
      <rect x="7" y="4" width="20" height="23" rx="3" fill="var(--accent)" />
      <rect x="7" y="4" width="3.5" height="23" rx="1" fill="black" opacity="0.2" />
      <path
        d="M14 11h8M14 15h8M14 19h5"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="22.5" y="3.5" width="3" height="8" rx="0.8" fill="#F3EFE6" />
    </svg>
  );
}

export const MtriiMark = NotesMark;

export function Splash() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-bg text-fg">
      <NotesMark className="size-14" />
      <div className="text-center">
        <p className="text-lg font-semibold tracking-tight">Notes</p>
        <p className="mt-1 text-sm text-muted">Đang mở sổ…</p>
      </div>
    </div>
  );
}