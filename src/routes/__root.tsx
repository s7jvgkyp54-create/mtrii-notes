import { createRootRoute, HeadContent, Outlet, Scripts, useNavigate } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { Toaster } from "@/components/ui/sonner";
import { AppBoot } from "@/components/notes/app-boot";
import { NotesNavigationProvider, type NotesDestination } from "@/lib/notes/navigation";
import appCss from "../styles.css?url";

const APP_NAME = "Mtrii Notes";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "theme-color", content: "#0F766E" },
      { name: "description", content: "Sổ tay số Mtrii Notes — viết, nhập PDF, lưu trên máy." },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  const routerNavigate = useNavigate();
  const navigate = (destination: NotesDestination) => routerNavigate(destination);

  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <PreviewHostBridge />
        <AuthProvider>
          <AppBoot>
            <NotesNavigationProvider navigate={navigate}>
              <Outlet />
            </NotesNavigationProvider>
          </AppBoot>
        </AuthProvider>
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}
