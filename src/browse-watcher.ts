interface BrowseWatcherOptions {
  pollMs: number;
  isDestroyed(): boolean;
  /** Must not throw. */
  refresh(): Promise<void>;
}

/** Runs refreshes one after another, on request and on a timer, so a slow one never overlaps the next. */
export class BrowseWatcher {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: BrowseWatcherOptions) {}

  refresh(): Promise<void> {
    this.queue = this.queue.then(() => this.options.refresh());
    return this.queue;
  }

  start(): void {
    this.timer = setTimeout(() => {
      void this.refresh().then(() => {
        if (!this.options.isDestroyed()) this.start();
      });
    }, this.options.pollMs);
    this.timer.unref?.();
  }

  /** Resolves once the refresh in progress, if any, has finished. */
  stop(): Promise<void> {
    clearTimeout(this.timer);
    return this.queue;
  }
}
