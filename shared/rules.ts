import { STRATEGIES, type DecisionResult, type Strategy, type SwarmState } from "./types.ts";

/**
 * Deterministic rule engine used when Jev is not configured or unreachable.
 * Its output is always tagged `source: "simulation"` and carries no confidences,
 * so the HUD can never mistake it for a Jev answer.
 */
export function ruleBasedDecision(state: SwarmState, now: number = Date.now()): DecisionResult {
  const { swarm, environment: env } = state;
  const strategy = pickStrategy(state);
  const urgency = urgencyLevel(state);
  // Rule output, not a probability: 1 = conserve, 0.6 = lean towards conserving, 0 = spend freely.
  const conserve = swarm.energy < 30 ? 1 : swarm.energy < 55 && env.dangerLevel !== "critical" ? 0.6 : 0;

  const strategyProbabilities = Object.fromEntries(
    STRATEGIES.map((s) => [s, s === strategy ? 1 : 0]),
  ) as Record<Strategy, number>;

  return {
    strategy,
    strategyProbabilities,
    strategyConfidence: null,
    urgency,
    normalizedUrgency: urgency / 3,
    urgencyConfidence: null,
    conserveEnergyProbability: conserve,
    latencyMs: 0,
    model: "local-rules",
    timestamp: now,
    source: "simulation",
  };
}

export function pickStrategy(state: SwarmState): Strategy {
  const { swarm, environment: env } = state;

  if (env.threatCount === 0) {
    // Threats gone: pull stragglers back before resuming the flock.
    return swarm.cohesion < 55 || swarm.currentStrategy === "SPLIT" || swarm.currentStrategy === "FLIGHT"
      ? "REGROUP"
      : "FLOCK";
  }
  if (swarm.energy < 25 && env.dangerLevel !== "low") return "FLIGHT";
  if (env.surrounded || env.occupiedSectors >= 4) return env.threatCount >= 6 ? "SPLIT" : "DEFEND";
  if (env.nearestThreatIsolated && swarm.energy >= 45 && env.threatCount <= 2) return "ATTACK";
  if (env.dangerLevel === "critical" || env.dangerLevel === "high") return "DEFEND";
  if (swarm.cohesion < 45) return "REGROUP";
  return "FLOCK";
}

export function urgencyLevel(state: SwarmState): number {
  switch (state.environment.dangerLevel) {
    case "none":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}
