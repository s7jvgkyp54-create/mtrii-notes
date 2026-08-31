import { createFileRoute } from "@tanstack/react-router";
import { LibraryView } from "@/components/notes/library-view";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <LibraryView />;
}
