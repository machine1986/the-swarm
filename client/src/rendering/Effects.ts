import { Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite } from "pixi.js";
import { clamp01, easeOutCubic, easeOutExpo, smoothing, TAU } from "../simulation/math.ts";
import type { World } from "../simulation/World.ts";
import type { Textures } from "./textures.ts";

const SPARKS = 4200;
const RINGS = 16;

interface Ring {
  sprite: Sprite;
  halo: Sprite;
  x: number;
  y: number;
  t: number;
  duration: number;
  maxRadius: number;
  /** Negative: implode (spawn effect). */
  direction: 1 | -1;
  strength: number;
  active: boolean;
}

/** Pooled transient effects: energy pulses, explosions, sparks, barrier, focus glows. */
export class Effects {
  readonly view = new Container();
  readonly #sparkView: ParticleContainer;
  readonly #sparks: Particle[] = [];
  readonly #sx = new Float32Array(SPARKS);
  readonly #sy = new Float32Array(SPARKS);
  readonly #svx = new Float32Array(SPARKS);
  readonly #svy = new Float32Array(SPARKS);
  readonly #life = new Float32Array(SPARKS);
  readonly #maxLife = new Float32Array(SPARKS);
  readonly #size = new Float32Array(SPARKS);
  readonly #drag = new Float32Array(SPARKS);
  #cursor = 0;
  readonly #rings: Ring[] = [];
  readonly #barrier = new Graphics();
  readonly #barrierGlow: Sprite;
  readonly #core: Sprite;
  readonly #groupMarks = new Graphics();
  #barrierAlpha = 0;
  #splitAlpha = 0;
  #time = 0;

