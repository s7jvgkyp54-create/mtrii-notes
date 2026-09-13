import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findPageDropTarget,
  placeCanvasObjectsOnPage,
  planCanvasObjectDrop,
} from "../src/lib/notes/drag-drop.ts";
import { objectBBox, pageToDisplay } from "../src/lib/notes/geometry.ts";

function page(overrides = {}) {
  return {
    id: "page-a",
    notebookId: "notebook",
    index: 0,
    paper: { pattern: "blank", color: "#fff", lineColor: "#ddd" },
    rotation: 0,
    width: 595.28,
    height: 841.89,
    pdfPage: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function text(overrides = {}) {
  return {
    id: "text",
    type: "text",
    x: 100,
    y: 120,
    w: 160,
    h: 56,
    text: "Không được biến mất",
    fontSize: 20,
    color: "#111",
    align: "left",
    ...overrides,
  };
}

function image(overrides = {}) {
  return {
    id: "image",
    type: "image",
    x: 280,
    y: 240,
    w: 180,
    h: 100,
    rotation: 0,
    assetId: "asset-original",
    ...overrides,
  };
}

function intersectionLength(start, length, pageLength) {
  return Math.max(0, Math.min(pageLength, start + length) - Math.max(0, start));
}

describe("notes object drop targeting", () => {
  it("treats gray background, page gaps, toolbar space, and outside-window coordinates as invalid", () => {
    const first = page();
    const second = page({ id: "page-b", index: 1 });
    const surfaces = [
      { page: first, rect: { left: 100, top: 80, width: 297.64, height: 420.945 } },
      { page: second, rect: { left: 100, top: 540, width: 297.64, height: 420.945 } },
    ];

    assert.equal(findPageDropTarget({ x: 430, y: 200 }, surfaces), null, "gray right side");
    assert.equal(findPageDropTarget({ x: 200, y: 520 }, surfaces), null, "inter-page gap");
    assert.equal(findPageDropTarget({ x: 200, y: 30 }, surfaces), null, "app toolbar");
    assert.equal(findPageDropTarget({ x: -20, y: -20 }, surfaces), null, "outside window");
    assert.equal(findPageDropTarget({ x: 721, y: 200 }, surfaces), null, "reported x=721 regression");
  });

  it("maps the actual client drop to page coordinates at every quarter-turn", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const targetPage = page({ rotation });
      const scale = 0.5;
      const displayPoint = pageToDisplay(135, 246, targetPage);
      const displayWidth = rotation === 90 || rotation === 270
        ? targetPage.height
        : targetPage.width;
      const displayHeight = rotation === 90 || rotation === 270
        ? targetPage.width
        : targetPage.height;
      const result = findPageDropTarget(
        { x: 40 + displayPoint.x * scale, y: 70 + displayPoint.y * scale },
        [{
          page: targetPage,
          rect: { left: 40, top: 70, width: displayWidth * scale, height: displayHeight * scale },
        }],
      );
      assert(result);
      assert(Math.abs(result.point.x - 135) < 1e-8);
      assert(Math.abs(result.point.y - 246) < 1e-8);
    }
  });
});

describe("notes object placement", () => {
  it("clamps one fitting object at all four page edges without resizing it", () => {
    const original = text();
    const cases = [
      [{ x: -1_000, y: 0 }, { x: 0, y: original.y }],
      [{ x: 1_000, y: 0 }, { x: 595.28 - original.w, y: original.y }],
      [{ x: 0, y: -1_000 }, { x: original.x, y: 0 }],
      [{ x: 0, y: 1_000 }, { x: original.x, y: 841.89 - original.h }],
    ];

    for (const [delta, expected] of cases) {
      const placement = placeCanvasObjectsOnPage([original], delta, page());
      assert(placement);
      assert.deepEqual(
        { x: placement.objects[0].x, y: placement.objects[0].y },
        expected,
      );
      assert.equal(placement.objects[0].w, original.w);
      assert.equal(placement.objects[0].h, original.h);
      assert.equal(placement.objects[0].fontSize, original.fontSize);
    }
  });

  it("uses a rotated image's true visible bounds and preserves its asset, size, and angle", () => {
    const original = image({ x: 500, y: 100, w: 120, h: 40, rotation: 45 });
    const placement = placeCanvasObjectsOnPage([original], { x: 400, y: -200 }, page());
    assert(placement);
    const moved = placement.objects[0];
    const box = objectBBox(moved);
    assert(box.x >= -1e-8 && box.x + box.w <= 595.28 + 1e-8);
    assert(box.y >= -1e-8 && box.y + box.h <= 841.89 + 1e-8);
    assert.equal(moved.w, original.w);
    assert.equal(moved.h, original.h);
    assert.equal(moved.rotation, original.rotation);
    assert.equal(moved.assetId, original.assetId);
  });

  it("includes a stroke's painted width when clamping its true bounds", () => {
    const original = {
      id: "stroke",
      type: "stroke",
      tool: "pen",
      color: "#111",
      width: 12,
      points: [{ x: 8, y: 9, p: 0.5 }, { x: 80, y: 45, p: 0.5 }],
    };
    const placement = placeCanvasObjectsOnPage([original], { x: -500, y: -500 }, page());
    assert(placement);
    const box = objectBBox(placement.objects[0]);
    assert.equal(box.x, 0);
    assert.equal(box.y, 0);
    assert.equal(placement.objects[0].width, original.width);
  });

  it("moves a text/image group with one delta and keeps order and relative layout", () => {
    const objects = [text({ x: 420, y: 700 }), image({ x: 500, y: 780 })];
    const placement = placeCanvasObjectsOnPage(objects, { x: 300, y: 200 }, page());
    assert(placement);
    assert.deepEqual(placement.objects.map((object) => object.id), ["text", "image"]);
    for (let index = 0; index < objects.length; index += 1) {
      assert.equal(placement.objects[index].x - objects[index].x, placement.delta.x);
      assert.equal(placement.objects[index].y - objects[index].y, placement.delta.y);
    }
    assert.equal(
      placement.objects[1].x - placement.objects[0].x,
      objects[1].x - objects[0].x,
    );
    assert.equal(
      placement.objects[1].y - placement.objects[0].y,
      objects[1].y - objects[0].y,
    );
  });

  it("keeps a useful area of an oversized object visible without shrinking it", () => {
    const original = image({ x: 0, y: 0, w: 1_000, h: 1_100, rotation: 0 });
    const placement = placeCanvasObjectsOnPage([original], { x: 2_000, y: -2_000 }, page());
    assert(placement);
    const moved = placement.objects[0];
    const box = objectBBox(moved);
    assert(intersectionLength(box.x, box.w, 595.28) >= 48 - 1e-8);
    assert(intersectionLength(box.y, box.h, 841.89) >= 48 - 1e-8);
    assert.equal(moved.w, 1_000);
    assert.equal(moved.h, 1_100);
  });

  it("cancels an oversized group when no shared delta can keep every member selectable", () => {
    const objects = [
      text({ id: "left", x: 0, y: 20, w: 40, h: 40 }),
      text({ id: "right", x: 1_000, y: 20, w: 40, h: 40 }),
    ];
    assert.equal(placeCanvasObjectsOnPage(objects, { x: 0, y: 0 }, page()), null);
  });
});

