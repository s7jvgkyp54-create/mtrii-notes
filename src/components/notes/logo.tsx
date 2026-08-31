import { cn } from "@/lib/utils";

export function MtriiMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect x="5" y="6" width="20" height="22" rx="2.5" fill="currentColor" opacity="0.12" />
      <rect x="8" y="4" width="19" height="22" rx="2.5" fill="var(--accent)" />
      <rect x="8" y="4" width="3" height="22" rx="1" fill="black" opacity="0.18" />
      <path
        d="M13 11.2v9.2M13 11.2c1.7 2.8 3.4 2.8 5.1 0 1.7 2.8 3.4 2.8 5.1 0v9.2"
        fill="none"
        stroke="white"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="23.5" y="4" width="3.5" height="9" rx="0.8" fill="#E8E2D6" />
    </svg>
  );
}

export function Splash() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-bg text-fg">
      <MtriiMark className="size-14" />
      <div className="text-center">
        <p className="text-lg font-semibold tracking-tight">Mtrii Notes</p>
        <p className="mt-1 text-sm text-muted">Đang mở sổ…</p>
      </div>
    </div>
  );
}
