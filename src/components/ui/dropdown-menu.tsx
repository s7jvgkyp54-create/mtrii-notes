import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DropdownMenu({
  trigger,
  children,
}: {
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          sideOffset={6}
          className="app-menu-content z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-surface-2 p-1 text-sm text-fg shadow-[var(--shadow-soft)]"
        >
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Dropdown.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 outline-none data-[highlighted]:bg-overlay data-[disabled]:pointer-events-none",
        danger && "text-danger",
        disabled && "opacity-40",
      )}
    >
      {children}
    </Dropdown.Item>
  );
}

export function MenuSep() {
  return <Dropdown.Separator className="my-1 h-px bg-border" />;
}
