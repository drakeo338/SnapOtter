/**
 * A failed deep-enhance pass must leave a trace (#1224).
 *
 * When Deep Enhance is on and the noise-removal sidecar throws, the tool
 * correctly falls back to the Sharp-only result and returns it. The bug was
 * that it did so silently: an empty `catch {}` swallowed a real sidecar crash,
 * OOM or bad scratch dir, so the caller got a 200 and nothing in the logs or
 * Sentry recorded that the feature they asked for never ran.
 *
 * isToolInstalled() already gates out the genuinely-missing-model case before
 * the try, so this test forces the branch to run (isToolInstalled -> true) and
 * makes the sidecar reject. It asserts both halves: the fallback still returns
 * a usable result (no throw), and the failure is logged with the error
 * attached. With the empty catch restored, the logger.warn assertion fails.
 */

import { noiseRemoval } from "@snapotter/ai";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  colorize: vi.fn(),
  enhanceFaces: vi.fn(),
  isMemoryAllocError: vi.fn(),
  noiseRemoval: vi.fn(),
  removeBackground: vi.fn(),
  removeRedEye: vi.fn(),
  restorePhoto: vi.fn(),
  upscale: vi.fn(),
}));

vi.mock("@snapotter/ai", () => ({
  colorize: aiMocks.colorize,
  enhanceFaces: aiMocks.enhanceFaces,
  isMemoryAllocError: aiMocks.isMemoryAllocError,
  noiseRemoval: aiMocks.noiseRemoval,
  removeBackground: aiMocks.removeBackground,
  removeRedEye: aiMocks.removeRedEye,
  restorePhoto: aiMocks.restorePhoto,
  upscale: aiMocks.upscale,
}));

// Force the deep-enhance branch to run: the model reads as installed, so the
// only way into the catch is a pass that started and broke.
vi.mock("../../../apps/api/src/lib/feature-status.js", () => ({
  getFirstMissingBundleForTool: vi.fn(() => null),
  isToolInstalled: vi.fn(() => true),
}));

// Same container-free logger seam the repo already uses in generate-preview.
// Importing the real logger would spin up a pino-roll transport writing to
// ./data/logs, which a pure-logic unit test has no business doing.
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../apps/api/src/lib/logger.js", () => ({ logger: loggerMock }));

import { processImageEnhancement } from "../../../apps/api/src/routes/tools/image-enhancement.js";

const settings = {
  mode: "auto" as const,
  intensity: 50,
  corrections: {
    exposure: true,
    contrast: true,
    whiteBalance: true,
    saturation: true,
    sharpness: true,
    denoise: true,
  },
  deepEnhance: true,
};

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 90, b: 40 } },
  })
    .png()
    .toBuffer();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deep-enhance failure leaves a trace (#1224)", () => {
  it("falls back to the Sharp-only result and logs the sidecar failure", async () => {
    vi.mocked(noiseRemoval).mockRejectedValue(new Error("SCUNet boom"));

    const png = await tinyPng();
    const result = await processImageEnhancement(png, settings, "test.png");

    // The deep-enhance branch actually ran and hit the failing sidecar.
    expect(noiseRemoval).toHaveBeenCalledOnce();

    // Fallback preserved: it did not throw, and it returned a usable result.
    expect(result.contentType).toBe("image/png");
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
    // The returned bytes are a real image (the Sharp-only pass), not the
    // rejected sidecar's output.
    await expect(sharp(result.buffer).metadata()).resolves.toMatchObject({ format: "png" });

    // The failure is no longer silent: it is logged with the error attached.
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: "SCUNet boom" }),
        toolId: "image-enhancement",
      }),
      expect.stringContaining("deep enhance failed"),
    );
  });
});
