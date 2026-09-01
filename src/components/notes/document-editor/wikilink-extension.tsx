import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import type { Editor, Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import React, { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/lib/notes/store";

interface NotebookItem {
  id: string;
  title: string;
}

const getNotebookItems = ({ query }: { query: string }): NotebookItem[] => {
  const notebooks = useNotesStore.getState().notebooks;
  const items = notebooks.map((nb) => ({ id: nb.id, title: nb.name }));

  return items
    .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 10); // Limit to 10 items
};

interface WikilinkListProps {
  items: NotebookItem[];
  command: (item: NotebookItem) => void;
}

const WikilinkList = forwardRef((props: WikilinkListProps, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command(item);
    }
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length);
        return true;
      }

      if (event.key === "ArrowDown") {
        setSelectedIndex((selectedIndex + 1) % props.items.length);
        return true;
      }

      if (event.key === "Enter") {
        selectItem(selectedIndex);
        return true;
      }

      return false;
    },
  }));

  if (props.items.length === 0) {
    return (
      <div className="bg-surface border rounded-lg shadow-md p-2 text-sm text-muted-foreground w-48">
        Không tìm thấy ghi chú
      </div>
    );
  }

  return (
    <div className="bg-surface border rounded-lg shadow-md p-1 min-w-[200px] flex flex-col overflow-hidden max-h-[300px] overflow-y-auto">
      {props.items.map((item, index) => (
        <button
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded-md hover:bg-overlay transition-colors",
            index === selectedIndex ? "bg-accent-soft text-accent" : "text-fg"
          )}
          key={index}
          onClick={() => selectItem(index)}
        >
          <div className="flex-shrink-0 text-muted-foreground">
            <FileText className="w-4 h-4" />
          </div>
          <span className="font-medium truncate">{item.title}</span>
        </button>
      ))}
    </div>
  );
});

WikilinkList.displayName = "WikilinkList";

export const WikilinkExtension = Extension.create({
  name: "wikilinkSuggestion",

  addOptions() {
    return {
      suggestion: {
        char: "[[",
        command: ({ editor, range, props }: any) => {
          // insert link
          const node = editor.schema.text(`[[${props.title}]]`, [
            editor.schema.marks.link.create({ href: `/note/${props.id}` }),
          ]);
          editor.chain().focus().deleteRange(range).insertContent(node).insertContent(" ").run();
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

export const wikilinkSuggestion = {
  items: getNotebookItems,
  render: () => {
    let component: ReactRenderer<any>;
    let popup: TippyInstance[];

    return {
      onStart: (props: any) => {
        component = new ReactRenderer(WikilinkList, {
          props,
          editor: props.editor,
        });

        if (!props.clientRect) {
          return;
        }

        popup = tippy("body", {
          getReferenceClientRect: props.clientRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "bottom-start",
        });
      },

      onUpdate(props: any) {
        component.updateProps(props);

        if (!props.clientRect) {
          return;
        }

        popup[0]?.setProps({
          getReferenceClientRect: props.clientRect,
        });
      },

      onKeyDown(props: any) {
        if (props.event.key === "Escape") {
          popup[0]?.hide();
          return true;
        }
        return component.ref?.onKeyDown(props);
      },

      onExit() {
        popup[0]?.destroy();
        component.destroy();
      },
    };
  },
};
