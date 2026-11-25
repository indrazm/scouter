import { modeOfBackground, type ThemeMode } from "./theme";

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

const POLL_MS = 3000;
const QUERY_TIMEOUT_MS = 500;

export class SystemThemeWatcher {
  private last?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private announces = false;
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

  private async check(hint: ThemeMode | undefined, fresh: boolean): Promise<boolean> {
    const reading = ++this.latest;
    const background = await this.readBackground(fresh);
    const answered = background !== undefined;

    if (this.stopped || reading !== this.latest) return answered;

    const mode = background ? modeOfBackground(background) : (hint ?? (this.last === undefined ? "dark" : undefined));

    if (!mode) return answered;

    const key = `${mode}:${background ?? ""}`;

    if (key !== this.last) {
      this.last = key;
      const next: SystemTheme = { mode };

      if (background) next.background = background;

      this.onChange(next);
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
