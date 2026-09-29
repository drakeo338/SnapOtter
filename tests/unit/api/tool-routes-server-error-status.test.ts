/**
 * #1640: the hand-written tool routes store their result inside a catch-all
 * that answers 422, so a full workspace (507/503) or a failed write read as
 * a bad file. An error carrying a 5xx statusCode must reach the error handler
 * and be answered with that status; any other failure stays a 422.
 */

import multipart from "@fastify/multipart";
import { apiToolPath, hasServerErrorStatus, SafeError } from "@snapotter/shared";
import Fastify from "fastify";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const putObject = vi.fn();

vi.mock("../../../apps/api/src/lib/object-storage.js", () => ({
  putObject: (...args: unknown[]) => putObject(...args),
  getObjectBuffer: vi.fn(),
}));

import { registerErrorHandler } from "../../../apps/api/src/plugins/error-handler.js";
import { registerCompare } from "../../../apps/api/src/routes/tools/compare.js";
import { registerSvgToRaster } from "../../../apps/api/src/routes/tools/svg-to-raster.js";

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
);

async function buildApp(register: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify();
  await app.register(multipart);
  registerErrorHandler(app);
  register(app);
  await app.ready();
  return app;
}

function multipartBody(files: { name: string; type: string; data: Buffer }[]) {
  const boundary = "----unit";
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`,
      ),
      f.data,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const storageFull = () =>
  new SafeError("Workspace is full.", { statusCode: 507, code: "WORKSPACE_FULL" });
const storageDown = () =>
  new SafeError("Storage unavailable.", { statusCode: 503, code: "STORAGE_UNAVAILABLE" });

describe("hasServerErrorStatus", () => {
  it("accepts 5xx statusCode errors only", () => {
    expect(hasServerErrorStatus(storageFull())).toBe(true);
    expect(hasServerErrorStatus(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(true);
    expect(hasServerErrorStatus(Object.assign(new Error("x"), { statusCode: 400 }))).toBe(false);
    expect(hasServerErrorStatus(new Error("x"))).toBe(false);
    expect(hasServerErrorStatus(null)).toBe(false);
    expect(hasServerErrorStatus({ statusCode: 503 })).toBe(false);
  });
});

describe("svg-to-raster", () => {
  beforeEach(() => {
    putObject.mockReset();
  });

  const send = async (app: Awaited<ReturnType<typeof buildApp>>) =>
    app.inject({
      method: "POST",
      url: apiToolPath("svg-to-raster"),
      ...multipartBody([{ name: "a.svg", type: "image/svg+xml", data: SVG }]),
    });

  it("surfaces a 507 from the storage write instead of answering 422", async () => {
    putObject.mockImplementation(async () => {
      throw storageFull();
    });
    const app = await buildApp(registerSvgToRaster);
    const res = await send(app);
    expect(res.statusCode).toBe(507);
    await app.close();
  });

  it("surfaces a 503 from the storage write instead of answering 422", async () => {
    putObject.mockImplementation(async () => {
      throw storageDown();
    });
    const app = await buildApp(registerSvgToRaster);
    expect((await send(app)).statusCode).toBe(503);
    await app.close();
  });

  it("still answers 422 for an ordinary failure", async () => {
    putObject.mockImplementation(async () => {
      throw new Error("bad input");
    });
    const app = await buildApp(registerSvgToRaster);
    const res = await send(app);

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("SVG conversion failed");
    await app.close();
  });
});

describe("compare", () => {
  beforeEach(() => {
    putObject.mockReset();
  });

  const send = async (app: Awaited<ReturnType<typeof buildApp>>) => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#f00" },
    })
      .png()
      .toBuffer();
    return app.inject({
      method: "POST",
      url: "/api/v1/tools/image/compare",
      ...multipartBody([
        { name: "a.png", type: "image/png", data: png },
        { name: "b.png", type: "image/png", data: png },
      ]),
    });
  };

  it("surfaces a 507 from the storage write instead of answering 422", async () => {
    putObject.mockImplementation(async () => {
      throw storageFull();
    });
    const app = await buildApp(registerCompare);
    expect((await send(app)).statusCode).toBe(507);
    await app.close();
  });

  it("still answers 422 for an ordinary failure", async () => {
    putObject.mockImplementation(async () => {
      throw new Error("bad input");
    });
    const app = await buildApp(registerCompare);
    const res = await send(app);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("Comparison failed");
    await app.close();
  });
});
