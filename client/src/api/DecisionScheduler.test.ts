import { describe, expect, it } from "vitest";
import { STRATEGIES, type DecisionResult, type Strategy, type SwarmState } from "../../../shared/types.ts";
import { DecisionRequestError } from "./apiClient.ts";
import { DecisionScheduler, type SchedulerHooks } from "./DecisionScheduler.ts";

const STATE: SwarmState = {
  swarm: { population: 1000, energy: 80, cohesion: 80, dispersion: 5, currentStrategy: "FLOCK", radius: 180 },
  environment: {
    threatCount: 2,
    nearestThreatDistance: 150,
    surrounded: false,
    dangerLevel: "high",
    threatsNearby: 2,
    threatsApproaching: 1,
    occupiedSectors: 2,
    nearestThreatIsolated: false,
    averageThreatStrength: 60,
  },
};

function jev(strategy: Strategy, urgency = 1): DecisionResult {
  return {
    strategy,
    strategyProbabilities: Object.fromEntries(STRATEGIES.map((s) => [s, s === strategy ? 0.8 : 0.04])) as Record<Strategy, number>,
    strategyConfidence: 0.8,
    urgency,
    normalizedUrgency: urgency / 3,
    urgencyConfidence: 0.6,
    conserveEnergyProbability: 0.3,
    latencyMs: 200,
    model: "jev-1.13.0",
    timestamp: 0,
    source: "jev",
  };
}

/** Promise that the test resolves by hand, to control request timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(config = {}) {
  let now = 0;
  let current: Strategy = "FLOCK";
  const requests: ReturnType<typeof deferred<DecisionResult>>[] = [];
  const applied: DecisionResult[] = [];
  const shown: { d: DecisionResult; pending: boolean }[] = [];
  const errors: string[] = [];
  let state = STATE;
  const hooks: SchedulerHooks = {
    getState: () => state,
    currentStrategy: () => current,
    request: () => {
      const d = deferred<DecisionResult>();
      requests.push(d);
      return d.promise;
    },
    onRequest: () => {},
    onDecision: (d, pending) => shown.push({ d, pending }),
    apply: (d) => {
      applied.push(d);
      current = d.strategy;
    },
    onError: (m) => errors.push(m),
  };
  const scheduler = new DecisionScheduler(hooks, config, () => now);
  return {
    scheduler,
    requests,
    applied,
    shown,
    errors,
    advance: (ms: number) => (now += ms),
    setState: (s: SwarmState) => (state = s),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("DecisionScheduler", () => {
  it("keeps at most one request in flight and respects the interval", async () => {
    const t = setup();
    t.scheduler.update();
    t.advance(5000);
    t.scheduler.update();
    expect(t.requests).toHaveLength(1); // still in flight: no second request
    t.requests[0]!.resolve(jev("DEFEND"));
    await flush();
    t.scheduler.update(); // interval since the last request elapsed → next request
    expect(t.requests).toHaveLength(2);
    t.requests[1]!.resolve(jev("DEFEND"));
    await flush();
    t.advance(1000);
    t.scheduler.update();
    expect(t.requests).toHaveLength(2); // interval not elapsed yet
    t.advance(500);
    t.scheduler.update();
    expect(t.requests).toHaveLength(3);
  });

  it("does not request on every frame", () => {
    const t = setup();
    for (let frame = 0; frame < 60; frame++) {
      t.scheduler.update();
      t.advance(16);
    }
    expect(t.requests).toHaveLength(1);
  });

  it("fires again once the interval elapses", async () => {
    const t = setup();
    t.scheduler.update();
    t.requests[0]!.resolve(jev("DEFEND"));
    await flush();
    t.advance(1500);
    t.scheduler.update();
    expect(t.requests).toHaveLength(2);
  });

  it("re-evaluates on events after the lock period only", async () => {
    const t = setup({ eventLockMs: 600 });
    t.scheduler.update();
    t.requests[0]!.resolve(jev("FLOCK"));
    await flush();
    t.scheduler.notifyEvent();
    t.advance(300);
    t.scheduler.update();
    expect(t.requests).toHaveLength(1);
    t.advance(300);
    t.scheduler.update();
    expect(t.requests).toHaveLength(2);
  });

  it("holds strategy switches during the cooldown and applies them afterwards", async () => {
    const t = setup({ cooldownMs: 2000, urgentCooldownMs: 2000 });
    t.scheduler.update();
    t.requests[0]!.resolve(jev("DEFEND"));
    await flush();
    expect(t.applied.map((d) => d.strategy)).toEqual(["DEFEND"]);

    t.advance(1500);
    t.scheduler.update();
    t.requests[1]!.resolve(jev("FLIGHT"));
    await flush();
    expect(t.shown.at(-1)).toMatchObject({ pending: true });
    expect(t.applied).toHaveLength(1);

    t.advance(600);
    t.scheduler.update();
    expect(t.applied.map((d) => d.strategy)).toEqual(["DEFEND", "FLIGHT"]);
  });

  it("ignores responses that arrive after a reset", async () => {
    const t = setup();
    t.scheduler.update();
    t.scheduler.invalidate();
    t.requests[0]!.resolve(jev("ATTACK"));
    await flush();
    expect(t.applied).toHaveLength(0);
  });

  it("falls back to labelled local rules on errors and backs off", async () => {
    const t = setup({ errorBackoffMs: [3000] });
    t.scheduler.update();
    t.requests[0]!.reject(new DecisionRequestError("Jev returned HTTP 500", "jev_error"));
    await flush();
    expect(t.errors).toEqual(["Jev returned HTTP 500"]);
    expect(t.applied.at(-1)?.source).toBe("simulation");
    expect(t.scheduler.fallbackActive).toBe(true);

    t.advance(1500);
    t.scheduler.update();
    expect(t.requests).toHaveLength(1); // still backing off: no new API call
    expect(t.applied.at(-1)?.source).toBe("simulation");

    t.advance(1600);
    t.scheduler.update();
    expect(t.requests).toHaveLength(2);
  });

  it("stops calling the API once the per-minute budget is spent", async () => {
    const t = setup({ maxRequestsPerMinute: 2, intervalMs: 1000 });
    for (let i = 0; i < 4; i++) {
      t.scheduler.update();
      t.requests.at(-1)?.resolve(jev("DEFEND"));
      await flush();
      t.advance(1000);
    }
    expect(t.requests).toHaveLength(2);
    expect(t.errors[0]).toMatch(/budget/i);
  });

  it("slows down while idle", async () => {
    const t = setup({ intervalMs: 1500, idleIntervalMs: 6000 });
    t.setState({ ...STATE, environment: { ...STATE.environment, threatCount: 0 } });
    t.scheduler.update();
    t.requests[0]!.resolve(jev("FLOCK"));
    await flush();
    t.advance(2000);
    t.scheduler.update();
    expect(t.requests).toHaveLength(1);
    t.advance(4500);
    t.scheduler.update();
    expect(t.requests).toHaveLength(2);
  });
});
