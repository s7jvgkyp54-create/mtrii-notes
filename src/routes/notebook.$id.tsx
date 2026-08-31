import { createFileRoute } from "@tanstack/react-router";
import { EditorView } from "@/components/notes/editor-view";

export const Route = createFileRoute("/notebook/$id")({ component: NotebookPage });

function NotebookPage() {
  const { id } = Route.useParams();
  return <EditorView notebookId={id} />;
}
