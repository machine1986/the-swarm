import type { DecisionResult, Strategy } from "../../../shared/types.ts";
import type { WorldCommand } from "./commands.ts";
import {
  angleDelta,
  clamp,
  clamp01,
  easeInCubic,
  easeInOutCubic,
  easeOutCubic,
  GOLDEN_ANGLE,
  lerp,
  smoothing,
  TAU,
} from "./math.ts";
import { Rng } from "./rng.ts";
import { SpatialHash } from "./SpatialHash.ts";
import { blendParams, copyParams, ENERGY_RATE, STRATEGY_COLORS, STRATEGY_PARAMS, type StrategyParams } from "./strategies.ts";

export const CAPACITY = 1000;
/** Fixed physics timestep. Simulation speed is independent of the display frame rate. */
export const STEP = 1 / 60;

const NEIGHBOR_RADIUS = 34;
const SEPARATION_RADIUS = 15;
const MAX_NEIGHBORS = 26;
const MAX_THREATS = 40;
const BOUNDS_MARGIN = 70;
const DEFEND_RINGS = [74, 126, 178, 232];
const DEFEND_RING_SPEED = [1.15, -0.85, 0.62, -0.44];
const SPLIT_STANDOFF = 190;
const REGROUP_SUPPRESS_SECONDS = 6;

export interface Threat {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  radius: number;
  speed: number;
  /** 0–100 */
  strength: number;
  health: number;
  maxHealth: number;
  status: "spawning" | "active";
  age: number;
  /** Particles touching the threat during the last step. */
  contact: number;
  wanderPhase: number;
}

export type StrategyCause = "decision" | "auto" | "cinematic" | "reset";

export type WorldEvent =
  | { type: "pulse"; x: number; y: number; color: number; strength: number }
  | { type: "explosion"; x: number; y: number; radius: number; color: number; big?: boolean }
  | { type: "threatSpawned"; x: number; y: number; radius: number; id: number }
  | { type: "threatDestroyed"; x: number; y: number; id: number; remaining: number }
  | { type: "absorb"; x: number; y: number }
  | { type: "flash"; strength: number; color: number }
  | { type: "shake"; strength: number }
  | { type: "strategyChanged"; strategy: Strategy; previous: Strategy; cause: StrategyCause }
  | { type: "log"; text: string; tone: "info" | "threat" | "ai" | "warn" | "success" };

type Cinematic =
  | { kind: "none" }
  | { kind: "awakening"; t: number }
  | { kind: "singularity"; t: number; exploded: boolean };

/**
 * Deterministic swarm simulation: boids (separation, alignment, cohesion) extended with
 * threat avoidance, formation targeting and strategy steering. Same seed + same commands at
 * the same ticks ⇒ identical result, which is what makes record & replay work.
 */
export class World {
  readonly capacity = CAPACITY;
  // Particle state (struct of arrays, allocated once).
  readonly px = new Float32Array(CAPACITY);
  readonly py = new Float32Array(CAPACITY);
  readonly prevX = new Float32Array(CAPACITY);
  readonly prevY = new Float32Array(CAPACITY);
  readonly vx = new Float32Array(CAPACITY);
  readonly vy = new Float32Array(CAPACITY);
  /** Individual brightness variation, 0.55–1. */
  readonly bright = new Float32Array(CAPACITY);
  /** Short-lived highlight when an individual hits something, decays to 0. */
  readonly heat = new Float32Array(CAPACITY);
  readonly alive = new Uint8Array(CAPACITY);
  readonly #slot = new Uint16Array(CAPACITY);
  readonly #group = new Uint8Array(CAPACITY);
  readonly #phase = new Float32Array(CAPACITY);
  // Defend ring layout per slot.
  readonly #ringOf = new Uint8Array(CAPACITY);
  readonly #ringAngle = new Float32Array(CAPACITY);
  readonly #ringJitter = new Float32Array(CAPACITY);

  readonly #hash = new SpatialHash(CAPACITY, NEIGHBOR_RADIUS);
  #rng = new Rng(1);

  width = 1920;
  height = 1080;
  tick = 0;
  time = 0;
  seed = 1;
  aliveCount = CAPACITY;

  strategy: Strategy = "FLOCK";
  strategyTime = 0;
  lastCause: StrategyCause = "reset";
  readonly params: StrategyParams = { ...STRATEGY_PARAMS.FLOCK };
  /** Eased 0→1 progress of the current formation transition. */
  formBlend = 1;
  #transitionDuration = 1.2;
  #formationReported = true;
  #formationError = 0;

  urgency = 0;
  #urgencyTarget = 0;
  conserve = 0;
  energy = 100;
  #energyWarned = false;

  // Swarm metrics, refreshed every step.
  centerX = 0;
  centerY = 0;
  rms = 120;
  dispersion = 0;

  anchorX = 0;
  anchorY = 0;
  #flightDir = 0;
  attackTargetId = -1;
  #attackEngaged = false;
  #attackEngage = 0;
  splitCount = 0;
  readonly splitX = new Float32Array(4);
  readonly splitY = new Float32Array(4);
  readonly #splitGoalX = new Float32Array(4);
  readonly #splitGoalY = new Float32Array(4);
  /** Swarm centre when the split began; group goals are placed relative to it so they don't drift. */
  #splitOriginX = 0;
  #splitOriginY = 0;
  #regroupCompletedAt = -100;
  #reviveTimer = 0;

  threats: Threat[] = [];
  #nextThreatId = 1;

  cinematic: Cinematic = { kind: "none" };
  /** Extra light intensity for the renderer, 0–1. */
  glow = 0;
  /** Global particle visibility, 0–1 (used by the finale). */
  fade = 1;

  /** Events produced since the last drain; consumed by renderer and HUD. */
  events: WorldEvent[] = [];

  // Scratch outputs to avoid allocations in the hot loop.
  #tx = 0;
  #ty = 0;

  constructor(seed = 1, width = 1920, height = 1080) {
    this.reset(seed, width, height);
  }

  // ───────────────────────────── commands ─────────────────────────────

