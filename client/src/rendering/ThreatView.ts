import { Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite } from "pixi.js";
import { angleDelta, clamp01, easeOutCubic, GOLDEN_ANGLE, smoothing, TAU } from "../simulation/math.ts";
import type { Threat } from "../simulation/World.ts";
import type { Textures } from "./textures.ts";

const RED = 0xff315a;
const LIMB = 0xff5c7f;
const EYE = 0xffe3ea;
const HOT = 0xffc2cd;
const MAX_BUGS = 40;

/** One glowing dot of the bug template, in units of the bug size, facing +x. */
interface Dot {
  x: number;
  y: number;
  scale: number;
  color: number;
  alpha: number;
  /** Legs and antennae are animated; body dots only shimmer. */
  limb?: { kind: "leg" | "antenna"; index: number; side: 1 | -1; t: number };
}

const LEG_PAIRS = 3;
const LEG_DOTS = 4;
const ANTENNA_DOTS = 4;

/** A bug drawn as a constellation of light points, like the swarm itself. */
function buildTemplate(): Dot[] {
  const dots: Dot[] = [];
  const blob = (cx: number, cy: number, rx: number, ry: number, n: number, scale: number, striped = false) => {
    for (let k = 0; k < n; k++) {
      const r = Math.sqrt((k + 0.5) / n);
      const a = k * GOLDEN_ANGLE;
      const x = cx + Math.cos(a) * r * rx;
      const y = cy + Math.sin(a) * r * ry;
      // Abdomen stripes: dimmer bands along the body.
      const band = striped ? 0.55 + 0.45 * Math.abs(Math.cos((x - cx) * 9)) : 1;
      dots.push({ x, y, scale, color: RED, alpha: band });
    }
  };
  blob(-0.48, 0, 0.56, 0.38, 24, 0.15, true); // abdomen
  blob(0.14, 0, 0.22, 0.2, 7, 0.15); // thorax
  blob(0.5, 0, 0.17, 0.16, 5, 0.14); // head
  for (const side of [-1, 1] as const) dots.push({ x: 0.63, y: side * 0.11, scale: 0.24, color: EYE, alpha: 1 });
  for (let index = 0; index < LEG_PAIRS; index++) {
    for (const side of [-1, 1] as const) {
      for (let k = 1; k <= LEG_DOTS; k++) {
        dots.push({ x: 0, y: 0, scale: 0.11, color: LIMB, alpha: 0.85, limb: { kind: "leg", index, side, t: k / LEG_DOTS } });
      }
    }
  }
  for (const side of [-1, 1] as const) {
    for (let k = 1; k <= ANTENNA_DOTS; k++) {
      dots.push({ x: 0, y: 0, scale: k === ANTENNA_DOTS ? 0.15 : 0.1, color: LIMB, alpha: 0.85, limb: { kind: "antenna", index: 0, side, t: k / ANTENNA_DOTS } });
    }
  }
  return dots;
}

const TEMPLATE = buildTemplate();

interface Bug {
  aura: Sprite;
  overlay: Graphics;
  heading: number;
  size: number;
  seed: number;
  /** Scatter offsets the dots fly in from while the threat spawns. */
  scatter: Float32Array;
  slot: number;
}

/**
 * Threats are bugs made of glowing red points. The dots render into the same trail/bloom
 * buffer as the swarm (`dotView`), so both share one look; aura and HUD marks live in `view`.
 */
export class ThreatView {
  readonly view = new Container();
  readonly dotView: ParticleContainer;
  readonly #tex: Textures;
  readonly #bugs = new Map<number, Bug>();
  readonly #particles: Particle[] = [];
  readonly #freeSlots: number[] = [];
  #time = 0;

