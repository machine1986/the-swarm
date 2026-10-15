import { Particle, ParticleContainer, Rectangle } from "pixi.js";
import { lerpColor, smoothing } from "../simulation/math.ts";
import { STRATEGY_COLORS } from "../simulation/strategies.ts";
import { CAPACITY, type World } from "../simulation/World.ts";
import type { Textures } from "./textures.ts";

const SWARM = 0x00e5ff;
const ACTIVE = 0x00ffd1;
/** Base sprite scale of one swarm individual; threats are sized relative to it. */
export const SWARM_DOT_SCALE = 0.155;

/** All 1,000 individuals in a single batched draw call: glowing core stretched along velocity. */
export class SwarmView {
  readonly view: ParticleContainer;
  readonly #particles: Particle[] = [];
  #color = SWARM;
  #activity = 0;

  constructor(tex: Textures) {
    this.view = new ParticleContainer({
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true },
      texture: tex.particle,
    });
    this.view.boundsArea = new Rectangle(-1e5, -1e5, 2e5, 2e5);
    this.view.blendMode = "add";
    for (let i = 0; i < CAPACITY; i++) {
      const p = new Particle({ texture: tex.particle, anchorX: 0.5, anchorY: 0.5, tint: SWARM, alpha: 0 });
      this.#particles.push(p);
      this.view.addParticle(p);
    }
  }

  update(world: World, alpha: number, dt: number): void {
    const { px, py, prevX, prevY, vx, vy, alive, bright, heat } = world;
    const active = world.strategy !== "FLOCK" || world.urgency > 0.3;
    this.#activity += ((active ? 1 : 0) - this.#activity) * smoothing(dt, 0.8);
    const strategyTint = lerpColor(ACTIVE, STRATEGY_COLORS[world.strategy], 0.25);
    const target = lerpColor(SWARM, strategyTint, this.#activity);
    this.#color = lerpColor(this.#color, target, smoothing(dt, 0.5));

    const glow = world.glow;
    const fade = world.fade;
    const sizeBoost = 1 + glow * 0.5;
    for (let i = 0; i < CAPACITY; i++) {
      const p = this.#particles[i]!;
      if (!alive[i] || fade <= 0.001) {
        p.alpha = 0;
        continue;
      }
      p.x = prevX[i]! + (px[i]! - prevX[i]!) * alpha;
      p.y = prevY[i]! + (py[i]! - prevY[i]!) * alpha;
      const ivx = vx[i]!;
      const ivy = vy[i]!;
      const speed = Math.sqrt(ivx * ivx + ivy * ivy);
      p.rotation = Math.atan2(ivy, ivx);
      const s = SWARM_DOT_SCALE * sizeBoost * (0.85 + bright[i]! * 0.3);
      p.scaleX = s * (1 + Math.min(speed / 230, 2.6));
      p.scaleY = s;
      const h = heat[i]!;
      p.tint = h > 0.02 || glow > 0.02 ? lerpColor(this.#color, 0xffffff, Math.min(1, h * 0.7 + glow * 0.45)) : this.#color;
      p.alpha = Math.min(1, (0.32 + bright[i]! * 0.5 + h * 0.4) * fade);
    }
  }
}
