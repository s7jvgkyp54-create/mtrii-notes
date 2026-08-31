import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      theme="system"
      position="bottom-right"
      toastOptions={{
        className: "font-sans",
      }}
    />
  );
}
