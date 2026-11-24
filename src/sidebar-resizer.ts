import { BoxRenderable, MouseButton, type CliRenderer, type MouseEvent } from "@opentui/core";
import { theme, transparent } from "./theme";

const MIN_SIDEBAR_COLUMNS = 24;
const MIN_READER_COLUMNS = 28;
const KEY_STEP = 2;

export class SidebarResizer {
  readonly handle: BoxRenderable;
  private preferredWidth?: number;
  private drag?: { startX: number; startWidth: number };

  constructor(
    private readonly renderer: CliRenderer,
    private readonly panel: BoxRenderable,
  ) {
    this.handle = new BoxRenderable(renderer, {
      id: "sidebar-resizer",
      position: "absolute",
      top: 1,
      bottom: 1,
      left: 0,
      width: 1,
      zIndex: 10,
      border: ["left"],
      borderStyle: "single",
      borderColor: transparent,
      onMouseOver: () => {
        if (this.drag) return;

        this.handle.borderColor = theme.accentSoft;
        this.setPointer("col-resize");
      },
      onMouseOut: () => {
        if (this.drag) return;

        this.handle.borderColor = transparent;
        this.setPointer("default");
      },
      onMouseDown: this.startDrag,
      onMouseDrag: this.dragTo,
      onMouseDragEnd: this.finishDrag,
      onMouseUp: this.finishDrag,
    });
    renderer.on("resize", this.fit);
  }

  readonly fit = (): void => {
    const defaultWidth = Math.min(40, Math.max(28, Math.floor(this.renderer.width * 0.25)));
    const width = this.constrain(this.preferredWidth ?? defaultWidth);
    this.panel.width = width;
    this.handle.left = Math.max(0, width - 1);
  };

  nudge(direction: "left" | "right"): void {
    const width = this.constrain(this.preferredWidth ?? this.panel.width);
    this.setWidth(width + (direction === "left" ? -KEY_STEP : KEY_STEP));
  }

  dispose(): void {
    this.renderer.off("resize", this.fit);
  }

  private constrain(width: number): number {
    const maximum = Math.max(1, this.renderer.width - MIN_READER_COLUMNS);
    return Math.min(maximum, Math.max(Math.min(MIN_SIDEBAR_COLUMNS, maximum), Math.round(width)));
  }

  private setWidth(width: number): void {
    this.preferredWidth = this.constrain(width);
    this.fit();
  }

  private setPointer(style: "col-resize" | "default"): void {
    this.renderer.setMousePointer(style);
    this.renderer.requestRender();
  }

  private readonly startDrag = (event: MouseEvent): void => {
    if (event.button !== MouseButton.LEFT) return;

    event.preventDefault();
    event.stopPropagation();
    this.drag = { startX: event.x, startWidth: this.panel.width };
    this.handle.borderColor = theme.accent;
    this.setPointer("col-resize");
  };

  private readonly dragTo = (event: MouseEvent): void => {
    if (!this.drag) return;

    event.stopPropagation();
    this.setWidth(this.drag.startWidth + event.x - this.drag.startX);
  };

  private readonly finishDrag = (): void => {
    if (!this.drag) return;

    this.drag = undefined;
    this.handle.borderColor = transparent;
    this.setPointer("default");
  };
}
