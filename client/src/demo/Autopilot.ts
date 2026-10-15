import type { Command } from "../simulation/commands.ts";
import { STEP, type World } from "../simulation/World.ts";

interface Cue {
  at: number;
  run: (world: World) => Command[];
}

/** Places a scripted threat relative to the swarm, kept inside the visible world. */
function around(world: World, angle: number, distance: number): Command {
  const halfW = world.width / 2 - 90;
  const halfH = world.height / 2 - 90;
  const x = Math.max(-halfW, Math.min(halfW, world.centerX + Math.cos(angle) * distance));
  const y = Math.max(-halfH, Math.min(halfH, world.centerY + Math.sin(angle) * distance));
  return { type: "spawnThreat", x, y };
}

/**
 * ~60 second scripted showcase. Threats, titles and camera are scripted; the strategy during
 * scenes 2–4 comes from the decision engine (Jev in live mode). The singularity finale is a
 * purely cinematic effect and is labelled as such.
 */
export const DEMO_SCRIPT: readonly Cue[] = [
  // Scene 1 — AWAKENING
  {
    at: 0,
    run: () => [
      { type: "aiEnabled", enabled: false },
      { type: "endCard", visible: false },
      { type: "darken", amount: 1, duration: 0 },
      { type: "darken", amount: 0.25, duration: 3.5 },
      { type: "camera", zoom: 1.6, duration: 0 },
      { type: "camera", zoom: 1.0, duration: 8 },
      { type: "awakening" },
    ],
  },
  { at: 1.4, run: () => [{ type: "title", text: "1,000 INDIVIDUALS.", variant: "hero" }] },
  { at: 4.4, run: () => [{ type: "title", text: "ONE INTELLIGENCE.", variant: "sub" }] },
  { at: 7.4, run: () => [{ type: "title", text: null }, { type: "darken", amount: 0, duration: 1.5 }] },
  // Scene 2 — FIRST CONTACT
  {
    at: 8,
    run: (w) => [
      { type: "title", text: "02 — FIRST CONTACT", variant: "scene" },
      { type: "aiEnabled", enabled: true },
      around(w, -0.35, 360),
    ],
  },
  // Scene 3 — ESCALATION
  {
    at: 18,
    run: (w) => [
      { type: "title", text: "03 — ESCALATION", variant: "scene" },
      { type: "camera", zoom: 0.9, duration: 3.5 },
      around(w, 2.6, 380),
      around(w, 1.4, 420),
    ],
  },
  { at: 21.5, run: (w) => [around(w, -2.0, 400), around(w, 0.6, 430)] },
  { at: 25, run: (w) => [around(w, 3.6, 360)] },
  // Scene 4 — CHAOS
  {
    at: 30,
    run: () => [
      { type: "title", text: "04 — CHAOS", variant: "scene" },
      { type: "darken", amount: 0.4, duration: 0.5 },
      { type: "title", text: "CRITICAL THREAT DETECTED", variant: "warning" },
      { type: "camera", zoom: 0.84, duration: 1.2 },
      { type: "spawnThreats", count: 18, chaos: true },
    ],
  },
  { at: 33.5, run: () => [{ type: "title", text: null }, { type: "darken", amount: 0.12, duration: 2 }] },
  // Scene 5 — THE SINGULARITY (cinematic, not a Jev decision)
  {
    at: 45,
    run: () => [
      { type: "aiEnabled", enabled: false },
      { type: "cinematicLabel", text: "CINEMATIC SEQUENCE · NOT A JEV DECISION" },
      { type: "title", text: "05 — THE SINGULARITY", variant: "scene" },
      { type: "darken", amount: 0.35, duration: 2 },
      { type: "camera", zoom: 1.2, duration: 4.4 },
      { type: "singularity" },
    ],
  },
  { at: 49.5, run: () => [{ type: "camera", zoom: 0.92, duration: 1.4 }, { type: "darken", amount: 0, duration: 0.3 }] },
  // Scene 6 — END CARD
  { at: 55, run: () => [{ type: "darken", amount: 0.96, duration: 1.4 }, { type: "endCard", visible: true }] },
];

export const DEMO_DURATION = 60;

export class Autopilot {
  #startTick = -1;
  #cue = 0;
  #endedNotified = false;

  get active(): boolean {
    return this.#startTick >= 0;
  }

  start(tick: number): void {
    this.#startTick = tick;
    this.#cue = 0;
    this.#endedNotified = false;
  }

  stop(): void {
    this.#startTick = -1;
  }

  elapsed(tick: number): number {
    return this.active ? (tick - this.#startTick) * STEP : 0;
  }

  /** Returns commands due this tick and whether the demo just finished. */
  update(world: World): { commands: Command[]; ended: boolean } {
    if (!this.active) return { commands: [], ended: false };
    const t = this.elapsed(world.tick);
    const commands: Command[] = [];
    while (this.#cue < DEMO_SCRIPT.length && DEMO_SCRIPT[this.#cue]!.at <= t) {
      commands.push(...DEMO_SCRIPT[this.#cue]!.run(world));
      this.#cue++;
    }
    let ended = false;
    if (t >= DEMO_DURATION && !this.#endedNotified) {
      this.#endedNotified = true;
      ended = true;
      this.stop();
    }
    return { commands, ended };
  }
}
