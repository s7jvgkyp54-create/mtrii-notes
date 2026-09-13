import type { CanvasObject, PageRecord } from "./types.ts";
import {
  displaySize,
  displayToPage,
  objectBBox,
  translateObject,
  type BBox,
  type Pt,
} from "./geometry.ts";

export const MIN_DRAG_VISIBLE_SIZE = 48;

export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VisiblePageDropSurface {
  page: PageRecord;
  rect: ClientRectLike;
}

export interface PageDropTarget {
  page: PageRecord;
  point: Pt;
}

export interface CanvasObjectPlacement {
  delta: Pt;
  objects: CanvasObject[];
}

export interface CanvasObjectDropPlan {
  before: Record<string, CanvasObject[]>;
  updates: Record<string, CanvasObject[]>;
  movedObjects: CanvasObject[];
  changed: boolean;
}

function finite(...values: number[]) {
  return values.every(Number.isFinite);
}

/**
 * Resolve a drop from the pointer's real client position, independent of
 * pointer capture and whichever overlay happens to be on top of the page.
 */
export function findPageDropTarget(
  client: Pt,
  surfaces: VisiblePageDropSurface[],
): PageDropTarget | null {
  if (!finite(client.x, client.y)) return null;

  for (const surface of surfaces) {
    const { left, top, width, height } = surface.rect;
    if (!finite(left, top, width, height) || width <= 0 || height <= 0) continue;
    if (
      client.x < left ||
      client.x >= left + width ||
      client.y < top ||
      client.y >= top + height
    ) {
      continue;
    }

    const size = displaySize(surface.page);
    return {
      page: surface.page,
      point: displayToPage(
        ((client.x - left) / width) * size.w,
        ((client.y - top) / height) * size.h,
        surface.page,
      ),
    };
  }

  return null;
}

interface AxisRange {
  min: number;
  max: number;
}

function axisRange(
  boxes: BBox[],
  axis: "x" | "y",
  sizeAxis: "w" | "h",
  pageSize: number,
  minVisible: number,
): AxisRange | null {
  const groupStart = Math.min(...boxes.map((box) => box[axis]));
  const groupEnd = Math.max(...boxes.map((box) => box[axis] + box[sizeAxis]));
  const groupSize = groupEnd - groupStart;

  // A fitting group is kept fully inside the page as one unit.
  if (groupSize <= pageSize) {
    return { min: -groupStart, max: pageSize - groupEnd };
  }

  // An oversized group/object is never resized. Instead, find one shared
  // translation that leaves a useful, selectable area of every member visible.
  let min = -Infinity;
  let max = Infinity;
  for (const box of boxes) {
    const objectSize = box[sizeAxis];
    const visible = Math.min(pageSize, minVisible, Math.max(0, objectSize));
    min = Math.max(min, visible - (box[axis] + objectSize));
    max = Math.min(max, pageSize - visible - box[axis]);
  }

  return min <= max ? { min, max } : null;
}

function clampToRange(value: number, range: AxisRange) {
  return Math.min(Math.max(value, range.min), range.max);
}

/**
 * Apply one common translation to a selection. Objects that fit are fully
 * contained; oversized selections retain a useful visible area per member.
 * Returns null when preserving the group layout cannot produce a valid result.
 */
export function placeCanvasObjectsOnPage(
  objects: CanvasObject[],
  desiredDelta: Pt,
  page: Pick<PageRecord, "width" | "height">,
  minVisible = MIN_DRAG_VISIBLE_SIZE,
): CanvasObjectPlacement | null {
  if (
    objects.length === 0 ||
    !finite(desiredDelta.x, desiredDelta.y, page.width, page.height, minVisible) ||
    page.width <= 0 ||
    page.height <= 0 ||
    minVisible < 0
  ) {
    return null;
  }

  const boxes = objects.map(objectBBox);
  if (
    boxes.some(
      (box) =>
        !finite(box.x, box.y, box.w, box.h) ||
        box.w < 0 ||
        box.h < 0,
    )
  ) {
    return null;
  }

  const xRange = axisRange(boxes, "x", "w", page.width, minVisible);
  const yRange = axisRange(boxes, "y", "h", page.height, minVisible);
  if (!xRange || !yRange) return null;

  const delta = {
    x: clampToRange(desiredDelta.x, xRange),
    y: clampToRange(desiredDelta.y, yRange),
  };
  return {
    delta,
    objects: objects.map((object) => translateObject(object, delta.x, delta.y)),
  };
}

/**
 * Build the two-page mutation and its object-scoped Undo baseline from the
 * latest store state. Unrelated edits are retained, IDs/assets are reused, and
 * a duplicate/missing dragged ID cancels the whole operation.
 */
export function planCanvasObjectDrop({
  sourcePageId,
  targetPage,
  draggedIds,
  sourceOriginals,
  sourceObjects,
  targetObjects,
  desiredDelta,
}: {
  sourcePageId: string;
  targetPage: Pick<PageRecord, "id" | "width" | "height">;
  draggedIds: string[];
  sourceOriginals: CanvasObject[];
  sourceObjects: CanvasObject[];
  targetObjects: CanvasObject[];
  desiredDelta: Pt;
}): CanvasObjectDropPlan | null {
  const ids = new Set(draggedIds);
  if (ids.size === 0 || ids.size !== draggedIds.length) return null;

  const originalsById = new Map(sourceOriginals.map((object) => [object.id, object]));
  if (originalsById.size !== ids.size || [...ids].some((id) => !originalsById.has(id))) {
    return null;
  }

  const currentDragged = sourceObjects.filter((object) => ids.has(object.id));
  if (
    currentDragged.length !== ids.size ||
    currentDragged.some((object) => originalsById.get(object.id)?.type !== object.type)
  ) {
    return null;
  }
  if (targetPage.id !== sourcePageId && targetObjects.some((object) => ids.has(object.id))) {
    return null;
  }

  // Only selected objects return to their pointer-down geometry in the Undo
  // snapshot. Everything else comes from the latest state at pointer-up.
  const sourceBefore = sourceObjects.map(
    (object) => originalsById.get(object.id) ?? object,
  );
  const originalsInLayerOrder = sourceBefore.filter((object) => ids.has(object.id));
  const placement = placeCanvasObjectsOnPage(originalsInLayerOrder, desiredDelta, targetPage);
  if (!placement) return null;

  if (targetPage.id === sourcePageId) {
    const movedById = new Map(placement.objects.map((object) => [object.id, object]));
    const updates = {
      [sourcePageId]: sourceObjects.map((object) => movedById.get(object.id) ?? object),
    };
    const changed = Math.abs(placement.delta.x) > 1e-8 || Math.abs(placement.delta.y) > 1e-8;
    return {
      before: { [sourcePageId]: sourceBefore },
      updates,
      movedObjects: placement.objects,
      changed,
    };
  }

  return {
    before: {
      [sourcePageId]: sourceBefore,
      [targetPage.id]: targetObjects,
    },
    updates: {
      [sourcePageId]: sourceObjects.filter((object) => !ids.has(object.id)),
      [targetPage.id]: [...targetObjects, ...placement.objects],
    },
    movedObjects: placement.objects,
    changed: true,
  };
}
