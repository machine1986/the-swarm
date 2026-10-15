import { Application, BlurFilter, Container, Graphics, RenderTexture, Sprite } from "pixi.js";
import { smoothing } from "../simulation/math.ts";
import type { World, WorldEvent } from "../simulation/World.ts";
import { Background } from "./Background.ts";
import { Camera } from "./Camera.ts";
import { Effects } from "./Effects.ts";
import { SwarmView } from "./SwarmView.ts";
import { createTextures } from "./textures.ts";
import { ThreatView } from "./ThreatView.ts";

/** Reference height: the world is laid out so its shorter side spans 1080 units. */
export const REFERENCE = 1080;

/**
 * Scene composition:
 *   background → trail buffer (swarm, faded each frame) + blurred copy for bloom
 *   → threats & effects → vignette / darken / flash overlays. HUD is HTML above the canvas.
 */
export class Renderer {
  readonly app = new Application();
  readonly camera = new Camera();
  #background!: Background;
  #swarm!: SwarmView;
  #threats!: ThreatView;
  #fx!: Effects;

  // Trail feedback buffer.
  #trailRT!: RenderTexture;
  readonly #trailScene = new Container();
  readonly #trailFade = new Graphics();
  readonly #trailWorld = new Container();
  #trailSprite!: Sprite;
  #bloomSprite!: Sprite;

  readonly #world = new Container();
  #vignette!: Sprite;
  readonly #darken = new Graphics();
  readonly #flash = new Graphics();
  #flashAlpha = 0;
  #flashColor = 0xffffff;
  #darkAlpha = 0;
  #darkTween: { from: number; to: number; t: number; duration: number } | null = null;

