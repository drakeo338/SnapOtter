/**
 * A failed deep-enhance pass must leave a trace (#1224).
 *
 * When Deep Enhance is on and the noise-removal sidecar throws, the tool falls
 * back to the Sharp-only result and returns it. That fallback must not be
 * silent: the failure goes to the API logs and to Sentry via reportError.
 *
 * The test forces the branch to run (isToolInstalled -> true) and makes the
 * sidecar reject. It asserts the fallback still returns a usable result (no
 * throw) and that the failure is both logged and reported with the error
 * attached. A second case pins the success path: the sidecar's result is used
 * and nothing is logged or reported.
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

// The real reportError would reach for the analytics gate and @sentry/node.
const errorReportMock = vi.hoisted(() => ({
  classifyError: vi.fn(),
  reportError: vi.fn(),
  safeFormatTag: vi.fn(),
}));
vi.mock("../../../apps/api/src/lib/error-report.js", () => errorReportMock);

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
  it("falls back to the Sharp-only result and logs and reports the sidecar failure", async () => {
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

    // And it reaches Sentry through the one deliberate capture path.
    expect(errorReportMock.reportError).toHaveBeenCalledTimes(1);
    expect(errorReportMock.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "SCUNet boom" }),
      expect.objectContaining({ source: "worker", toolId: "image-enhancement" }),
    );
  });

  it("uses the sidecar result and stays quiet when deep enhance succeeds", async () => {
    const deepResult = await sharp({
      create: { width: 3, height: 5, channels: 3, background: { r: 0, g: 200, b: 0 } },
    })
      .png()
      .toBuffer();
    vi.mocked(noiseRemoval).mockResolvedValue({ buffer: deepResult } as Awaited<
      ReturnType<typeof noiseRemoval>
    >);

    const result = await processImageEnhancement(await tinyPng(), settings, "test.png");

    expect(noiseRemoval).toHaveBeenCalledOnce();
    expect(result.buffer.equals(deepResult)).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(errorReportMock.reportError).not.toHaveBeenCalled();
  });
});
