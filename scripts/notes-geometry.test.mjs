import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displaySize,
  displayToPage,
  hitTest,
  objectBBox,
  pageBBoxToDisplay,
  pageToDisplay,
  rotateObjects,
  unionBBox,
} from "../src/lib/notes/geometry.ts";

const page = { width: 600, height: 840, rotation: 0 };
const image = {
  id: "image",
  type: "image",
  x: 0,
  y: 0,
  w: 100,
  h: 20,
  rotation: 90,
  assetId: "asset",
};

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
}

test("rotated page selection maps back to the original pointer coordinates", () => {
  for (const rotation of [0, 90, 180, 270]) {
    const rotatedPage = { ...page, rotation };
    const size = displaySize(rotatedPage);
    for (const point of [{ x: 0, y: 0 }, { x: 600, y: 840 }, { x: 130, y: 420 }]) {
      const displayed = pageToDisplay(point.x, point.y, rotatedPage);
      assert.ok(displayed.x >= 0 && displayed.x <= size.w);
      assert.ok(displayed.y >= 0 && displayed.y <= size.h);
      assert.deepEqual(displayToPage(displayed.x, displayed.y, rotatedPage), point);
    }
  }
});

test("DOM selection bounds match all four rendered corners after page rotation", () => {
  const box = { x: 130, y: 220, w: 170, h: 80 };
  const expected = [
    { x: 130, y: 220, w: 170, h: 80 },
    { x: 540, y: 130, w: 80, h: 170 },
    { x: 300, y: 540, w: 170, h: 80 },
    { x: 220, y: 300, w: 80, h: 170 },
  ];
  [0, 90, 180, 270].forEach((rotation, index) => {
    assert.deepEqual(pageBBoxToDisplay(box, { ...page, rotation }), expected[index]);
  });
});

test("rotated image is selectable on its visible extent without stealing clicks in its old footprint", () => {
  assert.equal(hitTest(image, { x: 50, y: -35 }, 0), true);
  assert.equal(hitTest(image, { x: 5, y: 5 }, 0), false);
  const bounds = objectBBox(image);
  near(bounds.x, 40);
  near(bounds.y, -40);
  near(bounds.w, 20);
  near(bounds.h, 100);
});

test("arbitrary image angles use the actual rectangle, not empty corners of its bounds", () => {
  const angled = { ...image, rotation: 45 };
  const box = objectBBox(angled);
  assert.equal(hitTest(angled, { x: box.x + 1, y: box.y + 1 }, 0), false);
  assert.equal(hitTest(angled, { x: 50, y: 10 }, 0), true);
});

test("text and image edges honor the supplied touch/pointer tolerance", () => {
  const text = { ...image, type: "text", rotation: 0, fontSize: 20, text: "Ghi chú" };
  for (const object of [text, { ...image, rotation: 0 }]) {
    assert.equal(hitTest(object, { x: -3, y: 10 }, 4), true);
    assert.equal(hitTest(object, { x: -5, y: 10 }, 4), false);
  }
});

test("image rotation preserves dimensions instead of collapsing a square at 45 degrees", () => {
  const square = { ...image, x: 20, y: 30, w: 80, h: 80, rotation: 15 };
  const [rotated] = rotateObjects([square], 60, 70, Math.PI / 4);
  assert.equal(rotated.w, 80);
  assert.equal(rotated.h, 80);
  near(rotated.x, 20);
  near(rotated.y, 30);
  near(rotated.rotation, 60);
  assert.equal(square.rotation, 15);
});

test("selecting a long stroke never exceeds the JavaScript argument limit", () => {
  const stroke = {
    id: "stroke",
    type: "stroke",
    width: 2,
    points: Array.from({ length: 200_000 }, (_, index) => ({ x: index, y: index % 300, p: 0.5 })),
  };
  assert.deepEqual(objectBBox(stroke), { x: -2, y: -2, w: 200_003, h: 303 });
});

test("empty strokes cannot poison a valid object's selection bounds", () => {
  const empty = { id: "empty", type: "stroke", width: 2, points: [] };
  assert.deepEqual(objectBBox(empty), { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(unionBBox([empty]), null);
  assert.deepEqual(unionBBox([empty, image]), objectBBox(image));
});