describe("notes object drop transaction planning", () => {
  it("uses an object-scoped Undo baseline and preserves an unrelated concurrent edit", () => {
    const original = text();
    const unrelated = text({ id: "other", x: 20, text: "changed while dragging" });
    const plan = planCanvasObjectDrop({
      sourcePageId: "page-a",
      targetPage: page(),
      draggedIds: [original.id],
      sourceOriginals: [original],
      sourceObjects: [original, unrelated],
      targetObjects: [original, unrelated],
      desiredDelta: { x: 75, y: 30 },
    });
    assert(plan?.changed);
    assert.deepEqual(plan.before["page-a"][1], unrelated);
    assert.deepEqual(plan.updates["page-a"][1], unrelated);
    assert.equal(plan.updates["page-a"][0].x, original.x + 75);
  });

  it("makes a cross-page move atomic, preserves IDs/assets/order, and never duplicates", () => {
    const movedText = text();
    const movedImage = image();
    const sourceOther = text({ id: "source-other", x: 10 });
    const targetOther = text({ id: "target-other", x: 20 });
    const target = page({ id: "page-b", width: 419.53, height: 595.28, rotation: 90 });
    const plan = planCanvasObjectDrop({
      sourcePageId: "page-a",
      targetPage: target,
      draggedIds: [movedText.id, movedImage.id],
      sourceOriginals: [movedText, movedImage],
      sourceObjects: [sourceOther, movedText, movedImage],
      targetObjects: [targetOther],
      desiredDelta: { x: -40, y: 35 },
    });
    assert(plan?.changed);
    assert.deepEqual(plan.updates["page-a"].map((object) => object.id), ["source-other"]);
    assert.deepEqual(
      plan.updates["page-b"].map((object) => object.id),
      ["target-other", "text", "image"],
    );
    assert.equal(plan.updates["page-b"].filter((object) => object.id === "image").length, 1);
    assert.equal(plan.updates["page-b"].find((object) => object.id === "image").assetId, "asset-original");

    // Reapplying before/updates models repeated Undo/Redo snapshots: each state
    // contains the moved IDs on exactly one page.
    for (const snapshot of [plan.updates, plan.before, plan.updates, plan.before, plan.updates]) {
      const all = [...snapshot["page-a"], ...snapshot["page-b"]];
      assert.equal(all.filter((object) => object.id === "text").length, 1);
      assert.equal(all.filter((object) => object.id === "image").length, 1);
    }
  });

  it("does not create a move for a return-to-start drag", () => {
    const original = text();
    const plan = planCanvasObjectDrop({
      sourcePageId: "page-a",
      targetPage: page(),
      draggedIds: [original.id],
      sourceOriginals: [original],
      sourceObjects: [original],
      targetObjects: [original],
      desiredDelta: { x: 0, y: 0 },
    });
    assert(plan);
    assert.equal(plan.changed, false);
  });

  it("cancels the whole move when an ID is missing or already exists at the destination", () => {
    const original = text();
    const common = {
      sourcePageId: "page-a",
      targetPage: page({ id: "page-b" }),
      draggedIds: [original.id],
      sourceOriginals: [original],
      desiredDelta: { x: 20, y: 20 },
    };
    assert.equal(
      planCanvasObjectDrop({ ...common, sourceObjects: [], targetObjects: [] }),
      null,
    );
    assert.equal(
      planCanvasObjectDrop({
        ...common,
        sourceObjects: [original],
        targetObjects: [text({ x: 0 })],
      }),
      null,
    );
  });
});