  constructor(tex: Textures) {
    this.#barrierGlow = new Sprite({ texture: tex.ring, anchor: 0.5, tint: 0x2f8bff, blendMode: "add", alpha: 0 });
    this.#barrier.blendMode = "add";
    this.#groupMarks.blendMode = "add";
    this.#core = new Sprite({ texture: tex.glow, anchor: 0.5, tint: 0xbff9ff, blendMode: "add", alpha: 0 });
    this.view.addChild(this.#barrierGlow, this.#barrier, this.#groupMarks, this.#core);

    for (let i = 0; i < RINGS; i++) {
      const sprite = new Sprite({ texture: tex.ring, anchor: 0.5, blendMode: "add", alpha: 0 });
      const halo = new Sprite({ texture: tex.glow, anchor: 0.5, blendMode: "add", alpha: 0 });
      this.view.addChild(halo, sprite);
      this.#rings.push({ sprite, halo, x: 0, y: 0, t: 0, duration: 1, maxRadius: 1, direction: 1, strength: 1, active: false });
    }

    this.#sparkView = new ParticleContainer({
      dynamicProperties: { position: true, vertex: true, color: true, rotation: false },
      texture: tex.spark,
    });
    this.#sparkView.boundsArea = new Rectangle(-1e5, -1e5, 2e5, 2e5);
    this.#sparkView.blendMode = "add";
    for (let i = 0; i < SPARKS; i++) {
      const p = new Particle({ texture: tex.spark, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
      this.#sparks.push(p);
      this.#sparkView.addParticle(p);
    }
    this.view.addChild(this.#sparkView);
  }

  clear(): void {
    this.#life.fill(0);
    for (const p of this.#sparks) p.alpha = 0;
    for (const r of this.#rings) {
      r.active = false;
      r.sprite.alpha = r.halo.alpha = 0;
    }
  }

  pulse(x: number, y: number, color: number, strength: number): void {
    this.#ring(x, y, color, 1, 240 + strength * 520, 0.9 + strength * 0.5, strength);
    this.#ring(x, y, color, 1, 140 + strength * 300, 0.7 + strength * 0.3, strength * 0.6);
  }

  spawnFx(x: number, y: number, radius: number): void {
    this.#ring(x, y, 0xff315a, -1, radius * 6, 0.55, 0.9);
    this.burst(x, y, 0xff6f8a, 26, 60, 220, 0.5, 0.9, 0.35);
  }

  explosion(x: number, y: number, radius: number, color: number, big = false): void {
    if (big && color === 0xffffff) {
      // Singularity burst: thousands of light particles.
      this.burst(x, y, 0xffffff, 1400, 120, 1500, 1.2, 3.6, 0.5);
      this.burst(x, y, 0x00e5ff, 1300, 80, 1100, 1.4, 4.2, 0.45);
      this.burst(x, y, 0xb388ff, 600, 60, 800, 1.2, 3.8, 0.4);
      this.#ring(x, y, 0xffffff, 1, 1900, 2.4, 2);
      return;
    }
    this.burst(x, y, color, big ? 170 : 50, 60, big ? 520 : 260, 0.5, big ? 1.5 : 0.9, big ? 0.55 : 0.4);
    this.burst(x, y, 0xffd6de, big ? 60 : 16, 30, big ? 300 : 150, 0.3, 0.8, 0.35);
    this.#ring(x, y, color, 1, radius * (big ? 9 : 4), big ? 0.8 : 0.5, big ? 1.2 : 0.6);
  }

  absorb(x: number, y: number): void {
    this.burst(x, y, 0xff315a, 7, 30, 140, 0.25, 0.6, 0.3);
  }

  ember(x: number, y: number, vx: number, vy: number): void {
    this.#emit(x, y, vx + (Math.random() - 0.5) * 30, vy + (Math.random() - 0.5) * 30, 0xff4d6d, 0.6 + Math.random() * 0.8, 0.22 + Math.random() * 0.2, 0.6);
  }

  burst(x: number, y: number, color: number, count: number, minSpeed: number, maxSpeed: number, minLife: number, maxLife: number, size: number): void {
    for (let n = 0; n < count; n++) {
      const a = Math.random() * TAU;
      const sp = minSpeed + Math.pow(Math.random(), 1.8) * (maxSpeed - minSpeed);
      this.#emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, color, minLife + Math.random() * (maxLife - minLife), size * (0.6 + Math.random() * 0.8), 0.9);
    }
  }

  #emit(x: number, y: number, vx: number, vy: number, color: number, life: number, size: number, drag: number): void {
    const i = this.#cursor;
    this.#cursor = (this.#cursor + 1) % SPARKS;
    this.#sx[i] = x;
    this.#sy[i] = y;
    this.#svx[i] = vx;
    this.#svy[i] = vy;
    this.#life[i] = life;
    this.#maxLife[i] = life;
    this.#size[i] = size;
    this.#drag[i] = drag;
    this.#sparks[i]!.tint = color;
  }

  #ring(x: number, y: number, color: number, direction: 1 | -1, maxRadius: number, duration: number, strength: number): void {
    const ring = this.#rings.find((r) => !r.active) ?? this.#rings.reduce((a, b) => (a.t / a.duration > b.t / b.duration ? a : b));
    Object.assign(ring, { x, y, t: 0, duration, maxRadius, direction, strength, active: true });
    ring.sprite.tint = color;
    ring.halo.tint = color;
  }

  update(dt: number, world: World): void {
    this.#time += dt;

    for (const r of this.#rings) {
      if (!r.active) continue;
      r.t += dt;
      const k = clamp01(r.t / r.duration);
      if (k >= 1) {
        r.active = false;
        r.sprite.alpha = r.halo.alpha = 0;
        continue;
      }
      const grow = r.direction === 1 ? easeOutExpo(k) : 1 - easeOutCubic(k);
      const radius = Math.max(4, r.maxRadius * grow);
      r.sprite.position.set(r.x, r.y);
      r.sprite.scale.set((radius * 2) / 512);
      r.sprite.alpha = (1 - k) * Math.min(1, 0.55 * r.strength + 0.3);
      r.halo.position.set(r.x, r.y);
      r.halo.scale.set((radius * 1.4) / 256);
      r.halo.alpha = (1 - k) * (1 - k) * 0.22 * r.strength;
    }

    const life = this.#life;
    for (let i = 0; i < SPARKS; i++) {
      const p = this.#sparks[i]!;
      if (life[i]! <= 0) {
        if (p.alpha !== 0) p.alpha = 0;
        continue;
      }
      life[i]! -= dt;
      const d = Math.pow(this.#drag[i]! * 0.5, dt);
      this.#svx[i]! *= d;
      this.#svy[i]! *= d;
      this.#sx[i]! += this.#svx[i]! * dt;
      this.#sy[i]! += this.#svy[i]! * dt;
      const k = Math.max(0, life[i]! / this.#maxLife[i]!);
      p.x = this.#sx[i]!;
      p.y = this.#sy[i]!;
      const s = this.#size[i]! * (0.4 + 0.6 * k);
      p.scaleX = p.scaleY = s;
      p.alpha = k * k;
    }

    this.#updateBarrier(dt, world);
    this.#updateSplitMarks(dt, world);

    // Concentrated light during REGROUP and the singularity.
    const g = world.glow;
    this.#core.position.set(world.anchorX, world.anchorY);
    this.#core.scale.set((90 + g * 260) / 256 * (1 + 0.04 * Math.sin(this.#time * 8)));
    this.#core.alpha = g * 0.85 * world.fade;
  }

  #updateBarrier(dt: number, world: World): void {
    const want = world.strategy === "DEFEND" && world.cinematic.kind === "none" ? world.formBlend : 0;
    this.#barrierAlpha += (want - this.#barrierAlpha) * smoothing(dt, 0.35);
    const g = this.#barrier;
    g.clear();
    this.#barrierGlow.alpha = this.#barrierAlpha * 0.35;
    if (this.#barrierAlpha < 0.01) return;

    const popScale = 0.55 + 0.45 * Math.sqrt(Math.max(world.aliveCount, 30) / world.capacity);
    const R = 232 * popScale + 38;
    const cx = world.anchorX;
    const cy = world.anchorY;
    const t = this.#time;
    const a = this.#barrierAlpha;
    this.#barrierGlow.position.set(cx, cy);
    this.#barrierGlow.scale.set((R * 2.1) / 512);

    // Segmented energy shield with a travelling shimmer.
    const segments = 48;
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * TAU + t * 0.15;
      const a1 = a0 + (TAU / segments) * 0.72;
      const shimmer = 0.35 + 0.65 * Math.max(0, Math.sin(s * 0.9 - t * 3.2));
      g.arc(cx, cy, R, a0, a1).stroke({ width: 2.2, color: 0x6fb2ff, alpha: a * (0.25 + shimmer * 0.55) });
    }
    g.circle(cx, cy, R + 9).stroke({ width: 1, color: 0x2f8bff, alpha: a * 0.35 });
    g.circle(cx, cy, 40 * popScale).stroke({ width: 1, color: 0x9fd0ff, alpha: a * 0.3 });
    // Hex lattice ticks on the inner edge.
    for (let s = 0; s < 6; s++) {
      const ang = (s / 6) * TAU - t * 0.25;
      g.moveTo(cx + Math.cos(ang) * (R - 16), cy + Math.sin(ang) * (R - 16))
        .lineTo(cx + Math.cos(ang) * (R - 4), cy + Math.sin(ang) * (R - 4))
        .stroke({ width: 2, color: 0xbfe0ff, alpha: a * 0.8 });
    }
  }

  #updateSplitMarks(dt: number, world: World): void {
    const want = world.strategy === "SPLIT" && world.cinematic.kind === "none" ? world.formBlend : 0;
    this.#splitAlpha += (want - this.#splitAlpha) * smoothing(dt, 0.35);
    const g = this.#groupMarks;
    g.clear();
    if (this.#splitAlpha < 0.01) return;
    const t = this.#time;
    for (let k = 0; k < world.splitCount; k++) {
      const x = world.splitX[k]!;
      const y = world.splitY[k]!;
      const r = 118 + Math.sin(t * 2 + k) * 4;
      for (let s = 0; s < 4; s++) {
        const a = s * (Math.PI / 2) + t * (k % 2 ? 0.6 : -0.6);
        g.arc(x, y, r, a, a + 0.9).stroke({ width: 1.5, color: 0xb388ff, alpha: this.#splitAlpha * 0.6 });
      }
    }
  }
}
