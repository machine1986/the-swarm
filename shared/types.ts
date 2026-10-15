// Types shared by client and server. Kept free of runtime dependencies so both
// Vite and Node's native TypeScript support can import them directly.

export const STRATEGIES = ["FLOCK", "FLIGHT", "ATTACK", "DEFEND", "SPLIT", "REGROUP"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const DANGER_LEVELS = ["none", "low", "medium", "high", "critical"] as const;
export type DangerLevel = (typeof DANGER_LEVELS)[number];

/** Compact swarm description sent to Jev. Never contains individual particle positions. */
export interface SwarmState {
  swarm: {
    /** Living individuals. */
    population: number;
    /** Collective energy reserve, 0–100. */
    energy: number;
    /** How tightly the swarm holds together, 0–100. */
    cohesion: number;
    /** How spread out the swarm is, 0–100. */
    dispersion: number;
    currentStrategy: Strategy;
    /** Radius around the swarm centre holding most individuals, in world units. */
    radius: number;
  };
  environment: {
    threatCount: number;
    /** Distance from swarm centre to nearest threat edge in world units; null without threats. */
    nearestThreatDistance: number | null;
    /** Threats occupy at least half of the eight compass sectors around the swarm. */
    surrounded: boolean;
    dangerLevel: DangerLevel;
    /** Threats within 350 world units of the swarm centre. */
    threatsNearby: number;
    /** Threats moving towards the swarm. */
    threatsApproaching: number;
    /** Compass sectors (of 8) around the swarm that contain a threat. */
    occupiedSectors: number;
    /** The nearest threat has no other threat within 260 world units. */
    nearestThreatIsolated: boolean;
    /** Mean threat strength, 0–100. */
    averageThreatStrength: number;
  };
}

export type DecisionSource = "jev" | "simulation" | "replay";

export interface DecisionResult {
  strategy: Strategy;
  /**
   * Live mode: Jev's probability per strategy, taken verbatim from the API.
   * Simulation mode: one-hot rule output (1 for the chosen rule), never presented as probabilities.
   */
  strategyProbabilities: Record<Strategy, number>;
  /** Jev's reported confidence; null when the rule engine decided. */
  strategyConfidence: number | null;
  /** Expected rubric level, 0–3 (may be fractional for Jev). */
  urgency: number;
  normalizedUrgency: number;
  urgencyConfidence: number | null;
  /** Probability that energy conservation should take priority, 0–1. */
  conserveEnergyProbability: number;
  latencyMs: number;
  /** Resolved model name for Jev, or "local-rules". */
  model: string;
  /** Epoch milliseconds when the decision was produced. */
  timestamp: number;
  source: DecisionSource;
  /** TypeSafe request id, when available. */
  requestId?: string;
}

export type OperatingMode = "live" | "simulation";

export interface BudgetStatus {
  usedTotal: number;
  limitTotal: number;
  usedLastMinute: number;
  limitPerMinute: number;
}

export interface StatusResponse {
  ok: true;
  jevConfigured: boolean;
  mode: OperatingMode;
  model: string;
  budget: BudgetStatus;
}

export interface ApiErrorBody {
  error: string;
  code: "invalid_state" | "budget_exhausted" | "jev_unavailable" | "jev_error" | "timeout" | "internal";
}
