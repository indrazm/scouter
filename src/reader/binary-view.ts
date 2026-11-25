import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { formatBytes } from "../core/files";
import { styled } from "../ui/styled";
import { theme } from "../ui/theme";

export class BinaryView {
  readonly root: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly meta: TextRenderable;
  private readonly hint: TextRenderable;
  private current?: { title: string; size: number };

  constructor(context: RenderContext) {
    this.root = new BoxRenderable(context, {
      id: "binary-view",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    });
    this.title = new TextRenderable(context, {
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.meta = new TextRenderable(context, {
      height: 1,
      flexShrink: 0,
      marginTop: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.hint = new TextRenderable(context, {
      height: 1,
      flexShrink: 0,
      marginTop: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.root.add(this.title);
    this.root.add(this.meta);
    this.root.add(this.hint);
    this.root.visible = false;
  }

  show(title: string, size: number): void {
    this.current = { title, size };
    this.restyle();
  }

  clear(): void {
    this.current = undefined;
  }

  restyle(): void {
    if (!this.current) return;

    this.title.content = styled([{ text: "Binary files are not supported.", fg: theme.text, bold: true }]);
    this.meta.content = styled([
      { text: this.current.title, fg: theme.accentSoft },
      { text: "  ·  ", fg: theme.ignored },
      { text: formatBytes(this.current.size), fg: theme.muted },
    ]);
    this.hint.content = styled([{ text: "Scouter only displays UTF-8 text and images.", fg: theme.dim }]);
  }
}
