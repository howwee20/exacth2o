import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "./lazyFeature";

describe("isChunkLoadError", () => {
  it("tells a missing chunk after a deploy apart from an ordinary render error", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://exacth2o.com/portal-app/assets/X.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'timestampMs')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
