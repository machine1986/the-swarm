import { describe, expect, it } from "vitest";
import { STRATEGIES, type DecisionResult, type Strategy } from "../../../shared/types.ts";
import { Recorder, Replayer } from "../replay/recording.ts";
import type { Command, WorldCommand } from "./commands.ts";
import { buildSwarmState } from "./metrics.ts";
import { Rng } from "./rng.ts";
import { SpatialHash } from "./SpatialHash.ts";
import { CAPACITY, World } from "./World.ts";

function decision(strategy: Strategy, urgency = 2): DecisionResult {
  return {
    strategy,
    strategyProbabilities: Object.fromEntries(STRATEGIES.map((s) => [s, s === strategy ? 1 : 0])) as Record<Strategy, number>,
    strategyConfidence: null,
    urgency,
    normalizedUrgency: urgency / 3,
    urgencyConfidence: null,
    conserveEnergyProbability: 0.2,
    latencyMs: 0,
    model: "test",
    timestamp: 0,
    source: "simulation",
  };
}

function run(world: World, steps: number): void {
  for (let i = 0; i < steps; i++) world.step();
}

function snapshot(world: World): number[] {
  return [...world.px.slice(0, 50), ...world.py.slice(0, 50), world.energy, world.threats.length];
}

describe("Rng", () => {
  it("is reproducible for the same seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
    expect(new Rng(43).next()).not.toBe(new Rng(42).next());
  });
});

describe("SpatialHash", () => {
  it("finds exactly the same neighbours as a brute-force scan", () => {
    const n = 400;
    const rng = new Rng(7);
    const px = new Float32Array(n), py = new Float32Array(n), alive = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      px[i] = rng.range(-500, 500);
      py[i] = rng.range(-300, 300);
    }
    const hash = new SpatialHash(n, 40);
    hash.resize(1000, 600);
    hash.build(px, py, alive, n);
    for (const i of [0, 17, 123, 399]) {
      const brute = new Set<number>();
      for (let j = 0; j < n; j++) if (j !== i && Math.hypot(px[j]! - px[i]!, py[j]! - py[i]!) < 40) brute.add(j);
      const found = new Set<number>();
      const gx = hash.cellX(px[i]!), gy = hash.cellY(py[i]!);
      for (let cy = gy - 1; cy <= gy + 1; cy++) {
        for (let cx = gx - 1; cx <= gx + 1; cx++) {
          if (cx < 0 || cy < 0 || cx >= hash.cols || cy >= hash.rows) continue;
          const c = cy * hash.cols + cx;
          for (let k = hash.cellStart[c]!; k < hash.cellStart[c + 1]!; k++) {
            const j = hash.cellItems[k]!;
            if (j !== i && Math.hypot(px[j]! - px[i]!, py[j]! - py[i]!) < 40) found.add(j);
          }
        }
      }
      expect(found).toEqual(brute);
    }
  });
});

