import { clamp, easeInOutCubic, lerp, smoothing } from "../simulation/math.ts";

/** Gentle cinematic camera: tweened zoom, slow drift, loose follow and a short "punch" on big events. */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  #kick = 0;
  #time = 0;
  #tween: { from: number; to: number; t: number; duration: number } | null = null;

  zoomTo(target: number, duration: number): void {
    if (duration <= 0) {
      this.zoom = target;
      this.#tween = null;
      return;
    }
    this.#tween = { from: this.zoom, to: target, t: 0, duration };
  }

  punch(strength: number): void {
    this.#kick = Math.min(1.4, Math.max(this.#kick, strength));
  }

  reset(): void {
    this.x = this.y = 0;
    this.zoom = 1;
    this.#kick = 0;
    this.#tween = null;
  }

  update(dt: number, focusX: number, focusY: number): void {
    this.#time += dt;
    if (this.#tween) {
      const tw = this.#tween;
      tw.t += dt;
      const k = easeInOutCubic(clamp(tw.t / tw.duration, 0, 1));
      this.zoom = lerp(tw.from, tw.to, k);
      if (tw.t >= tw.duration) this.#tween = null;
    }
    // Follow only a fraction of the swarm movement so the stage stays calm.
    this.x += (focusX * 0.16 - this.x) * smoothing(dt, 2.5);
    this.y += (focusY * 0.16 - this.y) * smoothing(dt, 2.5);
    this.#kick *= Math.exp(-dt * 5);
  }

  /** Effective zoom including the punch. */
  get effectiveZoom(): number {
    return this.zoom * (1 + this.#kick * 0.035);
  }

  get driftX(): number {
    return Math.sin(this.#time * 0.071) * 14 + Math.sin(this.#time * 0.023) * 8;
  }

  get driftY(): number {
    return Math.cos(this.#time * 0.053) * 10;
  }
}
