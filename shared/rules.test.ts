import { describe, expect, it } from "vitest";
import { ruleBasedDecision } from "./rules.ts";
import type { SwarmState } from "./types.ts";

function state(overrides: { swarm?: Partial<SwarmState["swarm"]>; environment?: Partial<SwarmState["environment"]> } = {}): SwarmState {
  return {
    swarm: { population: 1000, energy: 80, cohesion: 85, dispersion: 5, currentStrategy: "FLOCK", radius: 180, ...overrides.swarm },
    environment: {
      threatCount: 0,
      nearestThreatDistance: null,
      surrounded: false,
      dangerLevel: "none",
      threatsNearby: 0,
      threatsApproaching: 0,
      occupiedSectors: 0,
      nearestThreatIsolated: false,
      averageThreatStrength: 0,
      ...overrides.environment,
    },
  };
}

describe("ruleBasedDecision", () => {
  it("flocks when nothing threatens the swarm", () => {
    expect(ruleBasedDecision(state()).strategy).toBe("FLOCK");
  });

  it("regroups once threats are gone but the swarm is still dispersed", () => {
    expect(ruleBasedDecision(state({ swarm: { cohesion: 30, currentStrategy: "SPLIT" } })).strategy).toBe("REGROUP");
  });

  it("defends against a single close threat", () => {
    const s = state({ environment: { threatCount: 2, dangerLevel: "high", threatsNearby: 2, nearestThreatDistance: 80, occupiedSectors: 2 } });
    expect(ruleBasedDecision(s).strategy).toBe("DEFEND");
  });

  it("attacks an isolated threat when energy allows", () => {
    const s = state({ environment: { threatCount: 1, dangerLevel: "medium", nearestThreatIsolated: true, occupiedSectors: 1 } });
    expect(ruleBasedDecision(s).strategy).toBe("ATTACK");
  });

  it("splits when surrounded by many threats", () => {
    const s = state({ environment: { threatCount: 12, dangerLevel: "critical", surrounded: true, occupiedSectors: 7, threatsNearby: 8 } });
    expect(ruleBasedDecision(s).strategy).toBe("SPLIT");
  });

  it("flees when energy is nearly depleted", () => {
    const s = state({ swarm: { energy: 12 }, environment: { threatCount: 3, dangerLevel: "high" } });
    expect(ruleBasedDecision(s).strategy).toBe("FLIGHT");
  });

  it("is labelled as simulation and never reports confidences", () => {
    const d = ruleBasedDecision(state());
    expect(d.source).toBe("simulation");
    expect(d.model).toBe("local-rules");
    expect(d.strategyConfidence).toBeNull();
    expect(d.urgencyConfidence).toBeNull();
    expect(Object.values(d.strategyProbabilities).filter((p) => p === 1)).toHaveLength(1);
  });

  it("maps danger levels onto the 0–3 urgency rubric", () => {
    expect(ruleBasedDecision(state({ environment: { threatCount: 1, dangerLevel: "low" } })).urgency).toBe(1);
    const critical = ruleBasedDecision(state({ environment: { threatCount: 9, dangerLevel: "critical" } }));
    expect(critical.urgency).toBe(3);
    expect(critical.normalizedUrgency).toBe(1);
  });
});
