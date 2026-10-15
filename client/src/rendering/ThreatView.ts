import { Particle, ParticleContainer, Rectangle } from "pixi.js";
import { clamp01, easeOutCubic } from "../simulation/math.ts";
import type { Threat } from "../simulation/World.ts";
import { SWARM_DOT_SCALE } from "./SwarmView.ts";
import type { Textures } from "./textures.ts";

const RED = 0xff315a;
const HOT = 0xffd6de;
const MAX_THREATS = 40;
/** Threat dots are ~1.8× the size of a swarm individual. */
const SCALE = SWARM_DOT_SCALE * 1.8;

/**
 * Each threat is a single red light point in the swarm's own style. It renders into the
 * swarm's trail/bloom buffer, so it leaves the same short light trail.
 */
export class ThreatView {
  readonly view: ParticleContainer;
  readonly #particles: Particle[] = [];
  readonly #slots = new Map<number, number>();
  readonly #free: number[] = [];
  #time = 0;

  constructor(tex: Textures) {
    this.view = new ParticleContainer({
      dynamicProperties: { position: true, vertex: true, color: true, rotation: true },
      texture: tex.particle,
    });
    this.view.boundsArea = new Rectangle(-1e5, -1e5, 2e5, 2e5);
    this.view.blendMode = "add";
    for (let i = 0; i < MAX_THREATS; i++) {
      const p = new Particle({ texture: tex.particle, anchorX: 0.5, anchorY: 0.5, tint: RED, alpha: 0 });
      this.#particles.push(p);
      this.view.addParticle(p);
    }
    for (let i = MAX_THREATS - 1; i >= 0; i--) this.#free.push(i);
  }

  clear(): void {
    for (const id of [...this.#slots.keys()]) this.#release(id);
  }

  update(threats: readonly Threat[], dt: number, attackTargetId: number): void {
    this.#time += dt;
    const t = this.#time;
    const seen = new Set<number>();

    for (const th of threats) {
      let slot = this.#slots.get(th.id);
      if (slot === undefined) {
        slot = this.#free.pop();
        if (slot === undefined) continue;
        this.#slots.set(th.id, slot);
      }
      seen.add(th.id);

      const p = this.#particles[slot]!;
      const spawn = easeOutCubic(clamp01(th.age / 0.6));
      const speed = Math.hypot(th.vx, th.vy);
      const pulse = 1 + 0.08 * Math.sin(t * 4 + th.id);
      // Damaged threats flicker hotter; spawning ones flash in from bright and large.
      const damage = 1 - th.health / th.maxHealth;
      const flicker = damage > 0 && th.id === attackTargetId ? 0.5 + 0.5 * Math.sin(t * 30) : 0;
      p.x = th.x;
      p.y = th.y;
      p.rotation = Math.atan2(th.vy, th.vx);
      const s = SCALE * pulse * (1 + (1 - spawn) * 1.2);
      p.scaleX = s * (1 + Math.min(speed / 230, 0.6));
      p.scaleY = s;
      p.tint = flicker > 0.5 || spawn < 0.5 ? HOT : RED;
      p.alpha = 0.95;
    }

    for (const id of [...this.#slots.keys()]) if (!seen.has(id)) this.#release(id);
  }

  #release(id: number): void {
    const slot = this.#slots.get(id)!;
    this.#particles[slot]!.alpha = 0;
    this.#free.push(slot);
    this.#slots.delete(id);
  }
}
