import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { styled, type Segment } from "./styled";
import { theme } from "./theme";

export interface HeaderBadge {
  text: string;
  /** `pill` is a solid state chip; `quiet` is plain, low-contrast text. */
  kind: "pill" | "quiet";
}

/**
 * One-line pane title: bright and bold when its pane is active, muted otherwise. Badges on the right
 * carry state such as wrapping.
 */
export class PaneHeader {
  readonly root: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly badges: TextRenderable;
  private titleText = "";
  private badgeList: HeaderBadge[] = [];
  private focused = false;
  private notice?: string;

  constructor(context: RenderContext, id: string) {
    this.root = new BoxRenderable(context, {
      id,
      height: 1,
      width: "100%",
      flexDirection: "row",
      flexShrink: 0,
      paddingRight: 1,
    });
    const text = (options: Record<string, unknown>): TextRenderable =>
      new TextRenderable(context, { height: 1, wrapMode: "none", selectable: false, ...options });
    this.title = text({ flexGrow: 1, flexShrink: 1, minWidth: 0 });
    this.badges = text({ flexShrink: 0, marginLeft: 1 });
    this.root.add(this.title);
    this.root.add(this.badges);
    this.render();
  }

  setTitle(title: string): void {
    this.titleText = title;
    this.render();
  }

  setBadges(badges: HeaderBadge[]): void {
    this.badgeList = badges;
    this.render();
  }

  setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.render();
  }

  /** An error about the last action, shown in place of the title until cleared. */
  setNotice(notice: string | undefined): void {
    if (notice === this.notice) return;
    this.notice = notice;
    this.render();
  }

  private render(): void {
    this.title.content = this.notice
      ? styled([{ text: this.notice, fg: theme.error, bold: true }])
      : styled([{ text: this.titleText, fg: this.focused ? theme.text : theme.muted, bold: this.focused }]);
    const segments: Segment[] = [];
    for (const badge of this.badgeList) {
      if (segments.length) segments.push({ text: " " });
      segments.push(
        badge.kind === "pill"
          ? { text: ` ${badge.text} `, fg: theme.accentInk, bg: theme.accent, bold: true }
          : { text: badge.text, fg: theme.dim },
      );
    }
    this.badges.content = styled(segments);
  }
}
