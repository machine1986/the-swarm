import type { DecisionResult, SwarmState } from "../../../shared/types.ts";

/** Everything that changes the simulation goes through one of these, so it can be recorded and replayed. */
export type WorldCommand =
  | { type: "reset"; seed: number; width: number; height: number }
  | { type: "bounds"; width: number; height: number }
  | { type: "spawnThreat"; x: number; y: number }
  | { type: "spawnThreats"; count: number; chaos: boolean }
  | { type: "clearThreats" }
  | { type: "decision"; decision: DecisionResult }
  | { type: "awakening" }
  | { type: "singularity" };

/** Presentation-only commands: HUD, overlays, camera. Recorded so replays look identical. */
export type MetaCommand =
  /** `label`: event-log line for event-triggered requests; null for routine cadence. */
  | { type: "jevRequest"; state: SwarmState; label: string | null }
  | { type: "decisionShown"; decision: DecisionResult; pending: boolean }
  | { type: "decisionError"; message: string }
  | { type: "title"; text: string | null; variant?: "hero" | "sub" | "warning" | "scene" }
  | { type: "endCard"; visible: boolean }
  | { type: "camera"; zoom: number; duration: number }
  | { type: "darken"; amount: number; duration: number }
  | { type: "aiEnabled"; enabled: boolean }
  | { type: "cinematicLabel"; text: string | null };

export type Command = WorldCommand | MetaCommand;

const WORLD_COMMANDS = new Set<Command["type"]>([
  "reset",
  "bounds",
  "spawnThreat",
  "spawnThreats",
  "clearThreats",
  "decision",
  "awakening",
  "singularity",
]);

export function isWorldCommand(cmd: Command): cmd is WorldCommand {
  return WORLD_COMMANDS.has(cmd.type);
}
