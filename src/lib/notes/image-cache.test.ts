import assert from "node:assert/strict";
import test from "node:test";
import { boundedBitmapOptions, readRasterDimensionsFromBytes } from "./image-cache.ts";

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function u16(value: number) {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function box(type: string, ...content: Uint8Array[]) {
  const payload = concat(...content);
  return concat(u32(payload.length + 8), encoder.encode(type), payload);
}

function fullBox(type: string, version: number, flags: number, ...content: Uint8Array[]) {
  return box(
    type,
    Uint8Array.of(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff),
    ...content,
  );
}

test("AVIF dimensions follow the primary-item property rather than an auxiliary image", () => {
  const fileType = box("ftyp", encoder.encode("avif"), u32(0), encoder.encode("avifmif1"));
  const auxiliaryDimensions = fullBox("ispe", 0, 0, u32(9000), u32(9000));
  const primaryDimensions = fullBox("ispe", 0, 0, u32(4000), u32(3000));
  const propertyContainer = box("ipco", auxiliaryDimensions, primaryDimensions);
  const associations = fullBox(
    "ipma",
    0,
    0,
    u32(2),
    u16(1),
    Uint8Array.of(1, 1),
    u16(2),
    Uint8Array.of(1, 2),
  );
  const itemProperties = box("iprp", propertyContainer, associations);
  const primaryItem = fullBox("pitm", 0, 0, u16(2));
  const meta = fullBox("meta", 0, 0, primaryItem, itemProperties);

  assert.deepEqual(readRasterDimensionsFromBytes(concat(fileType, meta)), {
    width: 4000,
    height: 3000,
  });
});

test("bitmap resize bounds the longest edge and never requests an upscale", () => {
  assert.deepEqual(boundedBitmapOptions({ width: 4000, height: 3000 }, 1024), {
    resizeQuality: "high",
    resizeWidth: 1024,
  });
  assert.deepEqual(boundedBitmapOptions({ width: 600, height: 1200 }, 512), {
    resizeQuality: "high",
    resizeHeight: 512,
  });
  assert.deepEqual(boundedBitmapOptions({ width: 320, height: 200 }, 512), {
    resizeQuality: "high",
  });
});

test("unknown and malformed raster headers do not invent unsafe dimensions", () => {
  assert.equal(readRasterDimensionsFromBytes(encoder.encode("not an image payload")), null);
  assert.throws(() => boundedBitmapOptions({ width: 0, height: 100 }, 512), RangeError);
});