  constructor(tex: Textures) {
    this.#tex = tex;
    this.dotView = new ParticleContainer({
      dynamicProperties: { position: true, vertex: true, color: true, rotation: false },
      texture: tex.particle,
    });
    this.dotView.boundsArea = new Rectangle(-1e5, -1e5, 2e5, 2e5);
    this.dotView.blendMode = "add";
    for (let i = 0; i < MAX_BUGS * TEMPLATE.length; i++) {
      const p = new Particle({ texture: tex.particle, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
      this.#particles.push(p);
      this.dotView.addParticle(p);
    }
    for (let s = MAX_BUGS - 1; s >= 0; s--) this.#freeSlots.push(s);
  }

  clear(): void {
    for (const id of [...this.#bugs.keys()]) this.#remove(id);
  }

  update(threats: readonly Threat[], dt: number, attackTargetId: number): void {
    this.#time += dt;
    const t = this.#time;
    const seen = new Set<number>();

    for (const th of threats) {
      let bug = this.#bugs.get(th.id);
      if (!bug) {
        const created = this.#create(th);
        if (!created) continue;
        bug = created;
        this.#bugs.set(th.id, bug);
      }
      seen.add(th.id);

      const S = bug.size;
      const speed = Math.hypot(th.vx, th.vy);
      if (speed > 1) bug.heading += angleDelta(bug.heading, Math.atan2(th.vy, th.vx)) * smoothing(dt, 0.35);
      const cos = Math.cos(bug.heading);
      const sin = Math.sin(bug.heading);
      const spawn = easeOutCubic(clamp01(th.age / 0.9));
      const gait = t * (6 + speed * 0.25) + bug.seed;
      const breathe = 1 + 0.04 * Math.sin(t * 3 + bug.seed);

      const base = bug.slot * TEMPLATE.length;
      for (let d = 0; d < TEMPLATE.length; d++) {
        const dot = TEMPLATE[d]!;
        let lx = dot.x * breathe;
        let ly = dot.y * breathe;
        if (dot.limb) [lx, ly] = limbPoint(dot.limb, gait, t + bug.seed);
        // Living shimmer.
        lx += Math.sin(t * 7 + d * 1.7) * 0.012;
        ly += Math.cos(t * 6 + d * 2.3) * 0.012;
        // Materialise: dots converge from a scattered cloud.
        const k = 1 - spawn;
        lx += bug.scatter[d * 2]! * k;
        ly += bug.scatter[d * 2 + 1]! * k;

        const p = this.#particles[base + d]!;
        p.x = th.x + (lx * cos - ly * sin) * S;
        p.y = th.y + (lx * sin + ly * cos) * S;
        const s = dot.scale * (S / 30) * (1 + k * 0.6);
        p.scaleX = p.scaleY = s;
        p.tint = dot.color;
        p.alpha = dot.alpha * (0.85 + 0.15 * Math.sin(t * 5 + d)) * (0.4 + 0.6 * spawn);
      }

      bug.aura.position.set(th.x, th.y);
      bug.aura.scale.set(((S * 3.6) / 256) * (0.95 + 0.08 * Math.sin(t * 2.4 + bug.seed)));
      bug.aura.alpha = 0.16 + 0.5 * (1 - spawn);

      const g = bug.overlay;
      g.clear();
      g.position.set(th.x, th.y);
      if (th.health < th.maxHealth - 0.5) {
        const frac = Math.max(0, th.health / th.maxHealth);
        g.arc(0, 0, S * 1.25, -Math.PI / 2, -Math.PI / 2 + frac * TAU).stroke({ width: 2.5, color: HOT, alpha: 0.9 });
      }
      if (th.id === attackTargetId) {
        // Lock-on brackets while the swarm attacks this bug.
        const rr = S * 1.25 + 14 + Math.sin(t * 6) * 3;
        for (let q = 0; q < 4; q++) {
          const a = q * (Math.PI / 2) + t * 1.4;
          g.arc(0, 0, rr, a - 0.28, a + 0.28).stroke({ width: 2, color: RED, alpha: 0.95 });
        }
      }
    }

    for (const id of [...this.#bugs.keys()]) if (!seen.has(id)) this.#remove(id);
  }

  #create(th: Threat): Bug | null {
    const slot = this.#freeSlots.pop();
    if (slot === undefined) return null;
    const aura = new Sprite({ texture: this.#tex.glow, anchor: 0.5, tint: RED, blendMode: "add" });
    const overlay = new Graphics();
    this.view.addChild(aura, overlay);
    const scatter = new Float32Array(TEMPLATE.length * 2);
    for (let i = 0; i < TEMPLATE.length; i++) {
      const a = Math.random() * TAU;
      const r = 1.5 + Math.random() * 2.5;
      scatter[i * 2] = Math.cos(a) * r;
      scatter[i * 2 + 1] = Math.sin(a) * r;
    }
    return {
      aura,
      overlay,
      heading: Math.atan2(th.vy, th.vx) || th.heading,
      size: th.radius * 1.7,
      seed: Math.random() * 6,
      scatter,
      slot,
    };
  }

  #remove(id: number): void {
    const bug = this.#bugs.get(id);
    if (!bug) return;
    bug.aura.destroy();
    bug.overlay.destroy();
    const base = bug.slot * TEMPLATE.length;
    for (let d = 0; d < TEMPLATE.length; d++) this.#particles[base + d]!.alpha = 0;
    this.#freeSlots.push(bug.slot);
    this.#bugs.delete(id);
  }
}

/** Position of a leg/antenna dot in bug units: tripod gait for legs, sway for antennae. */
function limbPoint(limb: NonNullable<Dot["limb"]>, gait: number, t: number): [number, number] {
  const { side, t: u } = limb;
  if (limb.kind === "antenna") {
    const sway = Math.sin(t * 4 + side * 1.3) * 0.12;
    const x = 0.62 + u * 0.38;
    const y = side * (0.07 + u * 0.32 + u * u * 0.08) + sway * u;
    return [x, y];
  }
  // Legs attach along the thorax and fan out front / side / back.
  const i = limb.index;
  const rootX = 0.24 - i * 0.14;
  const rootY = side * 0.16;
  const spread = (0.7 - i * 0.7) * 0.9; // front legs reach forward, back legs backward
  // Tripod gait: legs 0 and 2 of one side move with leg 1 of the other side.
  const phase = (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? 0 : Math.PI);
  const swing = Math.sin(gait + phase) * 0.18;
  const kneeX = rootX + (spread * 0.35 + swing * 0.5);
  const kneeY = side * 0.42;
  const footX = rootX + spread * 0.75 + swing;
  const footY = side * 0.58;
  if (u <= 0.5) {
    const k = u / 0.5;
    return [rootX + (kneeX - rootX) * k, rootY + (kneeY - rootY) * k];
  }
  const k = (u - 0.5) / 0.5;
  return [kneeX + (footX - kneeX) * k, kneeY + (footY - kneeY) * k];
}