  apply(cmd: WorldCommand): void {
    switch (cmd.type) {
      case "reset":
        this.reset(cmd.seed, cmd.width, cmd.height);
        break;
      case "bounds":
        this.setBounds(cmd.width, cmd.height);
        break;
      case "spawnThreat":
        this.#spawnThreat(cmd.x, cmd.y);
        break;
      case "spawnThreats":
        this.#spawnThreats(cmd.count, cmd.chaos);
        break;
      case "clearThreats":
        this.#clearThreats();
        break;
      case "decision":
        this.#applyDecision(cmd.decision);
        break;
      case "awakening":
        this.#startAwakening();
        break;
      case "singularity":
        this.#startSingularity();
        break;
    }
  }

  reset(seed: number, width: number, height: number): void {
    this.seed = seed >>> 0;
    this.#rng = new Rng(this.seed);
    this.tick = 0;
    this.time = 0;
    this.setBounds(width, height);
    const rng = this.#rng;

    const slots = new Uint16Array(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) slots[i] = i;
    rng.shuffle(slots);
    this.#slot.set(slots);

    for (let i = 0; i < CAPACITY; i++) {
      const a = rng.next() * TAU;
      const r = Math.sqrt(rng.next()) * 210;
      this.px[i] = this.prevX[i] = Math.cos(a) * r;
      this.py[i] = this.prevY[i] = Math.sin(a) * r * 0.8;
      // Start with a gentle shared swirl so the first frame already reads as a flock.
      this.vx[i] = -Math.sin(a) * 90 + rng.range(-20, 20);
      this.vy[i] = Math.cos(a) * 90 + rng.range(-20, 20);
      this.bright[i] = 0.55 + 0.45 * Math.pow(rng.next(), 0.7);
      this.#phase[i] = rng.next() * TAU;
      this.heat[i] = 0;
      this.alive[i] = 1;
    }
    this.aliveCount = CAPACITY;
    this.#layoutDefendRings();

    this.threats = [];
    this.#nextThreatId = 1;
    this.strategy = "FLOCK";
    this.lastCause = "reset";
    this.strategyTime = 10;
    copyParams(STRATEGY_PARAMS.FLOCK, this.params);
    this.formBlend = 1;
    this.#formationReported = true;
    this.urgency = this.#urgencyTarget = 0;
    this.conserve = 0;
    this.energy = 100;
    this.#energyWarned = false;
    this.anchorX = this.anchorY = 0;
    this.centerX = this.centerY = 0;
    this.attackTargetId = -1;
    this.splitCount = 0;
    this.#regroupCompletedAt = -100;
    this.#reviveTimer = 0;
    this.cinematic = { kind: "none" };
    this.glow = 0;
    this.fade = 1;
    this.events = [];
  }

  setBounds(width: number, height: number): void {
    this.width = Math.max(320, width);
    this.height = Math.max(320, height);
    this.#hash.resize(this.width, this.height);
  }

  drainEvents(): WorldEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  getThreat(id: number): Threat | undefined {
    return this.threats.find((t) => t.id === id);
  }

  // ───────────────────────────── stepping ─────────────────────────────

