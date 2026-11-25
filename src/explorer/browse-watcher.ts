const MAX_POLL_MS = 30_000;

export interface RefreshOptions {
  marksOnly?: boolean;
}

interface BrowseWatcherOptions {
  pollMs: number;
  isDestroyed(): boolean;
  refresh(options?: RefreshOptions): Promise<void>;
}

export class BrowseWatcher {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: BrowseWatcherOptions) {}

  refresh(options?: RefreshOptions): Promise<void> {
    this.queue = this.queue.then(() => this.options.refresh(options));
    return this.queue;
  }

  start(delay = this.options.pollMs): void {
    this.timer = setTimeout(() => {
      let elapsed = 0;
      const run = async (): Promise<void> => {
        const started = performance.now();
        try {
          await this.options.refresh();
        } finally {
          elapsed = performance.now() - started;
        }
      };
      this.queue = this.queue.then(run);
      void this.queue.then(() => {
        if (!this.options.isDestroyed()) {
          const next = Math.min(Math.max(MAX_POLL_MS, this.options.pollMs), Math.max(this.options.pollMs, elapsed * 3));
          this.start(next);
        }
      });
    }, delay);
    this.timer.unref?.();
  }

  stop(): Promise<void> {
    clearTimeout(this.timer);
    return this.queue;
  }
}
