import { Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite } from "pixi.js";
import type { Textures } from "./textures.ts";

const DUST = 240;

/** Nebula haze, a two-depth grid and drifting dust — all parallaxed for depth, all kept quiet. */
export class Background {
  readonly view = new Container();
  readonly #nebula: Sprite[] = [];
  readonly #farGrid = new Graphics();
  readonly #nearGrid = new Graphics();
  readonly #dust: ParticleContainer;
  readonly #dustDepth = new Float32Array(DUST);
  readonly #dustX = new Float32Array(DUST);
  readonly #dustY = new Float32Array(DUST);
  #time = 0;
  #w = 1;
  #h = 1;

  constructor(tex: Textures) {
    const tints = [0x2a1b6b, 0x00e5ff, 0x3b1f7a];
    const alphas = [0.16, 0.05, 0.1];
    for (let i = 0; i < 3; i++) {
      const s = new Sprite({ texture: tex.glow, anchor: 0.5, tint: tints[i], alpha: alphas[i], blendMode: "add" });
      this.#nebula.push(s);
      this.view.addChild(s);
    }

    drawGrid(this.#farGrid, 120, 0x163050, 0.16, 0.26);
    drawGrid(this.#nearGrid, 80, 0x1c3d63, 0.14, 0.28);
    this.#farGrid.alpha = 0.55;
    this.view.addChild(this.#farGrid, this.#nearGrid);

    this.#dust = new ParticleContainer({
      dynamicProperties: { position: true, color: false, vertex: false, rotation: false },
      texture: tex.spark,
    });
    this.#dust.boundsArea = new Rectangle(-1e5, -1e5, 2e5, 2e5);
    this.#dust.blendMode = "add";
    for (let i = 0; i < DUST; i++) {
      const depth = Math.random();
      this.#dustDepth[i] = depth;
      this.#dustX[i] = Math.random();
      this.#dustY[i] = Math.random();
      const size = 0.12 + depth * 0.32;
      this.#dust.addParticle(
        new Particle({
          texture: tex.spark,
          anchorX: 0.5,
          anchorY: 0.5,
          scaleX: size,
          scaleY: size,
          tint: depth > 0.7 ? 0xb388ff : 0x7fe9ff,
          alpha: 0.12 + depth * 0.35,
        }),
      );
    }
    this.view.addChild(this.#dust);
  }

  resize(w: number, h: number): void {
    this.#w = w;
    this.#h = h;
    const big = Math.max(w, h) / 256;
    this.#nebula[0]!.scale.set(big * 1.5);
    this.#nebula[1]!.scale.set(big * 0.9);
    this.#nebula[2]!.scale.set(big * 1.2);
  }

  update(dt: number, camX: number, camY: number, scale: number, intensity: number): void {
    this.#time += dt;
    const t = this.#time;
    const w = this.#w;
    const h = this.#h;

    this.#nebula[0]!.position.set(w * (0.3 + 0.05 * Math.sin(t * 0.03)) - camX * 0.05, h * (0.35 + 0.04 * Math.cos(t * 0.02)));
    this.#nebula[1]!.position.set(w * 0.55 - camX * 0.08, h * 0.55 - camY * 0.08);
    this.#nebula[2]!.position.set(w * (0.78 + 0.04 * Math.cos(t * 0.025)), h * (0.7 + 0.05 * Math.sin(t * 0.02)) - camY * 0.05);
    this.#nebula[1]!.alpha = 0.04 + intensity * 0.06;

    // Grids scroll slowly and parallax against the camera at two depths.
    placeGrid(this.#farGrid, w, h, 120, -camX * 0.25 * scale + t * 4, -camY * 0.25 * scale + t * 2.5);
    placeGrid(this.#nearGrid, w, h, 80, -camX * 0.5 * scale + t * 7, -camY * 0.5 * scale + t * 4);
    this.#nearGrid.alpha = 0.55 + 0.15 * Math.sin(t * 0.4) + intensity * 0.2;

    const particles = this.#dust.particleChildren;
    for (let i = 0; i < DUST; i++) {
      const d = this.#dustDepth[i]!;
      this.#dustX[i] = (this.#dustX[i]! + dt * (0.002 + d * 0.004)) % 1;
      this.#dustY[i] = (this.#dustY[i]! + dt * 0.0015 * (1 + d)) % 1;
      const p = particles[i]!;
      p.x = wrap(this.#dustX[i]! * w - camX * (0.2 + d * 0.6) * scale, w);
      p.y = wrap(this.#dustY[i]! * h - camY * (0.2 + d * 0.6) * scale, h);
    }
  }
}

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

/** Grid drawn once over a 1-cell-larger area; repositioned with a modulo offset to scroll forever. */
function drawGrid(g: Graphics, cell: number, color: number, minor: number, major: number): void {
  const extent = 4200;
  for (let x = -extent; x <= extent; x += cell) {
    const isMajor = Math.round(x / cell) % 4 === 0;
    g.moveTo(x, -extent).lineTo(x, extent).stroke({ width: 1, color, alpha: isMajor ? major : minor });
  }
  for (let y = -extent; y <= extent; y += cell) {
    const isMajor = Math.round(y / cell) % 4 === 0;
    g.moveTo(-extent, y).lineTo(extent, y).stroke({ width: 1, color, alpha: isMajor ? major : minor });
  }
}

function placeGrid(g: Graphics, w: number, h: number, cell: number, ox: number, oy: number): void {
  const period = cell * 4;
  g.position.set(w / 2 + (((ox % period) + period) % period), h / 2 + (((oy % period) + period) % period));
}
