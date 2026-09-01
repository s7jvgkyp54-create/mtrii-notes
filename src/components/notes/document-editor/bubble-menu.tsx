import React from "react";
import { type Editor } from "@tiptap/react";
import { BubbleMenu as TiptapBubbleMenu } from "@tiptap/react/menus";
import { Bold, Italic, Strikethrough, Heading1, Heading2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface BubbleMenuProps {
  editor: Editor | null;
}

export const BubbleMenu: React.FC<BubbleMenuProps> = ({ editor }) => {
  if (!editor) return null;

  return (
    <TiptapBubbleMenu
      editor={editor}
      className="flex items-center gap-1 bg-surface-2 border shadow-md rounded-lg p-1 overflow-hidden"
    >
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={cn(
          "p-1.5 rounded-md hover:bg-overlay transition-colors",
          editor.isActive("bold") ? "text-accent bg-accent-soft" : "text-muted-foreground"
        )}
        title="Bold"
      >
        <Bold className="w-4 h-4" />
      </button>

      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={cn(
          "p-1.5 rounded-md hover:bg-overlay transition-colors",
          editor.isActive("italic") ? "text-accent bg-accent-soft" : "text-muted-foreground"
        )}
        title="Italic"
      >
        <Italic className="w-4 h-4" />
      </button>

      <button
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={cn(
          "p-1.5 rounded-md hover:bg-overlay transition-colors",
          editor.isActive("strike") ? "text-accent bg-accent-soft" : "text-muted-foreground"
        )}
        title="Strike"
      >
        <Strikethrough className="w-4 h-4" />
      </button>

      <div className="w-px h-4 bg-border mx-1" />

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        className={cn(
          "p-1.5 rounded-md hover:bg-overlay transition-colors",
          editor.isActive("heading", { level: 1 }) ? "text-accent bg-accent-soft" : "text-muted-foreground"
        )}
        title="Heading 1"
      >
        <Heading1 className="w-4 h-4" />
      </button>
      
      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        className={cn(
          "p-1.5 rounded-md hover:bg-overlay transition-colors",
          editor.isActive("heading", { level: 2 }) ? "text-accent bg-accent-soft" : "text-muted-foreground"
        )}
        title="Heading 2"
      >
        <Heading2 className="w-4 h-4" />
      </button>
    </TiptapBubbleMenu>
  );
};
