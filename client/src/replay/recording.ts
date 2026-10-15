import type { Command } from "../simulation/commands.ts";

export interface RecordedCommand {
  /** Simulation tick at which the command was applied (before the next step). */
  tick: number;
  cmd: Command;
}

export interface Recording {
  format: "the-swarm-recording";
  version: 1;
  createdAt: string;
  seed: number;
  width: number;
  height: number;
  durationTicks: number;
  /** How decisions were produced while recording. */
  source: { mode: "live" | "simulation"; model: string | null };
  commands: RecordedCommand[];
}

/** Captures every dispatched command with its tick. Recording starts from a fresh, seeded world. */
export class Recorder {
  #active: Omit<Recording, "durationTicks"> | null = null;

  get active(): boolean {
    return this.#active !== null;
  }

  start(seed: number, width: number, height: number, source: Recording["source"]): void {
    this.#active = {
      format: "the-swarm-recording",
      version: 1,
      createdAt: new Date().toISOString(),
      seed,
      width,
      height,
      source,
      commands: [],
    };
  }

  capture(tick: number, cmd: Command): void {
    if (!this.#active || cmd.type === "reset") return;
    // structuredClone: decisions are shared objects; the recording must not change later.
    this.#active.commands.push({ tick, cmd: structuredClone(cmd) });
  }

  noteSource(source: Recording["source"]): void {
    if (this.#active) this.#active.source = source;
  }

  stop(tick: number): Recording | null {
    if (!this.#active) return null;
    const rec: Recording = { ...this.#active, durationTicks: tick };
    this.#active = null;
    return rec;
  }
}

/** Feeds recorded commands back in tick order. */
export class Replayer {
  #rec: Recording | null = null;
  #index = 0;

  get recording(): Recording | null {
    return this.#rec;
  }

  get active(): boolean {
    return this.#rec !== null;
  }

  get finished(): boolean {
    return this.#rec !== null && this.#index >= this.#rec.commands.length;
  }

  start(rec: Recording): void {
    this.#rec = rec;
    this.#index = 0;
  }

  stop(): void {
    this.#rec = null;
    this.#index = 0;
  }

  /** Commands due at or before `tick`, in recorded order. */
  due(tick: number): Command[] {
    const out: Command[] = [];
    const cmds = this.#rec?.commands ?? [];
    while (this.#index < cmds.length && cmds[this.#index]!.tick <= tick) {
      out.push(cmds[this.#index]!.cmd);
      this.#index++;
    }
    return out;
  }
}

export function parseRecording(data: unknown): Recording {
  const r = data as Partial<Recording> | null;
  if (!r || r.format !== "the-swarm-recording" || r.version !== 1) throw new Error("Not a THE SWARM recording");
  if (typeof r.seed !== "number" || typeof r.width !== "number" || typeof r.height !== "number") {
    throw new Error("Recording header is incomplete");
  }
  if (!Array.isArray(r.commands)) throw new Error("Recording has no commands");
  let last = 0;
  for (const c of r.commands) {
    if (typeof c?.tick !== "number" || typeof c.cmd?.type !== "string" || c.tick < last) {
      throw new Error("Recording commands are malformed or out of order");
    }
    last = c.tick;
  }
  return r as Recording;
}
