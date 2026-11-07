/** A place in the reader: a file and how far it was scrolled, in lines. */
export interface Jump {
  path: string;
  top: number;
}

const LIMIT = 100;

/**
 * Two stacks of places. Leaving a place for another one remembers it; going back or forward swaps it with the
 * place on the other stack. A new jump drops the forward stack, as in an editor.
 */
export class JumpHistory {
  private older: Jump[] = [];
  private newer: Jump[] = [];

  /** Remembers `here` before the reader moves away from it. Repeats of the newest entry are not kept. */
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