  step(): void {
    const dt = STEP;
    this.tick++;
    this.time += dt;
    this.strategyTime += dt;

    this.#updateCinematic(dt);
    this.urgency += (this.#urgencyTarget - this.urgency) * smoothing(dt, 0.6);
    blendParams(this.params, STRATEGY_PARAMS[this.strategy], smoothing(dt, lerp(0.9, 0.3, this.urgency)));
    this.formBlend = easeInOutCubic(clamp01(this.strategyTime / this.#transitionDuration));

    this.#updateMetrics();
    this.#updateThreats(dt);
    this.#updateAnchors(dt);

    if (this.cinematic.kind === "singularity" && this.cinematic.exploded) {
      this.#stepFree(dt);
    } else {
      this.#stepBoids(dt);
    }

    this.#updateEnergy(dt);
    this.#reviveFallen(dt);
    if (this.tick % 15 === 0) this.#checkFormation();
  }

  #stepBoids(dt: number): void {
    const { px, py, vx, vy, alive, heat } = this;
    const hash = this.#hash;
    hash.build(px, py, alive, CAPACITY);
    const cellStart = hash.cellStart;
    const items = hash.cellItems;
    const cols = hash.cols;
    const rows = hash.rows;

    const P = this.params;
    const speedScale = (0.62 + 0.38 * (this.energy / 100)) * (1 - 0.3 * this.conserve) * (0.9 + 0.25 * this.urgency);
    const maxSpeed = P.maxSpeed * speedScale;
    const minSpeed = P.minSpeed * speedScale;
    const maxForce = P.maxForce * (0.85 + 0.35 * this.urgency);
    const formWeight = P.formation * this.formBlend;
    const nr2 = NEIGHBOR_RADIUS * NEIGHBOR_RADIUS;
    const sr2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    const halfW = this.width / 2;
    const halfH = this.height / 2;
    const threats = this.threats;
    const attacking = this.strategy === "ATTACK";
    const t = this.time;

    for (const threat of threats) threat.contact = 0;
    let attackContact = 0;

    for (let i = 0; i < CAPACITY; i++) {
      if (!alive[i]) continue;
      const x = px[i]!;
      const y = py[i]!;
      const ivx = vx[i]!;
      const ivy = vy[i]!;

      // ── Local boids neighbourhood ──
      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, n = 0;
      const gx = hash.cellX(x);
      const gy = hash.cellY(y);
      search: for (let cy = gy - 1; cy <= gy + 1; cy++) {
        if (cy < 0 || cy >= rows) continue;
        for (let cx = gx - 1; cx <= gx + 1; cx++) {
          if (cx < 0 || cx >= cols) continue;
          const c = cy * cols + cx;
          for (let k = cellStart[c]!, end = cellStart[c + 1]!; k < end; k++) {
            const j = items[k]!;
            if (j === i) continue;
            const dx = px[j]! - x;
            const dy = py[j]! - y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= nr2) continue;
            aliX += vx[j]!;
            aliY += vy[j]!;
            cohX += dx;
            cohY += dy;
            if (d2 < sr2 && d2 > 1e-4) {
              sepX -= dx / d2;
              sepY -= dy / d2;
            }
            if (++n >= MAX_NEIGHBORS) break search;
          }
        }
      }

      let fx = 0, fy = 0;
      if (n > 0) {
        fx += this.#steerX(aliX, aliY, ivx, ivy, maxSpeed, maxForce) * P.alignment;
        fy += this.#steerY * P.alignment;
        fx += this.#steerX(cohX, cohY, ivx, ivy, maxSpeed, maxForce) * P.cohesion;
        fy += this.#steerY * P.cohesion;
        if (sepX !== 0 || sepY !== 0) {
          fx += this.#steerX(sepX, sepY, ivx, ivy, maxSpeed, maxForce) * P.separation;
          fy += this.#steerY * P.separation;
        }
      }

      // ── Formation targeting (arrive behaviour) ──
      this.#target(i);
      {
        const dx = this.#tx - x;
        const dy = this.#ty - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0.5) {
          const desired = maxSpeed * Math.min(1, d / 110);
          let sx = (dx / d) * desired - ivx;
          let sy = (dy / d) * desired - ivy;
          const m = Math.sqrt(sx * sx + sy * sy);
          if (m > maxForce) {
            sx *= maxForce / m;
            sy *= maxForce / m;
          }
          fx += sx * formWeight;
          fy += sy * formWeight;
        }
      }

      // ── Threat avoidance / contact ──
      for (let k = 0; k < threats.length; k++) {
        const th = threats[k]!;
        const dx = x - th.x;
        const dy = y - th.y;
        const isTarget = attacking && th.id === this.attackTargetId;
        const reach = th.radius + (isTarget ? 0 : P.avoidRadius);
        const d2 = dx * dx + dy * dy;
        if (d2 > (reach + 30) * (reach + 30)) continue;
        const d = Math.sqrt(d2) + 1e-3;
        if (d < th.radius + 26) {
          th.contact++;
          if (isTarget) {
            attackContact++;
            heat[i] = 1;
          } else if (!attacking && d < th.radius * 0.8 && this.#rng.next() < 1.1 * dt) {
            this.#absorb(i);
            break;
          }
        }
        if (!isTarget && d < reach) {
          const edge = Math.max(0, d - th.radius);
          const f = 1 - edge / P.avoidRadius;
          const push = f * f * maxForce * P.avoidance * (attacking ? 0.5 : 1);
          fx += (dx / d) * push;
          fy += (dy / d) * push;
        }
      }
      if (!alive[i]) continue;

      // ── Organic wander ──
      const ph = this.#phase[i]!;
      const wa = ph + t * 0.7 + Math.sin(t * 0.37 + ph) * 2;
      fx += Math.cos(wa) * maxForce * 0.35 * P.wander;
      fy += Math.sin(wa) * maxForce * 0.35 * P.wander;

      // ── Soft world bounds ──
      if (x < -halfW + BOUNDS_MARGIN) fx += maxForce * ((-halfW + BOUNDS_MARGIN - x) / BOUNDS_MARGIN);
      else if (x > halfW - BOUNDS_MARGIN) fx -= maxForce * ((x - halfW + BOUNDS_MARGIN) / BOUNDS_MARGIN);
      if (y < -halfH + BOUNDS_MARGIN) fy += maxForce * ((-halfH + BOUNDS_MARGIN - y) / BOUNDS_MARGIN);
      else if (y > halfH - BOUNDS_MARGIN) fy -= maxForce * ((y - halfH + BOUNDS_MARGIN) / BOUNDS_MARGIN);

      // ── Integrate ──
      const fm = Math.sqrt(fx * fx + fy * fy);
      const fLimit = maxForce * 2.2;
      if (fm > fLimit) {
        fx *= fLimit / fm;
        fy *= fLimit / fm;
      }
      let nvx = ivx + fx * dt;
      let nvy = ivy + fy * dt;
      const sp = Math.sqrt(nvx * nvx + nvy * nvy);
      if (sp > maxSpeed) {
        nvx *= maxSpeed / sp;
        nvy *= maxSpeed / sp;
      } else if (sp < minSpeed && sp > 1e-3) {
        nvx *= minSpeed / sp;
        nvy *= minSpeed / sp;
      }
      vx[i] = nvx;
      vy[i] = nvy;
      this.prevX[i] = x;
      this.prevY[i] = y;
      px[i] = clamp(x + nvx * dt, -halfW - 40, halfW + 40);
      py[i] = clamp(y + nvy * dt, -halfH - 40, halfH + 40);
      if (heat[i]! > 0) heat[i] = Math.max(0, heat[i]! - dt * 2.5);
    }

    if (attacking) this.#damageAttackTarget(attackContact, dt);
  }

