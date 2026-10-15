import { describe, expect, it } from "vitest";
import type { SwarmState } from "../../../shared/types.ts";
import { parseSwarmState, ValidationError } from "../validation.ts";
import { JevResponseError, JevService, normalizeJevResponse, type JevResponse, type SystemOneCaller } from "./JevService.ts";
import { RequestBudget } from "./RequestBudget.ts";

const STATE: SwarmState = {
  swarm: { population: 1000, energy: 72, cohesion: 84, dispersion: 18, currentStrategy: "FLOCK", radius: 180 },
  environment: {
    threatCount: 3,
    nearestThreatDistance: 120,
    surrounded: false,
    dangerLevel: "high",
    threatsNearby: 2,
    threatsApproaching: 1,
    occupiedSectors: 3,
    nearestThreatIsolated: false,
    averageThreatStrength: 60,
  },
};

function response(overrides: Partial<Record<keyof JevResponse["answers"], unknown>> = {}): JevResponse {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 10, output_tokens: 3 },
    answers: {
      strategy: {
        type: "choice",
        choice: "DEFEND",
        confidence: 0.7,
        probabilities: { FLOCK: 0.02, FLIGHT: 0.18, ATTACK: 0.05, DEFEND: 0.7, SPLIT: 0.04, REGROUP: 0.01 },
      },
      urgency: { type: "score", score: 2.4, confidence: 0.6, legend: {}, probabilities: {} },
      conserveEnergy: { type: "noul", noul: 0.35 },
      ...overrides,
    },
  } as unknown as JevResponse;
}

describe("normalizeJevResponse", () => {
  it("takes every value verbatim from the API answer", () => {
    const d = normalizeJevResponse(response(), 210, 1234, "req_1");
    expect(d).toMatchObject({
      strategy: "DEFEND",
      strategyConfidence: 0.7,
      urgency: 2.4,
      urgencyConfidence: 0.6,
      conserveEnergyProbability: 0.35,
      latencyMs: 210,
      model: "jev-1.13.0",
      timestamp: 1234,
      source: "jev",
      requestId: "req_1",
    });
    expect(d.strategyProbabilities.FLIGHT).toBe(0.18);
    expect(d.normalizedUrgency).toBeCloseTo(0.8);
  });

  it("rejects an unknown strategy label", () => {
    const bad = response({ strategy: { type: "choice", choice: "PANIC", confidence: 1, probabilities: {} } });
    expect(() => normalizeJevResponse(bad, 0, 0)).toThrow(JevResponseError);
  });

  it("rejects missing probabilities instead of inventing them", () => {
    const bad = response({
      strategy: { type: "choice", choice: "FLOCK", confidence: 0.9, probabilities: { FLOCK: 0.9 } },
    });
    expect(() => normalizeJevResponse(bad, 0, 0)).toThrow(/probabilities\.FLIGHT/);
  });

  it("rejects urgency outside the 0–3 rubric", () => {
    const bad = response({ urgency: { type: "score", score: 3.5, confidence: 0.5, legend: {}, probabilities: {} } });
    expect(() => normalizeJevResponse(bad, 0, 0)).toThrow(/out of range/);
  });

  it("rejects a non-probability noul", () => {
    expect(() => normalizeJevResponse(response({ conserveEnergy: { type: "noul", noul: 1.4 } }), 0, 0)).toThrow(JevResponseError);
  });
});

describe("JevService", () => {
  it("is unconfigured without an API key", () => {
    expect(new JevService({ apiKey: "  " }).configured).toBe(false);
  });

  it("sends state plus all three questions in one call and measures latency", async () => {
    const calls: unknown[] = [];
    const caller: SystemOneCaller = {
      systemOne(request) {
        calls.push(request);
        return { withResponse: async () => ({ data: response(), requestId: "req_x" }) };
      },
    };
    const service = new JevService({ caller });
    const d = await service.decide(STATE);
    expect(calls).toHaveLength(1);
    const req = calls[0] as { state: SwarmState; questions: Record<string, { type: string }> };
    expect(req.state).toEqual(STATE);
    expect(Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, q.type]))).toEqual({
      strategy: "choice",
      urgency: "score",
      conserveEnergy: "noul",
    });
    expect(d.requestId).toBe("req_x");
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("parseSwarmState", () => {
  it("accepts a valid state and drops unknown fields", () => {
    const parsed = parseSwarmState({ ...STATE, extra: "ignored", swarm: { ...STATE.swarm, secret: 1 } });
    expect(parsed).toEqual(STATE);
  });

  it("rejects bad enums and out-of-range numbers", () => {
    expect(() => parseSwarmState({ ...STATE, swarm: { ...STATE.swarm, currentStrategy: "DANCE" } })).toThrow(ValidationError);
    expect(() => parseSwarmState({ ...STATE, swarm: { ...STATE.swarm, energy: 400 } })).toThrow(ValidationError);
    expect(() => parseSwarmState({ swarm: STATE.swarm })).toThrow(ValidationError);
  });
});

describe("RequestBudget", () => {
  it("enforces per-minute and total limits", () => {
    let now = 0;
    const budget = new RequestBudget(2, 3, () => now);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false); // per-minute cap
    now = 61_000;
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false); // total cap
    expect(budget.status()).toMatchObject({ usedTotal: 3, limitTotal: 3 });
  });
});
