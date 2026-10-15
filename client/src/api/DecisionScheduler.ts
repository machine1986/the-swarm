import { ruleBasedDecision } from "../../../shared/rules.ts";
import type { DecisionResult, Strategy, SwarmState } from "../../../shared/types.ts";
import { DecisionRequestError } from "./apiClient.ts";

export interface SchedulerConfig {
  /** Regular decision cadence. */
  intervalMs: number;
  /** Cadence while nothing is happening (no threats, flocking) — saves requests. */
  idleIntervalMs: number;
  /** Minimum gap before an event may trigger an immediate re-evaluation. */
  eventLockMs: number;
  /** Minimum time between strategy switches. */
  cooldownMs: number;
  /** Shorter cooldown when Jev reports high urgency (normalized ≥ 0.67). */
  urgentCooldownMs: number;
  requestTimeoutMs: number;
  /** Client-side cap; the server enforces its own budget as well. */
  maxRequestsPerMinute: number;
  /** Pause before retrying the API after consecutive failures (no unbounded retries). */
  errorBackoffMs: readonly number[];
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  intervalMs: 1500,
  idleIntervalMs: 6000,
  eventLockMs: 650,
  cooldownMs: 2400,
  urgentCooldownMs: 1000,
  requestTimeoutMs: 8000,
  maxRequestsPerMinute: 40,
  errorBackoffMs: [3000, 6000, 15000, 30000],
};

export interface SchedulerHooks {
  getState(): SwarmState;
  currentStrategy(): Strategy;
  request(state: SwarmState, signal: AbortSignal): Promise<DecisionResult>;
  onRequest(state: SwarmState): void;
  /** A decision arrived (shown in the HUD); `pending` while the switch waits for its cooldown. */
  onDecision(decision: DecisionResult, pending: boolean): void;
  /** Hand the decision to the simulation. */
  apply(decision: DecisionResult): void;
  onError(message: string): void;
}

/**
 * Runs AI decisions beside the render loop: at most one request in flight, a fixed cadence,
 * event-triggered re-evaluation with a lock period, strategy cooldowns, stale-response
 * rejection, a request budget and a local rule-engine fallback while the API is unavailable.
 */
export class DecisionScheduler {
  enabled = true;
  readonly config: SchedulerConfig;
  readonly #hooks: SchedulerHooks;
  readonly #now: () => number;

  #generation = 0;
  #inFlight: AbortController | null = null;
  #lastRequestAt = -Infinity;
  #lastSwitchAt = -Infinity;
  #eventPending = false;
  #pending: DecisionResult | null = null;
  #recent: number[] = [];
  #consecutiveErrors = 0;
  #backoffUntil = -Infinity;
  lastError: string | null = null;

  constructor(hooks: SchedulerHooks, config: Partial<SchedulerConfig> = {}, now: () => number = () => performance.now()) {
    this.#hooks = hooks;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.#now = now;
  }

  get inFlight(): boolean {
    return this.#inFlight !== null;
  }

  /** True while decisions come from the local fallback instead of the API. */
  get fallbackActive(): boolean {
    return this.#now() < this.#backoffUntil;
  }

  get requestsLastMinute(): number {
    this.#pruneBudget(this.#now());
    return this.#recent.length;
  }

  /** Something relevant happened (threat spawned/destroyed, chaos…): re-evaluate soon. */
  notifyEvent(): void {
    this.#eventPending = true;
  }

  /** Drop everything in flight or queued, e.g. after a reset. Late responses are ignored. */
  invalidate(): void {
    this.#generation++;
    this.#inFlight?.abort();
    this.#inFlight = null;
    this.#pending = null;
    this.#eventPending = false;
    this.#lastRequestAt = -Infinity;
    this.#lastSwitchAt = -Infinity;
  }

  /** Clear the error backoff so the next cycle tries the API again. */
  retryNow(): void {
    this.#consecutiveErrors = 0;
    this.#backoffUntil = -Infinity;
    this.lastError = null;
    this.#eventPending = true;
  }

  /** Call once per frame. Cheap when nothing is due. */
  update(): void {
    const now = this.#now();
    if (this.#pending && now - this.#lastSwitchAt >= this.#cooldownFor(this.#pending)) {
      const decision = this.#pending;
      this.#pending = null;
      this.#applyNow(decision, now);
    }
    if (!this.enabled || this.#inFlight) return;

    const since = now - this.#lastRequestAt;
    const due = this.#eventPending ? since >= this.config.eventLockMs : since >= this.config.intervalMs;
    if (!due) return;

    const state = this.#hooks.getState();
    const idle = state.environment.threatCount === 0 && state.swarm.currentStrategy === "FLOCK";
    if (!this.#eventPending && idle && since < this.config.idleIntervalMs) return;

    this.#eventPending = false;
    this.#lastRequestAt = now;

    if (now >= this.#backoffUntil && !this.#takeBudget(now)) {
      this.#backoffUntil = this.#recent[0]! + 60_000;
      this.lastError = `Request budget reached (${this.config.maxRequestsPerMinute}/min)`;
      this.#hooks.onError(this.lastError);
    }
    if (now < this.#backoffUntil) {
      // API paused (errors or budget): keep the swarm responsive with clearly-labelled local rules.
      this.#deliver(ruleBasedDecision(state), now);
      return;
    }
    void this.#request(state);
  }

  async #request(state: SwarmState): Promise<void> {
    const generation = this.#generation;
    const controller = new AbortController();
    this.#inFlight = controller;
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    this.#hooks.onRequest(state);
    try {
      const decision = await this.#hooks.request(state, controller.signal);
      if (generation !== this.#generation) return; // stale: the world was reset meanwhile
      this.#consecutiveErrors = 0;
      this.lastError = null;
      this.#deliver(decision, this.#now());
    } catch (err) {
      if (generation !== this.#generation) return;
      const message = err instanceof Error ? err.message : String(err);
      const budget = err instanceof DecisionRequestError && err.code === "budget_exhausted";
      const steps = this.config.errorBackoffMs;
      const wait = budget ? steps[steps.length - 1]! : steps[Math.min(this.#consecutiveErrors, steps.length - 1)]!;
      this.#consecutiveErrors++;
      this.#backoffUntil = this.#now() + wait;
      this.lastError = message;
      this.#hooks.onError(message);
      this.#deliver(ruleBasedDecision(state), this.#now());
    } finally {
      clearTimeout(timer);
      if (this.#inFlight === controller) this.#inFlight = null;
    }
  }

  #deliver(decision: DecisionResult, now: number): void {
    const switching = decision.strategy !== this.#hooks.currentStrategy();
    if (!switching || now - this.#lastSwitchAt >= this.#cooldownFor(decision)) {
      this.#pending = null;
      this.#hooks.onDecision(decision, false);
      this.#applyNow(decision, now);
    } else {
      this.#pending = decision;
      this.#hooks.onDecision(decision, true);
    }
  }

  #applyNow(decision: DecisionResult, now: number): void {
    if (decision.strategy !== this.#hooks.currentStrategy()) this.#lastSwitchAt = now;
    this.#hooks.apply(decision);
  }

  #cooldownFor(decision: DecisionResult): number {
    return decision.normalizedUrgency >= 0.67 ? this.config.urgentCooldownMs : this.config.cooldownMs;
  }

  #takeBudget(now: number): boolean {
    this.#pruneBudget(now);
    if (this.#recent.length >= this.config.maxRequestsPerMinute) return false;
    this.#recent.push(now);
    return true;
  }

  #pruneBudget(now: number): void {
    while (this.#recent.length > 0 && this.#recent[0]! <= now - 60_000) this.#recent.shift();
  }
}
