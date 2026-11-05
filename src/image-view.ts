import { ImageRenderable, imageInfo, type ScrollBoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { ImageFile } from "./files";

export interface ImageDetails {
  width: number;
  height: number;
  format: string;
}

/** Reads a picture's size and format, or throws a plain message when it is not an image Scouter can decode. */
export function describeImage(bytes: Uint8Array): ImageDetails {
  try {
    const { width, height, format } = imageInfo(bytes);
    return { width, height, format };
  } catch {
    throw new Error("This image could not be read.");
  }
}

/** The terminal's own graphics are used when it has them, else character blocks. */
export class ImageView {
  private readonly image: ImageRenderable;
  private viewer?: ScrollBoxRenderable;

  constructor(renderer: CliRenderer, protocol: "auto" | "kitty" | "sixel" | "blocks" = "auto") {
    this.image = new ImageRenderable(renderer, {
      id: "document-image",
      width: "100%",
      height: 1,
      fit: "fit",
      protocol,
      flexShrink: 0,
    });
    this.image.visible = false;
  }

  mount(viewer: ScrollBoxRenderable): void {
    this.viewer = viewer;
    viewer.add(this.image);
  }

  show(file: ImageFile): void {
    this.image.visible = true;
    this.image.source = file.bytes;
    this.resize();
  }

  hide(): void {
    this.image.visible = false;
    this.image.source = undefined;
  }

  /** The picture is as tall as the reader, so it never needs scrolling. */
  resize(): void {
    if (!this.viewer || !this.image.visible) return;
    this.viewer.contentOptions = { flexDirection: "column", width: "100%" };
    this.image.height = Math.max(1, this.viewer.viewport.height);
  }

  destroy(): void {
    this.image.destroyRecursively();
  }
}
