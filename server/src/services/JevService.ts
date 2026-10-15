import { choice, noul, score, TypeSafeClient, type SystemOneResult } from "@typesafe-ai/sdk";
import { STRATEGIES, type DecisionResult, type Strategy, type SwarmState } from "../../../shared/types.ts";

export const JEV_MODEL = "jev-latest";

/** The three independent questions Jev answers against the same swarm state. */
export const QUESTIONS = {
  strategy: choice("Which swarm behavior is most appropriate to respond to the current environment?", {
    FLOCK: "Maintain natural collective movement when no immediate tactical response is necessary.",
    FLIGHT: "Escape a dangerous situation by moving away from nearby threats.",
    ATTACK: "Concentrate forces to neutralize an isolated or vulnerable threat.",
    DEFEND: "Protect the swarm by forming a defensive ring or barrier.",
    SPLIT: "Divide the swarm into independent groups to handle threats from multiple directions.",
    REGROUP: "Bring dispersed individuals back together to restore collective cohesion.",
  }),
  urgency: score("How urgently does the swarm need to react to the current threat situation?", [
    "No immediate danger; normal movement is sufficient.",
    "Potential danger exists but threats are distant.",
    "Threats are approaching and require a response.",
    "Immediate danger; rapid defensive or evasive action is necessary.",
  ]),
  conserveEnergy: noul(
    "Given the current state, conserving the swarm's remaining energy should take priority over aggressive movement.",
  ),
};

export type JevResponse = SystemOneResult<typeof QUESTIONS>;

/** The subset of TypeSafeClient the service needs; lets tests inject a fake. */
export interface SystemOneCaller {
  systemOne(
    request: { state: SwarmState; questions: typeof QUESTIONS },
    options: { signal?: AbortSignal; timeout: number },
  ): { withResponse(): Promise<{ data: JevResponse; requestId: string | undefined }> };
}

export class JevResponseError extends Error {}

const URGENCY_LEVELS = 4;

export class JevService {
  readonly #caller: SystemOneCaller | null;
  readonly #timeoutMs: number;

  constructor(options: { apiKey?: string; timeoutMs?: number; caller?: SystemOneCaller } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 6000;
    if (options.caller) {
      this.#caller = options.caller;
    } else if (options.apiKey?.trim()) {
      // One retry at most: a stale decision is worthless, and every attempt costs money.
      this.#caller = new TypeSafeClient({
        apiKey: options.apiKey,
        defaultModel: JEV_MODEL,
        timeout: this.#timeoutMs,
        retry: { maxRetries: 1, backoffInitialMs: 250, backoffMaxMs: 500 },
      }) as unknown as SystemOneCaller;
    } else {
      this.#caller = null;
    }
  }

  get configured(): boolean {
    return this.#caller !== null;
  }

  async decide(state: SwarmState, signal?: AbortSignal): Promise<DecisionResult> {
    if (!this.#caller) throw new Error("Jev is not configured");
    const started = performance.now();
    const { data, requestId } = await this.#caller
      .systemOne({ state, questions: QUESTIONS }, { signal, timeout: this.#timeoutMs })
      .withResponse();
    const latencyMs = Math.round(performance.now() - started);
    return normalizeJevResponse(data, latencyMs, Date.now(), requestId);
  }
}

function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevResponseError(`${path} is not a probability: ${String(value)}`);
  }
  return value;
}

/**
 * Validates Jev's answer and maps it onto a DecisionResult. Every number comes from the
 * response; a missing or malformed field rejects the whole answer instead of being filled in.
 */
export function normalizeJevResponse(
  data: JevResponse,
  latencyMs: number,
  timestamp: number,
  requestId?: string,
): DecisionResult {
  const answers = data?.answers;
  if (!answers) throw new JevResponseError("response has no answers");
  const { strategy, urgency, conserveEnergy } = answers;

  if (strategy?.type !== "choice" || !STRATEGIES.includes(strategy.choice as Strategy)) {
    throw new JevResponseError(`unexpected strategy answer: ${JSON.stringify(strategy)}`);
  }
  const strategyProbabilities = {} as Record<Strategy, number>;
  for (const label of STRATEGIES) {
    strategyProbabilities[label] = probability(strategy.probabilities?.[label], `strategy.probabilities.${label}`);
  }

  if (urgency?.type !== "score" || typeof urgency.score !== "number" || !Number.isFinite(urgency.score)) {
    throw new JevResponseError(`unexpected urgency answer: ${JSON.stringify(urgency)}`);
  }
  const maxLevel = URGENCY_LEVELS - 1;
  if (urgency.score < 0 || urgency.score > maxLevel) {
    throw new JevResponseError(`urgency score out of range: ${urgency.score}`);
  }

  if (conserveEnergy?.type !== "noul") {
    throw new JevResponseError(`unexpected conserveEnergy answer: ${JSON.stringify(conserveEnergy)}`);
  }

  return {
    strategy: strategy.choice as Strategy,
    strategyProbabilities,
    strategyConfidence: probability(strategy.confidence, "strategy.confidence"),
    urgency: urgency.score,
    normalizedUrgency: urgency.score / maxLevel,
    urgencyConfidence: probability(urgency.confidence, "urgency.confidence"),
    conserveEnergyProbability: probability(conserveEnergy.noul, "conserveEnergy.noul"),
    latencyMs,
    model: typeof data.model === "string" ? data.model : JEV_MODEL,
    timestamp,
    source: "jev",
    requestId,
  };
}
