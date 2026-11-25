import type { Jump } from "./types";

const LIMIT = 100;

export class JumpHistory {
  private older: Jump[] = [];
  private newer: Jump[] = [];

  leave(here: Jump | undefined): void {
    this.newer = [];

    if (!here) return;

    const last = this.older.at(-1);

    if (last?.path === here.path && last.top === here.top) return;

    this.older.push(here);

    if (this.older.length > LIMIT) this.older.shift();
  }

  back(here: Jump | undefined): Jump | undefined {
    const target = this.older.pop();

    if (target && here) this.newer.push(here);

    return target;
  }

  forward(here: Jump | undefined): Jump | undefined {
    const target = this.newer.pop();

    if (target && here) this.older.push(here);

    return target;
  }

  get canGoBack(): boolean {
    return this.older.length > 0;
  }

  get canGoForward(): boolean {
    return this.newer.length > 0;
  }
}
