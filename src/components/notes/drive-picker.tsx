import { useEffect, useState } from "react";
import { GOOGLE_CLIENT_ID, GOOGLE_API_KEY } from "@/lib/notes/types";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

export function DrivePicker({
  open,
  accessToken,
  onClose,
  onPick,
}: {
  open: boolean;
  accessToken: string | null;
  onClose: () => void;
  onPick: (file: { id: string; name: string; mimeType: string }) => void;
}) {
  const [pickerInited, setPickerInited] = useState(false);

  useEffect(() => {
    if (!open || !accessToken) return;
    
    if (GOOGLE_CLIENT_ID === "YOUR_CLIENT_ID_HERE" || GOOGLE_API_KEY === "YOUR_API_KEY_HERE") {
      toast.error("Vui lòng cấu hình API Key và Client ID trong mã nguồn!");
      onClose();
      return;
    }

    const scriptId = "google-picker-script";
    
    const createPicker = () => {
      const google = window.google;
      if (!google || !google.picker) return;

      const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
      view.setIncludeFolders(true);
      view.setMimeTypes("application/pdf,image/png,image/jpeg,image/webp");

      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(GOOGLE_API_KEY)
        .setCallback((data: any) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs[0];
            onPick({
              id: doc.id,
              name: doc.name,
              mimeType: doc.mimeType,
            });
          } else if (data.action === google.picker.Action.CANCEL) {
            onClose();
          }
        })
        .build();

      picker.setVisible(true);
      // Hack to fix picker z-index over Tauri
      setTimeout(() => {
        const dialogs = document.querySelectorAll('.picker-dialog');
        dialogs.forEach((d: any) => d.style.zIndex = '9999');
        const bgs = document.querySelectorAll('.picker-dialog-bg');
        bgs.forEach((b: any) => b.style.zIndex = '9998');
      }, 100);
    };

    if (window.gapi && window.google?.picker) {
      createPicker();
    } else {
      if (!document.getElementById(scriptId)) {
        const script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://apis.google.com/js/api.js";
        script.onload = () => {
          window.gapi.load('picker', { callback: createPicker });
        };
        document.body.appendChild(script);
      } else {
        window.gapi.load('picker', { callback: createPicker });
      }
    }
  }, [open, accessToken]);

  if (!open) return null;

  if (!accessToken) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/50 backdrop-blur-sm">
        <div className="flex flex-col items-center gap-4 rounded-xl bg-surface p-6 shadow-xl">
          <p className="text-sm font-medium text-danger">Chưa kết nối Google Drive</p>
          <p className="text-xs text-muted">Vui lòng vào phần Cài đặt để đăng nhập trước.</p>
          <button onClick={onClose} className="mt-2 rounded bg-accent px-4 py-2 text-sm text-accent-fg">Đóng</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/50 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-xl bg-surface p-6 shadow-xl">
        <Loader2 className="size-8 animate-spin text-accent" />
        <p className="text-sm font-medium">Đang mở Google Picker...</p>
        <button onClick={onClose} className="mt-2 text-xs text-muted hover:underline">Hủy</button>
      </div>
    </div>
  );
}
