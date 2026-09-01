import { mergeAttributes, Node, nodeInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import React, { useEffect, useState } from "react";
import { getAsset, objectUrlFor } from "@/lib/notes/db";

// React component for rendering the image asynchronously from IndexedDB
const ImageView = (props: any) => {
  const [src, setSrc] = useState<string | null>(null);
  const { node } = props;
  const assetIdOrUrl = node.attrs.src;

  useEffect(() => {
    let active = true;
    
    if (assetIdOrUrl.startsWith("asset-id:")) {
      const assetId = assetIdOrUrl.replace("asset-id:", "");
      getAsset(assetId).then((asset) => {
        if (active && asset) {
          setSrc(objectUrlFor(assetId, asset.blob));
        }
      }).catch(err => console.error(err));
    } else {
      // Fallback for standard urls
      setSrc(assetIdOrUrl);
    }
    
    return () => {
      active = false;
    };
  }, [assetIdOrUrl]);

  return (
    <NodeViewWrapper className="flex justify-center my-4 group relative">
      {src ? (
        <img
          src={src}
          alt={node.attrs.alt || ""}
          title={node.attrs.title || ""}
          className="max-w-full rounded-md shadow-sm"
        />
      ) : (
        <div className="h-32 w-full max-w-sm bg-surface-2 animate-pulse rounded-md flex items-center justify-center text-muted-foreground text-sm">
          Đang tải ảnh...
        </div>
      )}
    </NodeViewWrapper>
  );
};

export const NotesImageExtension = Node.create({
  name: "image",
  inline: false,
  group: "block",
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null,
      },
      alt: {
        default: null,
      },
      title: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
