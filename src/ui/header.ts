import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { styled } from "./styled";
import { theme } from "./theme";
import type { HeaderBadge, Segment } from "./types";

export class PaneHeader {
  readonly root: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly badges: TextRenderable;
  private titleText = "";
  private parentText?: string;
  private badgeList: HeaderBadge[] = [];
  private focused = false;
  private notice?: string;

  constructor(context: RenderContext, id: string) {
    this.root = new BoxRenderable(context, {
      id,
      height: 2,
      width: "100%",
      flexDirection: "row",
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      border: ["bottom"],
      borderColor: theme.border,
    });
    const text = (options: Record<string, unknown>): TextRenderable =>
      new TextRenderable(context, { height: 1, wrapMode: "none", selectable: false, ...options });
    this.title = text({ flexGrow: 1, flexShrink: 1, minWidth: 0 });
    this.badges = text({ flexShrink: 0, marginLeft: 1 });
    this.root.add(this.title);
    this.root.add(this.badges);
    this.render();
  }

  setTitle(title: string, parent?: string): void {
    if (title === this.titleText && parent === this.parentText) return;

    this.titleText = title;
    this.parentText = parent;
    this.render();
  }

  setBadges(badges: HeaderBadge[]): void {
    if (
      badges.length === this.badgeList.length &&
      badges.every(
        (badge, index) => badge.text === this.badgeList[index]?.text && badge.kind === this.badgeList[index]?.kind,
      )
    ) {
      return;
    }

    this.badgeList = badges;
    this.render();
  }

  setFocused(focused: boolean): void {
    if (focused === this.focused) return;

    this.focused = focused;
    this.render();
  }

  setNotice(notice: string | undefined): void {
    if (notice === this.notice) return;

    this.notice = notice;
    this.render();
  }

  restyle(): void {
    this.root.borderColor = theme.border;
    this.render();
  }

  private render(): void {
    const parts: Segment[] = [];

    if (this.parentText) parts.push({ text: this.parentText, fg: theme.dim });

    parts.push({ text: this.titleText, fg: this.focused ? theme.text : theme.muted, bold: this.focused });
    this.title.content = styled(parts);

    if (this.notice) {
      this.badges.content = styled([{ text: this.notice, fg: theme.error, bold: true }]);
      return;
    }

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