  /** Free flight after the singularity burst: no steering, gentle drag. */
  #stepFree(dt: number): void {
    const { px, py, vx, vy, alive } = this;
    const drag = Math.pow(0.45, dt);
    for (let i = 0; i < CAPACITY; i++) {
      if (!alive[i]) continue;
      this.prevX[i] = px[i]!;
      this.prevY[i] = py[i]!;
      vx[i] = vx[i]! * drag;
      vy[i] = vy[i]! * drag;
      px[i] = px[i]! + vx[i]! * dt;
      py[i] = py[i]! + vy[i]! * dt;
    }
  }

  // Steering helper: writes Y into #steerY to avoid allocating a tuple.
  #steerY = 0;
  #steerX(dirX: number, dirY: number, vx: number, vy: number, maxSpeed: number, maxForce: number): number {
    const m = Math.sqrt(dirX * dirX + dirY * dirY);
    if (m < 1e-6) {
      this.#steerY = 0;
      return 0;
    }
    let sx = (dirX / m) * maxSpeed - vx;
    let sy = (dirY / m) * maxSpeed - vy;
    const sm = Math.sqrt(sx * sx + sy * sy);
    if (sm > maxForce) {
      sx *= maxForce / sm;
      sy *= maxForce / sm;
    }
    this.#steerY = sy;
    return sx;
  }

  // ───────────────────────────── formations ─────────────────────────────

  /** Computes particle i's formation target into #tx/#ty. */
  #target(i: number): void {
    const s = this.#slot[i]!;
    const f = (s + 0.5) / CAPACITY;
    const t = this.time + 0.12; // lead the moving targets slightly
    const popScale = Math.sqrt(Math.max(this.aliveCount, 30) / CAPACITY);

    if (this.cinematic.kind === "singularity") {
      const r = this.#singularityRadius() * Math.sqrt(f);
      const a = s * GOLDEN_ANGLE + t * 2.2;
      this.#tx = this.anchorX + Math.cos(a) * r;
      this.#ty = this.anchorY + Math.sin(a) * r;
      return;
    }

    switch (this.strategy) {
      case "FLOCK": {
        const r = (240 * popScale + 12) * Math.sqrt(f) * (1 + 0.22 * Math.sin(t * 0.6 + s * 0.01));
        const a = s * GOLDEN_ANGLE + t * 0.09;
        this.#tx = this.anchorX + Math.cos(a) * r * 1.15;
        this.#ty = this.anchorY + Math.sin(a) * r * 0.85;
        return;
      }
      case "FLIGHT": {
        const ex = Math.cos(this.#flightDir);
        const ey = Math.sin(this.#flightDir);
        const along = 560 * (0.3 - f);
        const lateral = (((s * 0.6180339) % 1) * 2 - 1) * 72 * Math.pow(1 - f, 0.55);
        const wobble = Math.sin(t * 3 + f * 9) * 10 * f;
        this.#tx = this.anchorX + ex * along - ey * (lateral + wobble);
        this.#ty = this.anchorY + ey * along + ex * (lateral + wobble);
        return;
      }
      case "ATTACK": {
        const target = this.getThreat(this.attackTargetId);
        const cx = target ? target.x : this.anchorX;
        const cy = target ? target.y : this.anchorY;
        const core = target ? target.radius * 0.6 : 30;
        const r = core + 12 + f * 160 * (1 - 0.78 * this.#attackEngage);
        const a = s * GOLDEN_ANGLE + t * (2.6 - f * 1.3);
        this.#tx = cx + Math.cos(a) * r;
        this.#ty = cy + Math.sin(a) * r;
        return;
      }
      case "DEFEND": {
        const k = this.#ringOf[s]!;
        const breathe = 1 + 0.035 * Math.sin(t * 2.1 + k * 1.3);
        const r = (DEFEND_RINGS[k]! * (0.55 + 0.45 * popScale) + this.#ringJitter[s]!) * breathe;
        const a = this.#ringAngle[s]! + t * DEFEND_RING_SPEED[k]! * (1 + 0.5 * this.urgency);
        this.#tx = this.anchorX + Math.cos(a) * r;
        this.#ty = this.anchorY + Math.sin(a) * r;
        return;
      }
      case "SPLIT": {
        const g = this.#group[i]!;
        const local = (s * 0.6180339) % 1;
        const r = 92 * popScale * Math.sqrt(local) + 8;
        const a = s * GOLDEN_ANGLE + t * (g % 2 === 0 ? 1.3 : -1.3);
        this.#tx = this.splitX[g]! + Math.cos(a) * r;
        this.#ty = this.splitY[g]! + Math.sin(a) * r;
        return;
      }
      case "REGROUP": {
        const shrink = easeOutCubic(clamp01(this.strategyTime / 2.4));
        const r = lerp(170, 72, shrink) * popScale * Math.sqrt(f);
        const a = s * GOLDEN_ANGLE + t * 0.6;
        this.#tx = this.anchorX + Math.cos(a) * r;
        this.#ty = this.anchorY + Math.sin(a) * r;
        return;
      }
    }
  }

  #layoutDefendRings(): void {
    const total = DEFEND_RINGS.reduce((a, b) => a + b, 0);
    let slot = 0;
    for (let k = 0; k < DEFEND_RINGS.length; k++) {
      const count = k === DEFEND_RINGS.length - 1 ? CAPACITY - slot : Math.round((CAPACITY * DEFEND_RINGS[k]!) / total);
      for (let j = 0; j < count; j++, slot++) {
        this.#ringOf[slot] = k;
        this.#ringAngle[slot] = (j / count) * TAU;
        this.#ringJitter[slot] = this.#rng.range(-3.5, 3.5);
      }
    }
  }

  #singularityRadius(): number {
    const c = this.cinematic;
    if (c.kind !== "singularity") return 0;
    return lerp(170, 9, easeInCubic(clamp01(c.t / 4.2)));
  }

  // ───────────────────────────── anchors & metrics ─────────────────────────────

  #updateMetrics(): void {
    const { px, py, alive } = this;
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < CAPACITY; i++) {
      if (!alive[i]) continue;
      sx += px[i]!;
      sy += py[i]!;
      n++;
    }
    this.aliveCount = n;
    if (n === 0) return;
    const cx = sx / n;
    const cy = sy / n;
    let sq = 0, far = 0;
    for (let i = 0; i < CAPACITY; i++) {
      if (!alive[i]) continue;
      const dx = px[i]! - cx;
      const dy = py[i]! - cy;
      const d2 = dx * dx + dy * dy;
      sq += d2;
      if (d2 > 270 * 270) far++;
    }
    this.centerX = cx;
    this.centerY = cy;
    this.rms = Math.sqrt(sq / n);
    this.dispersion = (far / n) * 100;
  }

  get cohesion(): number {
    return clamp(100 * (1 - (this.rms - 80) / 300), 0, 100);
  }

  #updateAnchors(dt: number): void {
    const halfW = this.width / 2 - 170;
    const halfH = this.height / 2 - 150;
    const c = this.cinematic;

    if (c.kind === "awakening" || c.kind === "singularity") {
      this.anchorX += (0 - this.anchorX) * smoothing(dt, 1.2);
      this.anchorY += (0 - this.anchorY) * smoothing(dt, 1.2);
      return;
    }

    switch (this.strategy) {
      case "FLOCK": {
        const gx = Math.sin(this.time * 0.085 + this.seed % 7) * this.width * 0.24;
        const gy = Math.sin(this.time * 0.13 + 1.7) * this.height * 0.2;
        this.anchorX += (gx - this.anchorX) * smoothing(dt, 2.5);
        this.anchorY += (gy - this.anchorY) * smoothing(dt, 2.5);
        break;
      }
      case "FLIGHT": {
        const wanted = this.#escapeAngle();
        let dir = this.#flightDir + clamp(angleDelta(this.#flightDir, wanted), -dt * 1.6, dt * 1.6);
        let gx = clamp(this.centerX + Math.cos(dir) * 380, -halfW, halfW);
        let gy = clamp(this.centerY + Math.sin(dir) * 380, -halfH, halfH);
        // Cornered: slide along the wall towards the side with more room.
        if (Math.hypot(gx - this.centerX, gy - this.centerY) < 160) {
          const left = dir + Math.PI / 2;
          const right = dir - Math.PI / 2;
          dir = this.#roomTowards(left) > this.#roomTowards(right) ? left : right;
          gx = clamp(this.centerX + Math.cos(dir) * 380, -halfW, halfW);
          gy = clamp(this.centerY + Math.sin(dir) * 380, -halfH, halfH);
        }
        this.#flightDir = dir;
        this.anchorX += (gx - this.anchorX) * smoothing(dt, 0.7);
        this.anchorY += (gy - this.anchorY) * smoothing(dt, 0.7);
        break;
      }
      case "ATTACK": {
        let target = this.getThreat(this.attackTargetId);
        if (!target && this.threats.length > 0) {
          this.attackTargetId = this.#nearestThreat()?.id ?? -1;
          this.#attackEngaged = false;
          target = this.getThreat(this.attackTargetId);
        }
        const gx = target ? target.x : this.centerX;
        const gy = target ? target.y : this.centerY;
        this.anchorX += (gx - this.anchorX) * smoothing(dt, 0.4);
        this.anchorY += (gy - this.anchorY) * smoothing(dt, 0.4);
        break;
      }
      case "DEFEND": {
        // Hold position; ease away from threats pressing on the barrier.
        let gx = this.anchorX, gy = this.anchorY;
        for (const th of this.threats) {
          const dx = this.anchorX - th.x;
          const dy = this.anchorY - th.y;
          const d = Math.hypot(dx, dy) + 1e-3;
          if (d < 420) {
            gx += (dx / d) * (420 - d) * 0.25;
            gy += (dy / d) * (420 - d) * 0.25;
          }
        }
        gx = clamp(gx, -halfW + 80, halfW - 80);
        gy = clamp(gy, -halfH + 80, halfH - 80);
        this.anchorX += (gx - this.anchorX) * smoothing(dt, 2.2);
        this.anchorY += (gy - this.anchorY) * smoothing(dt, 2.2);
        this.#repelThreatsFromBarrier(dt);
        break;
      }
      case "SPLIT": {
        if (this.tick % 30 === 0) this.#computeSplitGoals();
        const k = smoothing(dt, 0.9);
        for (let g = 0; g < this.splitCount; g++) {
          this.splitX[g]! += (this.#splitGoalX[g]! - this.splitX[g]!) * k;
          this.splitY[g]! += (this.#splitGoalY[g]! - this.splitY[g]!) * k;
        }
        this.anchorX = this.centerX;
        this.anchorY = this.centerY;
        break;
      }
      case "REGROUP": {
        const gx = this.centerX * 0.85;
        const gy = this.centerY * 0.85;
        this.anchorX += (gx - this.anchorX) * smoothing(dt, 0.9);
        this.anchorY += (gy - this.anchorY) * smoothing(dt, 0.9);
        break;
      }
    }
  }

  #escapeAngle(): number {
    let ex = 0, ey = 0;
    for (const th of this.threats) {
      const dx = this.centerX - th.x;
      const dy = this.centerY - th.y;
      const d2 = Math.max(dx * dx + dy * dy, 400);
      const w = (0.5 + th.strength / 100) / d2;
      ex += dx * w;
      ey += dy * w;
    }
    if (ex === 0 && ey === 0) return this.#flightDir;
    return Math.atan2(ey, ex);
  }

  /** Free distance from the swarm centre to the wall in direction `a`, minus threat pressure. */
  #roomTowards(a: number): number {
    const halfW = this.width / 2 - 170;
    const halfH = this.height / 2 - 150;
    const gx = clamp(this.centerX + Math.cos(a) * 380, -halfW, halfW);
    const gy = clamp(this.centerY + Math.sin(a) * 380, -halfH, halfH);
    let score = Math.hypot(gx - this.centerX, gy - this.centerY);
    for (const th of this.threats) score -= 9000 / Math.max(Math.hypot(gx - th.x, gy - th.y), 60);
    return score;
  }

  #repelThreatsFromBarrier(dt: number): void {
    const outer = DEFEND_RINGS[DEFEND_RINGS.length - 1]! + 34;
    for (const th of this.threats) {
      const dx = th.x - this.anchorX;
      const dy = th.y - this.anchorY;
      const d = Math.hypot(dx, dy) + 1e-3;
      const limit = outer + th.radius;
      if (d < limit) {
        const push = (limit - d) * 4 * dt * this.formBlend;
        th.x += (dx / d) * push;
        th.y += (dy / d) * push;
      }
    }
  }

  #nearestThreat(): Threat | undefined {
    let best: Threat | undefined;
    let bestD = Infinity;
    for (const th of this.threats) {
      const d = Math.hypot(th.x - this.centerX, th.y - this.centerY) - th.radius;
      if (d < bestD) {
        bestD = d;
        best = th;
      }
    }
    return best;
  }

  // ───────────────────────────── strategies ─────────────────────────────

  #applyDecision(decision: DecisionResult): void {
    this.#urgencyTarget = clamp01(decision.normalizedUrgency);
    this.conserve = clamp01(decision.conserveEnergyProbability);
    if (this.cinematic.kind !== "none") return;
    // REGROUP just finished: don't bounce straight back into it.
    if (
      decision.strategy === "REGROUP" &&
      this.strategy === "FLOCK" &&
      this.time - this.#regroupCompletedAt < REGROUP_SUPPRESS_SECONDS
    ) {
      return;
    }
    this.#setStrategy(decision.strategy, "decision");
  }

  #setStrategy(next: Strategy, cause: StrategyCause): void {
    if (next === this.strategy) return;
    const previous = this.strategy;
    this.strategy = next;
    this.lastCause = cause;
    this.strategyTime = 0;
    this.#transitionDuration = lerp(1.7, 0.7, this.#urgencyTarget);
    this.#formationReported = false;

    switch (next) {
      case "FLIGHT":
        this.#flightDir = this.#escapeAngle();
        break;
      case "ATTACK":
        this.attackTargetId = this.#nearestThreat()?.id ?? -1;
        this.#attackEngaged = false;
        this.#attackEngage = 0;
        break;
      case "DEFEND":
        this.anchorX = this.centerX;
        this.anchorY = this.centerY;
        break;
      case "SPLIT":
        this.#beginSplit();
        break;
      case "REGROUP":
        this.anchorX = this.centerX;
        this.anchorY = this.centerY;
        break;
      case "FLOCK":
        break;
    }

    this.events.push(
      { type: "strategyChanged", strategy: next, previous, cause },
      {
        type: "pulse",
        x: this.centerX,
        y: this.centerY,
        color: STRATEGY_COLORS[next],
        strength: 0.65 + this.#urgencyTarget * 0.6,
      },
    );
    if (this.#urgencyTarget > 0.6) this.events.push({ type: "shake", strength: 0.35 + this.#urgencyTarget * 0.3 });
  }

  #beginSplit(): void {
    this.#splitOriginX = this.centerX;
    this.#splitOriginY = this.centerY;
    this.splitCount = 0;
    this.#computeSplitGoals();
    const k = this.splitCount;
    // Assign particles to groups by angle around the centre so each group peels off its own side.
    const order: number[] = [];
    for (let i = 0; i < CAPACITY; i++) order.push(i);
    const angle = (i: number) => Math.atan2(this.py[i]! - this.centerY, this.px[i]! - this.centerX);
    order.sort((a, b) => angle(a) - angle(b));
    const goalOrder = Array.from({ length: k }, (_, g) => g).sort(
      (a, b) =>
        Math.atan2(this.#splitGoalY[a]! - this.centerY, this.#splitGoalX[a]! - this.centerX) -
        Math.atan2(this.#splitGoalY[b]! - this.centerY, this.#splitGoalX[b]! - this.centerX),
    );
    // Rotate the angular ordering so chunk boundaries line up with the gaps between goals.
    const firstGoalAngle = Math.atan2(this.#splitGoalY[goalOrder[0]!]! - this.centerY, this.#splitGoalX[goalOrder[0]!]! - this.centerX);
    let offset = 0;
    while (offset < CAPACITY && angle(order[offset]!) < firstGoalAngle - Math.PI / k) offset++;
    for (let r = 0; r < CAPACITY; r++) {
      const i = order[(r + offset) % CAPACITY]!;
      this.#group[i] = goalOrder[Math.min(k - 1, Math.floor((r * k) / CAPACITY))]!;
    }
    for (let g = 0; g < k; g++) {
      this.splitX[g] = this.centerX;
      this.splitY[g] = this.centerY;
    }
  }

  /** Clusters threats (k-means, deterministic init) and places one group between swarm and each cluster. */
  #computeSplitGoals(): void {
    const threats = this.threats;
    const ox = this.#splitOriginX;
    const oy = this.#splitOriginY;
    const sectors = new Set<number>();
    for (const th of threats) {
      sectors.add(Math.floor(((Math.atan2(th.y - oy, th.x - ox) + Math.PI) / TAU) * 8) % 8);
    }
    const k = this.splitCount > 0 ? this.splitCount : clamp(Math.round(sectors.size / 2), 2, 4);
    this.splitCount = k;
    const halfW = this.width / 2 - 140;
    const halfH = this.height / 2 - 130;

    if (threats.length === 0) {
      for (let g = 0; g < k; g++) {
        const a = (g / k) * TAU + 0.4;
        this.#splitGoalX[g] = clamp(ox + Math.cos(a) * 280, -halfW, halfW);
        this.#splitGoalY[g] = clamp(oy + Math.sin(a) * 240, -halfH, halfH);
      }
      return;
    }

    const byAngle = [...threats].sort(
      (a, b) => Math.atan2(a.y - oy, a.x - ox) - Math.atan2(b.y - oy, b.x - ox),
    );
    const mx = new Float32Array(k);
    const my = new Float32Array(k);
    for (let g = 0; g < k; g++) {
      const th = byAngle[Math.floor((g * byAngle.length) / k) % byAngle.length]!;
      mx[g] = th.x;
      my[g] = th.y;
    }
    const sumX = new Float32Array(k), sumY = new Float32Array(k), cnt = new Float32Array(k);
    for (let iter = 0; iter < 5; iter++) {
      sumX.fill(0); sumY.fill(0); cnt.fill(0);
      for (const th of threats) {
        let best = 0, bestD = Infinity;
        for (let g = 0; g < k; g++) {
          const d = (th.x - mx[g]!) ** 2 + (th.y - my[g]!) ** 2;
          if (d < bestD) { bestD = d; best = g; }
        }
        sumX[best]! += th.x; sumY[best]! += th.y; cnt[best]!++;
      }
      for (let g = 0; g < k; g++) {
        if (cnt[g]! > 0) { mx[g] = sumX[g]! / cnt[g]!; my[g] = sumY[g]! / cnt[g]!; }
      }
    }
    for (let g = 0; g < k; g++) {
      let dx = ox - mx[g]!;
      let dy = oy - my[g]!;
      let d = Math.hypot(dx, dy);
      if (d < 1) { dx = Math.cos(g * 2.4); dy = Math.sin(g * 2.4); d = 1; }
      // Empty cluster (more groups than distinct threats): fan out instead.
      const stand = cnt[g]! > 0 ? SPLIT_STANDOFF : 320;
      const ax = cnt[g]! > 0 ? mx[g]! + (dx / d) * stand : ox + Math.cos((g / k) * TAU) * stand;
      const ay = cnt[g]! > 0 ? my[g]! + (dy / d) * stand : oy + Math.sin((g / k) * TAU) * stand;
      this.#splitGoalX[g] = clamp(ax, -halfW, halfW);
      this.#splitGoalY[g] = clamp(ay, -halfH, halfH);
    }
    // Keep groups visibly apart even when clusters sit close together.
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const dx = this.#splitGoalX[b]! - this.#splitGoalX[a]!;
        const dy = this.#splitGoalY[b]! - this.#splitGoalY[a]!;
        const d = Math.hypot(dx, dy) + 1e-3;
        if (d < 330) {
          const push = (330 - d) / 2;
          this.#splitGoalX[a]! -= (dx / d) * push; this.#splitGoalY[a]! -= (dy / d) * push;
          this.#splitGoalX[b]! += (dx / d) * push; this.#splitGoalY[b]! += (dy / d) * push;
        }
      }
    }
  }

  #checkFormation(): void {
    if (this.cinematic.kind !== "none" || this.strategy === "FLOCK") return;
    let sum = 0, n = 0;
    for (let i = 0; i < CAPACITY; i += 4) {
      if (!this.alive[i]) continue;
      this.#target(i);
      sum += Math.hypot(this.px[i]! - this.#tx, this.py[i]! - this.#ty);
      n++;
    }
    this.#formationError = n > 0 ? sum / n : 0;
    const threshold = { FLOCK: 0, FLIGHT: 70, ATTACK: 60, DEFEND: 26, SPLIT: 36, REGROUP: 30 }[this.strategy];
    if (!this.#formationReported && this.strategyTime > 0.6 && this.#formationError < threshold) {
      this.#formationReported = true;
      const text = this.strategy === "ATTACK" ? "TARGET ENGAGED" : this.strategy === "SPLIT" ? `SPLIT INTO ${this.splitCount} GROUPS` : "FORMATION COMPLETE";
      this.events.push({ type: "log", text, tone: "success" });
    }
    if (this.strategy === "REGROUP" && this.strategyTime > 3.4 && this.#formationError < 34) {
      this.#regroupCompletedAt = this.time;
      this.events.push({ type: "log", text: "COHESION RESTORED", tone: "success" });
      this.#setStrategy("FLOCK", "auto");
    }
  }

  // ───────────────────────────── threats ─────────────────────────────

  #spawnThreat(x: number, y: number): void {
    if (this.threats.length >= MAX_THREATS) return;
    const rng = this.#rng;
    const strength = rng.range(40, 92);
    const th: Threat = {
      id: this.#nextThreatId++,
      x: clamp(x, -this.width / 2 + 40, this.width / 2 - 40),
      y: clamp(y, -this.height / 2 + 40, this.height / 2 - 40),
      vx: 0,
      vy: 0,
      heading: rng.next() * TAU,
      radius: rng.range(17, 29),
      speed: rng.range(14, 34),
      strength,
      health: 0,
      maxHealth: 0,
      status: "spawning",
      age: 0,
      contact: 0,
      wanderPhase: rng.next() * TAU,
    };
    th.maxHealth = th.health = 55 + strength * 0.7;
    this.threats.push(th);
    this.events.push({ type: "threatSpawned", x: th.x, y: th.y, radius: th.radius, id: th.id });
  }

  #spawnThreats(count: number, chaos: boolean): void {
    const rng = this.#rng;
    const base = rng.next() * TAU;
    for (let n = 0; n < count; n++) {
      const a = base + (n / count) * TAU + rng.range(-0.25, 0.25);
      const r = chaos ? rng.range(250, 520) : rng.range(300, 560);
      this.#spawnThreat(this.centerX + Math.cos(a) * r, this.centerY + Math.sin(a) * r * 0.85);
    }
    if (chaos) {
      this.events.push(
        { type: "flash", strength: 0.55, color: 0xff315a },
        { type: "shake", strength: 1 },
        { type: "log", text: "CRITICAL EVENT", tone: "threat" },
      );
    }
  }

  #clearThreats(): void {
    for (const th of this.threats) {
      this.events.push({ type: "explosion", x: th.x, y: th.y, radius: th.radius, color: 0xff315a });
    }
    this.threats = [];
    this.attackTargetId = -1;
  }

  #updateThreats(dt: number): void {
    const halfW = this.width / 2;
    const halfH = this.height / 2;
    for (const th of this.threats) {
      th.age += dt;
      if (th.status === "spawning" && th.age > 0.7) th.status = "active";
      th.heading += Math.sin(this.time * 0.5 + th.wanderPhase) * 0.5 * dt;
      // Drift: mostly wander, partly hunt the swarm so situations escalate on their own.
      const tx = this.centerX - th.x;
      const ty = this.centerY - th.y;
      const td = Math.hypot(tx, ty) + 1e-3;
      const hunt = td > 160 ? 0.45 : 0;
      const dx = Math.cos(th.heading) * (1 - hunt) + (tx / td) * hunt;
      const dy = Math.sin(th.heading) * (1 - hunt) + (ty / td) * hunt;
      const spawnEase = th.status === "spawning" ? th.age / 0.7 : 1;
      th.vx = dx * th.speed * spawnEase;
      th.vy = dy * th.speed * spawnEase;
      th.x += th.vx * dt;
      th.y += th.vy * dt;
      if (th.x < -halfW + th.radius || th.x > halfW - th.radius) {
        th.heading = Math.PI - th.heading;
        th.x = clamp(th.x, -halfW + th.radius, halfW - th.radius);
      }
      if (th.y < -halfH + th.radius || th.y > halfH - th.radius) {
        th.heading = -th.heading;
        th.y = clamp(th.y, -halfH + th.radius, halfH - th.radius);
      }
    }
  }

  #damageAttackTarget(contact: number, dt: number): void {
    const target = this.getThreat(this.attackTargetId);
    if (!target) return;
    // Once the swarm has reached the target, the vortex tightens over ~1.5 s.
    this.#attackEngage += ((this.#attackEngaged ? 1 : 0) - this.#attackEngage) * smoothing(dt, 0.6);
    if (!this.#attackEngaged && contact > 60) {
      this.#attackEngaged = true;
      this.events.push({ type: "pulse", x: target.x, y: target.y, color: 0xff315a, strength: 0.6 });
    }
    target.health -= contact * 0.13 * dt * (1 - 0.35 * this.conserve) * (1 + 0.5 * this.urgency);
    if (target.health > 0) return;

    this.threats = this.threats.filter((t) => t !== target);
    this.events.push(
      { type: "explosion", x: target.x, y: target.y, radius: target.radius, color: 0xff315a, big: true },
      { type: "pulse", x: target.x, y: target.y, color: 0xff7a93, strength: 1 },
      { type: "shake", strength: 0.6 },
      { type: "threatDestroyed", x: target.x, y: target.y, id: target.id, remaining: this.threats.length },
      { type: "log", text: "THREAT NEUTRALIZED", tone: "success" },
    );
    this.energy = Math.min(100, this.energy + 6);
    const next = this.#nearestThreat();
    this.attackTargetId = next?.id ?? -1;
    this.#attackEngaged = false;
    this.#attackEngage = 0;
  }

  #absorb(i: number): void {
    this.alive[i] = 0;
    this.aliveCount--;
    this.energy = Math.max(0, this.energy - 0.25);
    this.events.push({ type: "absorb", x: this.px[i]!, y: this.py[i]! });
  }

  // ───────────────────────────── energy & population ─────────────────────────────

  #updateEnergy(dt: number): void {
    if (this.cinematic.kind !== "none") return;
    let rate = ENERGY_RATE[this.strategy];
    if (rate < 0) rate *= (1 - 0.55 * this.conserve) * (0.8 + 0.4 * this.urgency);
    let contact = 0;
    for (const th of this.threats) contact += th.contact;
    if (this.strategy === "ATTACK") contact *= 0.2;
    this.energy = clamp(this.energy + rate * dt - contact * 0.003 * dt, 0, 100);
    if (!this.#energyWarned && this.energy < 20) {
      this.#energyWarned = true;
      this.events.push({ type: "log", text: "ENERGY CRITICAL", tone: "warn" });
    } else if (this.#energyWarned && this.energy > 32) {
      this.#energyWarned = false;
    }
  }

  #reviveFallen(dt: number): void {
    if (this.cinematic.kind !== "none" || this.aliveCount >= CAPACITY || this.energy < 35) return;
    const near = this.#nearestThreat();
    if (near && Math.hypot(near.x - this.centerX, near.y - this.centerY) < 300) return;
    this.#reviveTimer += dt;
    while (this.#reviveTimer > 0.05 && this.aliveCount < CAPACITY) {
      this.#reviveTimer -= 0.05;
      this.#reviveOne();
    }
  }

  /** Brings one fallen individual back next to a living one ("cell division"). */
  #reviveOne(): boolean {
    let dead = -1;
    for (let i = 0; i < CAPACITY; i++) {
      if (!this.alive[i]) {
        dead = i;
        break;
      }
    }
    if (dead < 0) return false;
    let parent = -1;
    const start = this.#rng.int(0, CAPACITY - 1);
    for (let k = 0; k < CAPACITY; k++) {
      const j = (start + k) % CAPACITY;
      if (this.alive[j]) {
        parent = j;
        break;
      }
    }
    const a = this.#rng.next() * TAU;
    const ox = parent >= 0 ? this.px[parent]! : this.anchorX;
    const oy = parent >= 0 ? this.py[parent]! : this.anchorY;
    this.px[dead] = this.prevX[dead] = ox + Math.cos(a) * 3;
    this.py[dead] = this.prevY[dead] = oy + Math.sin(a) * 3;
    this.vx[dead] = (parent >= 0 ? this.vx[parent]! : 0) + Math.cos(a) * 60;
    this.vy[dead] = (parent >= 0 ? this.vy[parent]! : 0) + Math.sin(a) * 60;
    this.heat[dead] = 1;
    this.alive[dead] = 1;
    this.aliveCount++;
    return true;
  }

  // ───────────────────────────── cinematics ─────────────────────────────

  #startAwakening(): void {
    this.#clearThreatsSilently();
    for (let i = 1; i < CAPACITY; i++) this.alive[i] = 0;
    this.alive[0] = 1;
    this.px[0] = this.prevX[0] = 0;
    this.py[0] = this.prevY[0] = 0;
    this.vx[0] = 20;
    this.vy[0] = 0;
    this.heat[0] = 1;
    this.aliveCount = 1;
    this.anchorX = this.anchorY = 0;
    this.strategy = "FLOCK";
    copyParams(STRATEGY_PARAMS.FLOCK, this.params);
    this.energy = 100;
    this.cinematic = { kind: "awakening", t: 0 };
  }

  #startSingularity(): void {
    this.#clearThreats();
    this.strategy = "REGROUP";
    this.lastCause = "cinematic";
    this.strategyTime = 0;
    this.#transitionDuration = 1.2;
    this.cinematic = { kind: "singularity", t: 0, exploded: false };
    this.events.push({ type: "pulse", x: this.centerX, y: this.centerY, color: 0xffffff, strength: 0.6 });
  }

  #clearThreatsSilently(): void {
    this.threats = [];
    this.attackTargetId = -1;
  }

  #updateCinematic(dt: number): void {
    const c = this.cinematic;
    if (c.kind === "none") {
      this.glow += ((this.strategy === "REGROUP" ? 0.32 * this.formBlend : 0) - this.glow) * smoothing(dt, 0.6);
      return;
    }
    c.t += dt;

    if (c.kind === "awakening") {
      const want = Math.min(CAPACITY, Math.floor(Math.exp((c.t * Math.log(CAPACITY)) / 6.2)));
      while (this.aliveCount < want && this.#reviveOne()) {
        /* grow */
      }
      this.glow = Math.max(0, 0.9 - c.t / 7);
      if (c.t > 7.5) {
        this.cinematic = { kind: "none" };
        this.events.push({ type: "log", text: "SWARM ONLINE · 1,000 INDIVIDUALS", tone: "success" });
      }
      return;
    }

    // Singularity: collapse → ignition → burst → fade.
    copyParams(STRATEGY_PARAMS.REGROUP, this.params);
    this.params.formation = 4.2;
    this.params.maxSpeed = 300;
    this.formBlend = 1;
    if (!c.exploded) {
      this.glow = easeInCubic(clamp01(c.t / 4.2));
      if (c.t >= 4.5) {
        c.exploded = true;
        const rng = this.#rng;
        for (let i = 0; i < CAPACITY; i++) {
          if (!this.alive[i]) continue;
          const a = rng.next() * TAU;
          const speed = 160 + Math.pow(rng.next(), 1.6) * 1250;
          this.vx[i] = Math.cos(a) * speed;
          this.vy[i] = Math.sin(a) * speed;
          this.heat[i] = 1;
        }
        this.events.push(
          { type: "explosion", x: this.anchorX, y: this.anchorY, radius: 60, color: 0xffffff, big: true },
          { type: "pulse", x: this.anchorX, y: this.anchorY, color: 0xffffff, strength: 2.2 },
          { type: "flash", strength: 0.9, color: 0xe8fdff },
          { type: "shake", strength: 1.2 },
        );
      }
    } else {
      const ft = c.t - 4.5;
      this.glow = Math.max(0, 1 - ft * 1.5);
      this.fade = 1 - easeOutCubic(clamp01(ft / 4.5));
    }
  }
}
