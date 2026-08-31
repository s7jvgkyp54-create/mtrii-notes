import { createFileRoute } from "@tanstack/react-router";
import { SettingsView } from "@/components/notes/settings-view";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  return <SettingsView />;
}
