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
function pickFiles(trigger: HTMLElement, files: File[]): HTMLInputElement {
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
  return input;
}

describe("CollagePreview rejects non-image files (#2863)", () => {
  beforeEach(() => {
    toastErrorSpy.mockClear();
    URL.createObjectURL ??= () => "";
    URL.revokeObjectURL ??= () => {};
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:c");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    useCollageStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
    expect(toastErrorSpy).toHaveBeenCalledWith(en.dropzone.unsupportedFileType, {
      id: "intake-unsupported-file-type",
    });
  });

  it("filters non-images picked through the upload area and shows the toast", () => {
    renderPreview();
    const input = pickFiles(screen.getByText(/upload images/i), [txt("notes.txt")]);
    for (const ext of [".jxl", ".dng", ".psd", ".tiff"]) {
      expect(input.accept).toContain(ext);
    }
    expect(useCollageStore.getState().images).toHaveLength(0);
    expect(toastErrorSpy).toHaveBeenCalledWith(en.dropzone.unsupportedFileType, {
      id: "intake-unsupported-file-type",
    });
  });

  it("keeps the images and drops the text file from a mixed pick on the upload area", () => {
    renderPreview();
    pickFiles(screen.getByText(/upload images/i), [png("a.png"), txt("notes.txt")]);
    expect(useCollageStore.getState().images).toHaveLength(1);
    expect(useCollageStore.getState().images[0].file.name).toBe("a.png");
    expect(toastErrorSpy).not.toHaveBeenCalled();
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
    const input = pickFiles(add as HTMLElement, [txt("notes.txt")]);
    for (const ext of [".jxl", ".dng", ".psd", ".tiff"]) {
      expect(input.accept).toContain(ext);
    }
    expect(useCollageStore.getState().images).toHaveLength(1);
    expect(toastErrorSpy).toHaveBeenCalledWith(en.dropzone.unsupportedFileType, {
      id: "intake-unsupported-file-type",
    });
  });

  it("does not show the toast when cancelling the picker or dropping an empty file list", () => {
    renderPreview();
    const zone = screen.getByRole("region", { name: en.a11y.fileDropZone });
    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    pickFiles(screen.getByText(/upload images/i), []);
    expect(toastErrorSpy).not.toHaveBeenCalled();

    act(() => {
      useCollageStore.getState().addImages([png("a.png")]);
    });
    const add = document.querySelector(
      'button[aria-label*="dd" i], button:has(svg.lucide-image-plus)',
    );
    expect(add).toBeTruthy();
    pickFiles(add as HTMLElement, []);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });
});
