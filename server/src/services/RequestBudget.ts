import type { BudgetStatus } from "../../../shared/types.ts";

/** Caps Jev calls per rolling minute and per server lifetime so a demo can't run up costs. */
export class RequestBudget {
  readonly #limitPerMinute: number;
  readonly #limitTotal: number;
  readonly #now: () => number;
  #usedTotal = 0;
  #recent: number[] = [];

  constructor(limitPerMinute: number, limitTotal: number, now: () => number = Date.now) {
    this.#limitPerMinute = limitPerMinute;
    this.#limitTotal = limitTotal;
    this.#now = now;
  }

  /** Reserves one request; returns false when a limit is reached. */
  tryConsume(): boolean {
    this.#prune();
    if (this.#usedTotal >= this.#limitTotal || this.#recent.length >= this.#limitPerMinute) return false;
    this.#usedTotal++;
    this.#recent.push(this.#now());
    return true;
  }

  status(): BudgetStatus {
    this.#prune();
    return {
      usedTotal: this.#usedTotal,
      limitTotal: this.#limitTotal,
      usedLastMinute: this.#recent.length,
      limitPerMinute: this.#limitPerMinute,
    };
  }

  #prune(): void {
    const cutoff = this.#now() - 60_000;
    while (this.#recent.length > 0 && this.#recent[0]! <= cutoff) this.#recent.shift();
  }
}