  width = 1;
  height = 1;
  /** Pixels per world unit at zoom 1; fits the simulated world into the viewport. */
  baseScale = 1;
  #needsClear = true;

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: window,
      background: 0x030712,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: "high-performance",
      preference: "webgl",
    });
    parent.appendChild(this.app.canvas);

    const tex = createTextures();
    this.#background = new Background(tex);
    this.#swarm = new SwarmView(tex);
    this.#threats = new ThreatView(tex);
    this.#fx = new Effects(tex);

    // Threat dots share the swarm's trail/bloom buffer so both read as the same kind of light.
    this.#trailWorld.addChild(this.#threats.view, this.#swarm.view);
    this.#trailScene.addChild(this.#trailFade, this.#trailWorld);

    this.#trailRT = RenderTexture.create({ width: 16, height: 16, resolution: this.app.renderer.resolution });
    this.#trailSprite = new Sprite({ texture: this.#trailRT, blendMode: "add" });
    this.#bloomSprite = new Sprite({ texture: this.#trailRT, blendMode: "add", alpha: 0.85 });
    this.#bloomSprite.filters = [new BlurFilter({ strength: 10, quality: 3, resolution: 0.5 })];

    this.#world.addChild(this.#fx.view);
    this.#vignette = new Sprite({ texture: tex.vignette });

    // Darkening sits under the swarm: it dims the stage, the light stays bright.
    this.app.stage.addChild(
      this.#background.view,
      this.#darken,
      this.#bloomSprite,
      this.#trailSprite,
      this.#world,
      this.#vignette,
      this.#flash,
    );
    this.#flash.blendMode = "add";

    this.resize();
    this.app.renderer.on("resize", () => this.resize());
  }

  resize(): void {
    this.width = this.app.screen.width;
    this.height = this.app.screen.height;
    // Recreate the trail buffer: resizing it in place left a stretched picture after
    // orientation changes (e.g. landscape → portrait).
    const previous = this.#trailRT;
    this.#trailRT = RenderTexture.create({ width: this.width, height: this.height, resolution: this.app.renderer.resolution });
    this.#trailSprite.texture = this.#trailRT;
    this.#bloomSprite.texture = this.#trailRT;
    previous.destroy(true);
    this.#needsClear = true;
    this.#background.resize(this.width, this.height);
    this.#vignette.width = this.width;
    this.#vignette.height = this.height;
    this.#trailFade.clear().rect(0, 0, this.width, this.height).fill({ color: 0x000000 });
  }

  /** World size that fills the current viewport at zoom 1 (shorter side = REFERENCE units). */
  get worldSize(): { width: number; height: number } {
    const s = Math.min(this.width, this.height) / REFERENCE;
    return { width: Math.round(this.width / s), height: Math.round(this.height / s) };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const s = this.baseScale * this.camera.effectiveZoom;
    return {
      x: (sx - this.width / 2) / s + this.camera.x + this.camera.driftX,
      y: (sy - this.height / 2) / s + this.camera.y + this.camera.driftY,
    };
  }

  handleEvents(events: readonly WorldEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case "pulse":
          this.#fx.pulse(e.x, e.y, e.color, e.strength);
          break;
        case "explosion":
          this.#fx.explosion(e.x, e.y, e.radius, e.color, e.big);
          break;
        case "threatSpawned":
          this.#fx.spawnFx(e.x, e.y, e.radius);
          break;
        case "absorb":
          this.#fx.absorb(e.x, e.y);
          break;
        case "flash":
          this.flash(e.strength, e.color);
          break;
        case "shake":
          this.camera.punch(e.strength);
          break;
        default:
          break;
      }
    }
  }

  flash(strength: number, color: number): void {
    this.#flashAlpha = Math.max(this.#flashAlpha, strength);
    this.#flashColor = color;
  }

  darkenTo(amount: number, duration: number): void {
    this.#darkTween = { from: this.#darkAlpha, to: amount, t: 0, duration: Math.max(duration, 0.001) };
  }

  reset(): void {
    this.#threats.clear();
    this.#fx.clear();
    this.camera.reset();
    this.#needsClear = true;
    this.#flashAlpha = 0;
    this.darkenTo(0, 0);
  }

  render(world: World, alpha: number, dt: number): void {
    // Fit the world (which may come from a recording made at another size) into the viewport.
    this.baseScale = Math.min(this.width / world.width, this.height / world.height);
    const cam = this.camera;
    cam.update(dt, world.centerX, world.centerY);
    const scale = this.baseScale * cam.effectiveZoom;
    const camX = cam.x + cam.driftX;
    const camY = cam.y + cam.driftY;

    for (const c of [this.#world, this.#trailWorld]) {
      c.position.set(this.width / 2, this.height / 2);
      c.scale.set(scale);
      c.pivot.set(camX, camY);
    }

    this.#background.update(dt, camX, camY, scale, world.urgency);
    this.#swarm.update(world, alpha, dt);
    this.#threats.update(world.threats, dt, world.strategy === "ATTACK" ? world.attackTargetId : -1);
    this.#fx.update(dt, world);

    // Shorter trails when calm, longer streaks for fast moves and the singularity burst.
    const burst = world.cinematic.kind === "singularity" && world.cinematic.exploded;
    const persistence = burst ? 0.93 : 0.72 + world.urgency * 0.06;
    this.#trailFade.alpha = 1 - Math.pow(persistence, dt * 60);
    this.app.renderer.render({ container: this.#trailScene, target: this.#trailRT, clear: this.#needsClear });
    this.#needsClear = false;
    this.#bloomSprite.alpha = 0.42 + world.glow * 0.7;

    if (this.#darkTween) {
      const tw = this.#darkTween;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.duration);
      this.#darkAlpha = tw.from + (tw.to - tw.from) * (k * k * (3 - 2 * k));
      if (k >= 1) this.#darkTween = null;
    }
    this.#darken.clear().rect(0, 0, this.width, this.height).fill({ color: 0x010309, alpha: this.#darkAlpha });

    this.#flashAlpha *= 1 - smoothing(dt, 0.18);
    this.#flash.clear();
    if (this.#flashAlpha > 0.005) {
      this.#flash.rect(0, 0, this.width, this.height).fill({ color: this.#flashColor, alpha: this.#flashAlpha * 0.35 });
    }
  }
}
