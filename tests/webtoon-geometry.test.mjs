import { test } from "node:test";
import assert from "node:assert/strict";
import { webtoonTileCount } from "../src/lib/webtoonGeometry.ts";

test("tile count follows actual non-upscaled output geometry", () => {
  const cases = [
    [1, 10000, 320, 5],
    [400, 10000, 800, 5],
    [7, 928, 448, 1],
    [800, 9000, 400, 3],
    [100, 2048, 100, 1],
    [100, 2049, 100, 2],
    [0, 100, 800, 1],
  ];
  for (const [width, height, renderWidth, expected] of cases) {
    assert.equal(webtoonTileCount(width, height, renderWidth, 2048), expected);
  }
});
