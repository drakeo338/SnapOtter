// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { en } from "@snapotter/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastErrorSpy = vi.hoisted(() => vi.fn());

// By path: a bare "sonner" resolves differently here than in apps/web and mocks nothing (#1235).
vi.mock("../../../apps/web/node_modules/sonner", () => ({
  toast: { error: toastErrorSpy, info: vi.fn() },
}));

vi.mock("@/lib/image-preview", () => ({
  needsServerPreview: vi.fn(() => false),
  fetchDecodedPreview: vi.fn(() => Promise.resolve(null)),
  revokePreviewUrl: vi.fn(),
}));

import { CollagePreview } from "@/components/tools/collage-preview";
import { I18nProvider } from "@/contexts/i18n-context";
import { useCollageStore } from "@/stores/collage-store";

const png = (name: string) => new File([new ArrayBuffer(64)], name, { type: "image/png" });
const txt = (name: string) => new File(["hello"], name, { type: "text/plain" });

/** Click the control, then answer the file picker it opened with `files`. */
function pickFiles(trigger: HTMLElement, files: File[]) {
  const inputs: HTMLInputElement[] = [];
  const spy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    inputs.push(this);
  });
  fireEvent.click(trigger);
  spy.mockRestore();
  const input = inputs[0];
  Object.defineProperty(input, "files", { value: files });
  act(() => {
    input.dispatchEvent(new Event("change"));
  });
}

describe("CollagePreview rejects non-image files (#2863)", () => {
  beforeEach(() => {
    toastErrorSpy.mockClear();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:c"), revokeObjectURL: vi.fn() }),
    );
    useCollageStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderPreview = () =>
    render(
      <I18nProvider>
        <CollagePreview />
      </I18nProvider>,
    );

  it("shows the unsupported toast when only non-images are dropped on the upload area", () => {
    renderPreview();
    const zone = screen.getByRole("region", { name: en.a11y.fileDropZone });
    fireEvent.drop(zone, { dataTransfer: { files: [txt("notes.txt")] } });
    expect(useCollageStore.getState().images).toHaveLength(0);
    expect(toastErrorSpy).toHaveBeenCalledWith(en.dropzone.unsupportedFileType, expect.anything());
  });

  it("filters non-images picked through the upload area and shows the toast", () => {
    renderPreview();
    pickFiles(screen.getByText(/upload images/i), [txt("notes.txt")]);
    expect(useCollageStore.getState().images).toHaveLength(0);
    expect(toastErrorSpy).toHaveBeenCalledWith(en.dropzone.unsupportedFileType, expect.anything());
  });

  it("keeps the images and drops the text file from a mixed pick on the upload area", () => {
    renderPreview();
    pickFiles(screen.getByText(/upload images/i), [png("a.png"), txt("notes.txt")]);
    expect(useCollageStore.getState().images).toHaveLength(1);
  });

  it("filters non-images picked through the strip + button and shows the toast", async () => {
    act(() => {
      useCollageStore.getState().addImages([png("a.png")]);
    });
    const { container } = renderPreview();
    const add = container.querySelector(
      'button[aria-label*="dd" i], button:has(svg.lucide-image-plus)',
    );
    expect(add).toBeTruthy();
    pickFiles(add as HTMLElement, [txt("notes.txt")]);
    expect(useCollageStore.getState().images).toHaveLength(1);
    expect(toastErrorSpy).toHaveBeenCalledWith(en.dropzone.unsupportedFileType, expect.anything());
  });
});
