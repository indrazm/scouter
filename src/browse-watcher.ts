interface BrowseWatcherOptions {
  pollMs: number;
  isDestroyed(): boolean;
  refresh(): Promise<void>;
}

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

  stop(): Promise<void> {
    clearTimeout(this.timer);
    return this.queue;
  }
}
