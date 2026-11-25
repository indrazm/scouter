import { basename, posix } from "node:path";
import { displayLabel, treeRelative } from "../core/files";
import type { DiffState } from "../diff/types";
import type { DiffInfo, HeaderBadge } from "../ui/types";
import type { HeaderTitle, Shown } from "./types";

export function titleParts(rootPath: string | undefined, path: string): HeaderTitle {
  const title = displayLabel(basename(path));

  if (!rootPath) return { title };

  const relative = treeRelative(rootPath, path);

  if (!relative || relative.startsWith("../")) return { title };

  const folder = posix.dirname(relative);
  return folder === "." ? { title } : { title, parent: `${displayLabel(folder)}/` };
}

export function sidebarHeaderFor(
  rootPath: string | undefined,
  diffState?: DiffState,
): { title: string; badges: HeaderBadge[] } {
  if (diffState) {
    const count = `${diffState.files}${diffState.truncated ? "+" : ""}`;
    return { title: "Changes", badges: [{ text: count, kind: "quiet" }] };
  }

  return {
    title: rootPath ? displayLabel(basename(rootPath)) : "Files",
    badges: [{ text: "files", kind: "quiet" }],
  };
}

export function viewerHeaderFor(
  previewPath: string | undefined,
  rootPath: string | undefined,
  shown: Shown,
  diffState?: DiffState,
): HeaderTitle {
  if (previewPath !== undefined) return titleParts(rootPath, previewPath);

  if (!diffState) {
    if (shown.kind === "none") return { title: "Reader" };

    const path = shown.kind === "text" ? shown.document.path : shown.path;
    return titleParts(rootPath, path);
  }

  const selected = diffState.selected;

  if (!selected) return { title: "Changes" };

  const folder = posix.dirname(selected.path);
  return {
    title: displayLabel(basename(selected.path)),
    parent: folder === "." ? undefined : `${displayLabel(folder)}/`,
  };
}

export function viewerBadgesFor(
  shown: Shown,
  wrap: boolean,
  previewing: boolean,
  diffState?: DiffState,
): HeaderBadge[] {
  const badges: HeaderBadge[] = [];

  if (diffState) {
    if (diffState.selected) badges.push({ text: diffState.selected.kind, kind: "quiet" });

    badges.push({ text: diffState.scope === "all" ? "all files" : "one file", kind: "quiet" });

    if (diffState.view === "split") badges.push({ text: "split", kind: "pill" });

    if (diffState.expandedContext) badges.push({ text: "wide context", kind: "pill" });
  } else {
    badges.push({ text: "read-only", kind: "quiet" });
  }

  const hasDocument = shown.kind === "text" || shown.kind === "image";
  const isImage = shown.kind === "image";
  const isBinary = shown.kind === "binary";
  const rendered = !diffState && hasDocument && previewing;

  if (rendered) badges.push({ text: "rendered", kind: "quiet" });

  if (!diffState && isImage) badges.push({ text: "image", kind: "quiet" });

  if (!diffState && isBinary) badges.push({ text: "binary", kind: "quiet" });

  if (!diffState && shown.kind === "text" && shown.document.truncated) {
    badges.push({ text: "first 1 MiB", kind: "pill" });
  }

  if (wrap && !rendered && !isImage && !isBinary) badges.push({ text: "wrap", kind: "pill" });

  return badges;
}

export function diffFooterFor(state: DiffState): DiffInfo {
  return {
    location: state.selected?.path ?? state.repository,
    files: state.files,
    truncated: state.truncated,
    scope: state.scope,
    ...state.patch,
  };
}

export function formatScrollPosition(scrollHeight: number, viewportHeight: number, scrollTop: number): string {
  const range = scrollHeight - viewportHeight;
  return range <= 0
    ? "All"
    : scrollTop <= 0
      ? "Top"
      : scrollTop >= range
        ? "Bot"
        : `${Math.round((scrollTop / range) * 100)}%`;
}
