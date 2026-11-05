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
      width: 1,
      height: "100%",
      flexShrink: 0,
      onMouseOver: () => {
        this.handle.backgroundColor = theme.hover;
        this.setPointer("col-resize");
      },
      onMouseOut: () => {
        if (this.drag) return;
        this.handle.backgroundColor = transparent;
        this.setPointer("default");
      },
      onMouseDown: this.startDrag,
      onMouseDrag: this.dragTo,
      onMouseDragEnd: this.finishDrag,
      onMouseUp: this.finishDrag,
    });
    renderer.on("resize", this.fit);
  }

  /**
   * Applies the width the user chose, or by default a quarter of the terminal (28 to 40 columns), within what the
   * reader leaves room for.
   */
  readonly fit = (): void => {
    const defaultWidth = Math.min(40, Math.max(28, Math.floor(this.renderer.width * 0.25)));
    this.panel.width = this.constrain(this.preferredWidth ?? defaultWidth);
  };

  nudge(direction: "left" | "right"): void {
    const width = this.constrain(this.preferredWidth ?? this.panel.width);
    this.setWidth(width + (direction === "left" ? -KEY_STEP : KEY_STEP));
  }

  dispose(): void {
    this.renderer.off("resize", this.fit);
  }

  private constrain(width: number): number {
    const maximum = Math.max(1, this.renderer.width - MIN_READER_COLUMNS - 1);
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
    this.handle.backgroundColor = theme.accent;
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
    this.handle.backgroundColor = transparent;
    this.setPointer("default");
  };
}
