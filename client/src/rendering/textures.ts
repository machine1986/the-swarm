import { Texture } from "pixi.js";

/** Procedurally generated textures — no image assets to load. */
export interface Textures {
  /** Bright core with a tight halo; tinted per particle. */
  particle: Texture;
  /** Wide, smooth radial falloff for auras, nebulae and light blooms. */
  glow: Texture;
  /** Thin luminous ring for pulses and shockwaves. */
  ring: Texture;
  /** Tiny hot spark. */
  spark: Texture;
  /** Edge darkening. */
  vignette: Texture;
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  return [c, ctx];
}

function radial(size: number, stops: [number, string][]): Texture {
  const [c, ctx] = canvas(size);
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(c);
}

export function createTextures(): Textures {
  const particle = radial(64, [
    [0, "rgba(255,255,255,1)"],
    [0.1, "rgba(255,255,255,0.95)"],
    [0.2, "rgba(255,255,255,0.5)"],
    [0.38, "rgba(255,255,255,0.16)"],
    [0.65, "rgba(255,255,255,0.04)"],
    [1, "rgba(255,255,255,0)"],
  ]);

  const glow = radial(256, [
    [0, "rgba(255,255,255,1)"],
    [0.15, "rgba(255,255,255,0.6)"],
    [0.35, "rgba(255,255,255,0.22)"],
    [0.6, "rgba(255,255,255,0.06)"],
    [1, "rgba(255,255,255,0)"],
  ]);

  const ring = (() => {
    const [c, ctx] = canvas(512);
    const h = 256;
    const g = ctx.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.72, "rgba(255,255,255,0)");
    g.addColorStop(0.9, "rgba(255,255,255,0.35)");
    g.addColorStop(0.955, "rgba(255,255,255,1)");
    g.addColorStop(0.975, "rgba(255,255,255,0.4)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    return Texture.from(c);
  })();

  const spark = radial(16, [
    [0, "rgba(255,255,255,1)"],
    [0.3, "rgba(255,255,255,0.7)"],
    [1, "rgba(255,255,255,0)"],
  ]);

  const vignette = radial(512, [
    [0, "rgba(0,0,0,0)"],
    [0.55, "rgba(0,0,0,0)"],
    [0.8, "rgba(1,3,10,0.45)"],
    [1, "rgba(1,3,10,0.92)"],
  ]);

  return { particle, glow, ring, spark, vignette };
}
