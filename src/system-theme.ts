import { modeOfBackground, type ThemeMode } from "./theme";

/** What the terminal looks like now. The background is unknown when the terminal does not answer for its colours. */
export interface SystemTheme {
  mode: ThemeMode;
  background?: string;
}

export interface ThemeSource {
  readonly themeMode: ThemeMode | null;
  on(event: "theme_mode", listener: (mode: ThemeMode) => void): unknown;
  off(event: "theme_mode", listener: (mode: ThemeMode) => void): unknown;
  clearPaletteCache(): void;
  getPalette(options: { size: number; timeout: number }): Promise<{ defaultBackground: string | null }>;
}

/** How often the terminal's background is asked for, for terminals that do not announce a change by themselves. */
const POLL_MS = 3000;
const QUERY_TIMEOUT_MS = 500;

/**
 * Follows the terminal between light and dark. A terminal that announces changes is listened to; for the rest the
 * background is polled, but only if the terminal answered the first time. `onChange` gets the first reading and every
 * later one that differs.
 */
export class SystemThemeWatcher {
  private last?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  /** The terminal has announced a change, so it will announce the next one and asking is no longer needed. */
  private announces = false;
  /** Numbers the checks, so a slow answer that arrives after a newer one is not mistaken for the latest. */
  private latest = 0;

  constructor(
    private readonly source: ThemeSource,
    private readonly onChange: (theme: SystemTheme) => void,
    private readonly pollMs = POLL_MS,
  ) {}

  start(): void {
    this.source.on("theme_mode", this.onAnnounce);
    void this.poll(true);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.source.off("theme_mode", this.onAnnounce);
  }

  /** The renderer clears its own cache when a terminal announces a change, so what it has is already fresh. */
  private readonly onAnnounce = (mode: ThemeMode): void => {
    this.announces = true;
    clearTimeout(this.timer);
    void this.check(mode, false);
  };

  private async poll(first: boolean): Promise<void> {
    if (this.stopped) return;
    const answered = await this.check(this.source.themeMode ?? undefined, !first);
    if (!answered || this.stopped || this.announces) return;
    this.timer = setTimeout(() => void this.poll(false), this.pollMs);
    this.timer.unref?.();
  }

  /** True when the terminal gave a background. The renderer caches colours, so later polls clear the cache first. */
  private async check(hint: ThemeMode | undefined, fresh: boolean): Promise<boolean> {
    const reading = ++this.latest;
    const background = await this.readBackground(fresh);
    const answered = background !== undefined;
    if (this.stopped || reading !== this.latest) return answered;
    // The first reading is always reported, as dark when the terminal says nothing, so the tint is always applied.
    const mode = background ? modeOfBackground(background) : (hint ?? (this.last === undefined ? "dark" : undefined));
    if (!mode) return answered;
    const key = `${mode}:${background ?? ""}`;
    if (key !== this.last) {
      this.last = key;
      this.onChange({ mode, ...(background ? { background } : {}) });
    }
    return answered;
  }

  private async readBackground(fresh: boolean): Promise<string | undefined> {
    try {
      if (fresh) this.source.clearPaletteCache();
      const colors = await this.source.getPalette({ size: 1, timeout: QUERY_TIMEOUT_MS });
      return colors.defaultBackground || undefined;
    } catch {
      return undefined;
    }
  }
}