describe("World", () => {
  it("starts with 1,000 living individuals", () => {
    expect(new World(1).aliveCount).toBe(CAPACITY);
  });

  it("is deterministic: same seed and commands give identical results", () => {
    const script: [number, WorldCommand][] = [
      [10, { type: "spawnThreat", x: 300, y: 50 }],
      [60, { type: "decision", decision: decision("DEFEND") }],
      [120, { type: "spawnThreats", count: 8, chaos: true }],
      [200, { type: "decision", decision: decision("SPLIT", 3) }],
      [320, { type: "decision", decision: decision("ATTACK", 3) }],
    ];
    const simulate = () => {
      const w = new World(1234, 1920, 1080);
      for (let t = 0; t < 420; t++) {
        for (const [tick, cmd] of script) if (tick === w.tick) w.apply(cmd);
        w.step();
      }
      return snapshot(w);
    };
    expect(simulate()).toEqual(simulate());
  });

  it("keeps every strategy numerically stable and inside the world", () => {
    for (const s of STRATEGIES) {
      const w = new World(99, 1920, 1080);
      w.apply({ type: "spawnThreats", count: 4, chaos: false });
      w.apply({ type: "decision", decision: decision(s) });
      run(w, 360);
      for (let i = 0; i < CAPACITY; i++) {
        if (!w.alive[i]) continue;
        expect(Number.isFinite(w.px[i]!) && Number.isFinite(w.py[i]!)).toBe(true);
        expect(Math.abs(w.px[i]!)).toBeLessThanOrEqual(1920 / 2 + 40);
        expect(Math.abs(w.py[i]!)).toBeLessThanOrEqual(1080 / 2 + 40);
      }
    }
  });

  it("DEFEND forms rings around a protected, empty core", () => {
    const w = new World(5, 1920, 1080);
    w.apply({ type: "decision", decision: decision("DEFEND") });
    run(w, 300);
    let inside = 0;
    for (let i = 0; i < CAPACITY; i++) {
      if (Math.hypot(w.px[i]! - w.anchorX, w.py[i]! - w.anchorY) < 45) inside++;
    }
    expect(inside).toBeLessThan(CAPACITY * 0.02);
    expect(w.rms).toBeGreaterThan(110);
    expect(w.rms).toBeLessThan(260);
  });

  it("REGROUP compacts the swarm and then returns to FLOCK by itself", () => {
    const w = new World(8, 1920, 1080);
    w.apply({ type: "decision", decision: decision("SPLIT") });
    run(w, 240);
    const spread = w.rms;
    w.apply({ type: "decision", decision: decision("REGROUP") });
    run(w, 150);
    expect(w.rms).toBeLessThan(spread);
    run(w, 400);
    expect(w.strategy).toBe("FLOCK");
    expect(w.lastCause).toBe("auto");
  });

  it("ATTACK destroys its target threat", () => {
    const w = new World(3, 1920, 1080);
    w.apply({ type: "spawnThreat", x: 250, y: 0 });
    w.apply({ type: "decision", decision: decision("ATTACK", 3) });
    run(w, 60 * 10);
    expect(w.threats).toHaveLength(0);
  });

  it("builds a compact state for Jev without particle positions", () => {
    const w = new World(11, 1920, 1080);
    w.apply({ type: "spawnThreat", x: 200, y: 0 });
    run(w, 30);
    const state = buildSwarmState(w);
    expect(state.environment.threatCount).toBe(1);
    expect(state.environment.nearestThreatIsolated).toBe(true);
    expect(state.swarm.population).toBe(w.aliveCount);
    expect(JSON.stringify(state).length).toBeLessThan(600);
  });
});

describe("record & replay", () => {
  it("reproduces a recorded session exactly", () => {
    const seed = 777;
    const live = new World(seed, 1600, 900);
    const recorder = new Recorder();
    recorder.start(seed, 1600, 900, { mode: "live", model: "jev-test" });
    const dispatch = (cmd: Command) => {
      recorder.capture(live.tick, cmd);
      if (cmd.type === "spawnThreat" || cmd.type === "decision" || cmd.type === "spawnThreats") live.apply(cmd);
    };
    for (let t = 0; t < 500; t++) {
      if (t === 20) dispatch({ type: "spawnThreat", x: -200, y: 100 });
      if (t === 45) dispatch({ type: "jevRequest", state: buildSwarmState(live), label: "JEV ANALYZING" });
      if (t === 70) dispatch({ type: "decision", decision: decision("FLIGHT", 3) });
      if (t === 210) dispatch({ type: "spawnThreats", count: 6, chaos: true });
      if (t === 260) dispatch({ type: "decision", decision: decision("DEFEND", 3) });
      live.step();
    }
    const rec = recorder.stop(live.tick)!;
    const roundTripped = JSON.parse(JSON.stringify(rec));

    const replay = new World(roundTripped.seed, roundTripped.width, roundTripped.height);
    const replayer = new Replayer();
    replayer.start(roundTripped);
    while (replay.tick < roundTripped.durationTicks) {
      for (const cmd of replayer.due(replay.tick)) {
        if (cmd.type === "spawnThreat" || cmd.type === "decision" || cmd.type === "spawnThreats") replay.apply(cmd);
      }
      replay.step();
    }
    expect(snapshot(replay)).toEqual(snapshot(live));
    expect(replay.strategy).toBe(live.strategy);
  });
});
