import { Container, Graphics, Sprite } from "pixi.js";
import { angleDelta, clamp01, smoothing, TAU } from "../simulation/math.ts";
import type { Threat } from "../simulation/World.ts";
import type { Effects } from "./Effects.ts";
import type { Textures } from "./textures.ts";

const RED = 0xff315a;
const HOT = 0xffc2cd;
const HULL = 0x1b0b16;
const HULL_PANEL = 0x2e1424;
const BUG_COLORS = [0x9dff3a, 0xffd23a, 0x5dffb0, 0xff9f3a];

interface ThreatSprite {
  root: Container;
  /** Rotates to the flight direction; everything ship-related lives in here. */
  ship: Container;
  aura: Sprite;
  shield: Sprite;
  flames: Sprite[];
  lights: Graphics;
  limbs: Graphics;
  health: Graphics;
  heading: number;
  size: number;
  bugColor: number;
  emitTimer: number;
  seed: number;
}

/**
 * Threats are tiny bugs piloting spaceships: a dark hull with red neon trim, glass cockpit dome
 * with the bug inside (legs and antennae twitch), flickering twin engines, blinking nav lights.
 * The ship turns smoothly into its flight direction.
 */
export class ThreatView {
  readonly view = new Container();
  readonly #tex: Textures;
  readonly #sprites = new Map<number, ThreatSprite>();
  #time = 0;

  constructor(tex: Textures) {
    this.#tex = tex;
  }

  clear(): void {
    for (const s of this.#sprites.values()) s.root.destroy({ children: true });
    this.#sprites.clear();
  }

  update(threats: readonly Threat[], dt: number, fx: Effects, attackTargetId: number): void {
    this.#time += dt;
    const t = this.#time;
    const seen = new Set<number>();

    for (const th of threats) {
      seen.add(th.id);
      let s = this.#sprites.get(th.id);
      if (!s) {
        s = this.#create(th);
        this.#sprites.set(th.id, s);
      }
      const spawn = clamp01(th.age / 0.7);
      const pop = th.status === "spawning" ? easeOutBack(spawn) : 1;
      const S = s.size;
      s.root.position.set(th.x, th.y);
      s.root.scale.set(pop);

      // Turn into the flight direction; bank slightly while turning, bob gently.
      const speed = Math.hypot(th.vx, th.vy);
      let turn = 0;
      if (speed > 1) {
        turn = angleDelta(s.heading, Math.atan2(th.vy, th.vx));
        s.heading += turn * smoothing(dt, 0.35);
      }
      s.ship.rotation = s.heading;
      s.ship.scale.set(1 + Math.sin(t * 3.1 + s.seed) * 0.03, 1 - Math.min(0.18, Math.abs(turn) * 0.25));

      const breathe = 0.5 + 0.5 * Math.sin(t * 2.4 + s.seed);
      s.aura.scale.set(((S * 5.2) / 256) * (0.9 + breathe * 0.12));
      s.aura.alpha = 0.22 + breathe * 0.12 + (1 - spawn) * 0.6;
      const phase = (t * 0.5 + s.seed) % 1;
      s.shield.scale.set((S * (1.5 + phase * 1.1) * 2) / 512);
      s.shield.alpha = (1 - phase) * 0.32;

      // Engine flicker, stronger when the ship is moving fast.
      const thrust = 0.75 + Math.min(1, speed / 30) * 0.35;
      s.flames.forEach((f, k) => {
        const flicker = 0.8 + 0.2 * Math.sin(t * 38 + k * 2.1 + s.seed) + 0.1 * Math.sin(t * 61 + k);
        f.scale.set(((S * 2.3) / 256) * thrust * flicker, ((S * 0.55) / 256) * flicker);
        f.alpha = 0.95 * flicker;
      });

      this.#drawLights(s, t);
      this.#drawLimbs(s, t);

      s.health.clear();
      if (th.health < th.maxHealth - 0.5) {
        const frac = Math.max(0, th.health / th.maxHealth);
        s.health
          .arc(0, 0, S * 1.45, -Math.PI / 2, -Math.PI / 2 + frac * TAU)
          .stroke({ width: 2.5, color: HOT, alpha: 0.9 });
      }
      if (th.id === attackTargetId) {
        // Lock-on brackets while the swarm attacks this ship.
        const rr = S * 1.45 + 14 + Math.sin(t * 6) * 3;
        for (let q = 0; q < 4; q++) {
          const a = q * (Math.PI / 2) + t * 1.4;
          s.health.arc(0, 0, rr, a - 0.28, a + 0.28).stroke({ width: 2, color: RED, alpha: 0.95 });
        }
      }

      // Exhaust sparks out of the engines.
      s.emitTimer -= dt;
      if (s.emitTimer <= 0) {
        s.emitTimer = 0.05 + Math.random() * 0.07;
        const cx = Math.cos(s.heading);
        const cy = Math.sin(s.heading);
        const side = Math.random() < 0.5 ? -1 : 1;
        const bx = th.x - cx * S * 1.1 - cy * S * 0.24 * side;
        const by = th.y - cy * S * 1.1 + cx * S * 0.24 * side;
        fx.ember(bx, by, -cx * 90 + th.vx, -cy * 90 + th.vy);
      }
    }

    for (const [id, s] of this.#sprites) {
      if (!seen.has(id)) {
        s.root.destroy({ children: true });
        this.#sprites.delete(id);
      }
    }
  }

  #create(th: Threat): ThreatSprite {
    const S = th.radius * 1.45;
    const root = new Container();
    const ship = new Container();
    const aura = new Sprite({ texture: this.#tex.glow, anchor: 0.5, tint: RED, blendMode: "add" });
    const shield = new Sprite({ texture: this.#tex.ring, anchor: 0.5, tint: RED, blendMode: "add" });

    const flames = [-1, 1].map((side) => {
      const f = new Sprite({ texture: this.#tex.glow, tint: 0xff7a3a, blendMode: "add" });
      // Anchored near its right edge so the flame grows backwards out of the nozzle.
      f.anchor.set(0.72, 0.5);
      f.position.set(-S * 1.08, side * S * 0.24);
      return f;
    });

    const hull = new Graphics();
    // Arrow-shaped pod, nose pointing +x, with swept fins.
    const pts = [
      1.45, 0, 0.75, 0.5, 0.15, 0.72, -0.55, 1.18, -0.85, 1.12, -0.7, 0.55, -1.05, 0.38, -1.05, -0.38, -0.7, -0.55,
      -0.85, -1.12, -0.55, -1.18, 0.15, -0.72, 0.75, -0.5,
    ].map((v) => v * S);
    hull.poly(pts).fill({ color: HULL });
    hull.poly(pts).stroke({ width: 5, color: RED, alpha: 0.22 }); // neon bloom
    hull.poly(pts).stroke({ width: 1.6, color: RED, alpha: 0.95 });
    // Panel lines and engine nozzles.
    hull.moveTo(-0.25 * S, 0.62 * S).lineTo(-0.62 * S, 1.02 * S).stroke({ width: 1, color: RED, alpha: 0.45 });
    hull.moveTo(-0.25 * S, -0.62 * S).lineTo(-0.62 * S, -1.02 * S).stroke({ width: 1, color: RED, alpha: 0.45 });
    for (const side of [-1, 1]) {
      hull.roundRect(-1.12 * S, side * 0.24 * S - 0.11 * S, 0.24 * S, 0.22 * S, 0.05 * S).fill({ color: HULL_PANEL }).stroke({ width: 1, color: HOT, alpha: 0.7 });
    }

    // Glass cockpit dome (the bug sits under it).
    const dome = new Graphics();
    dome.circle(0.12 * S, 0, 0.66 * S).fill({ color: 0x14060f, alpha: 0.95 });
    dome.circle(0.12 * S, 0, 0.66 * S).stroke({ width: 1.4, color: HOT, alpha: 0.8 });
    const domeGlow = new Sprite({ texture: this.#tex.glow, anchor: 0.5, tint: 0xff6b88, blendMode: "add", alpha: 0.35 });
    domeGlow.position.set(0.12 * S, 0);
    domeGlow.scale.set((S * 1.4) / 256);

    const bugColor = BUG_COLORS[Math.floor(Math.random() * BUG_COLORS.length)]!;
    const bug = new Graphics();
    drawBugBody(bug, S, bugColor);
    const limbs = new Graphics();

    const glass = new Graphics();
    glass.arc(0.12 * S, 0, 0.56 * S, -2.5, -1.4).stroke({ width: 1.6, color: 0xffffff, alpha: 0.45 });
    glass.circle(0.33 * S, -0.34 * S, 0.06 * S).fill({ color: 0xffffff, alpha: 0.5 });

    const lights = new Graphics();
    lights.blendMode = "add";

    ship.addChild(...flames, hull, dome, domeGlow, limbs, bug, glass, lights);
    const health = new Graphics();
    root.addChild(aura, shield, ship, health);
    this.view.addChild(root);

    return {
      root,
      ship,
      aura,
      shield,
      flames,
      lights,
      limbs,
      health,
      heading: Math.atan2(th.vy, th.vx) || th.heading,
      size: S,
      bugColor,
      emitTimer: 0,
      seed: Math.random() * 6,
    };
  }

  /** Blinking navigation lights on the fin tips and a pulsing nose light. */
  #drawLights(s: ThreatSprite, t: number): void {
    const S = s.size;
    const g = s.lights;
    g.clear();
    const blink = (t * 1.6 + s.seed) % 1 < 0.18 ? 1 : 0.15;
    const alt = (t * 1.6 + s.seed + 0.5) % 1 < 0.18 ? 1 : 0.15;
    g.circle(-0.7 * S, 1.1 * S, 0.09 * S).fill({ color: RED, alpha: blink });
    g.circle(-0.7 * S, -1.1 * S, 0.09 * S).fill({ color: 0xffffff, alpha: alt });
    g.circle(1.32 * S, 0, 0.07 * S).fill({ color: HOT, alpha: 0.5 + 0.5 * Math.sin(t * 5 + s.seed) });
  }

  /** The bug's six legs and two antennae, twitching. */
  #drawLimbs(s: ThreatSprite, t: number): void {
    const S = s.size;
    const g = s.limbs;
    g.clear();
    const cx = 0.12 * S;
    const w = 0.035 * S + 0.6;
    for (let k = 0; k < 3; k++) {
      const baseX = cx + (0.04 - k * 0.12) * S;
      for (const side of [-1, 1]) {
        const wiggle = Math.sin(t * 14 + k * 2 + side + s.seed) * 0.07 * S;
        const kneeX = baseX + (0.06 - k * 0.08) * S + wiggle;
        const kneeY = side * 0.24 * S;
        const footX = kneeX + (0.08 - k * 0.1) * S;
        const footY = side * 0.38 * S;
        g.moveTo(baseX, side * 0.08 * S).lineTo(kneeX, kneeY).lineTo(footX, footY).stroke({ width: w, color: s.bugColor, alpha: 0.9 });
      }
    }
    for (const side of [-1, 1]) {
      const sway = Math.sin(t * 6 + side * 1.3 + s.seed) * 0.08 * S;
      const hx = cx + 0.3 * S;
      g.moveTo(hx, side * 0.05 * S)
        .quadraticCurveTo(hx + 0.18 * S, side * 0.12 * S + sway, hx + 0.26 * S, side * 0.3 * S + sway)
        .stroke({ width: w, color: s.bugColor, alpha: 0.9 });
      g.circle(hx + 0.26 * S, side * 0.3 * S + sway, 0.035 * S + 0.5).fill({ color: s.bugColor });
    }
  }
}

/** Top-down bug: striped abdomen, thorax, head with big glowing eyes. Facing +x. */
function drawBugBody(g: Graphics, S: number, color: number): void {
  const cx = 0.12 * S;
  g.ellipse(cx - 0.2 * S, 0, 0.27 * S, 0.19 * S).fill({ color });
  for (let k = 0; k < 3; k++) {
    const x = cx - (0.32 - k * 0.1) * S;
    g.moveTo(x, -0.15 * S).lineTo(x, 0.15 * S).stroke({ width: 0.05 * S, color: 0x16310a, alpha: 0.55 });
  }
  g.circle(cx + 0.06 * S, 0, 0.13 * S).fill({ color });
  g.circle(cx + 0.24 * S, 0, 0.11 * S).fill({ color });
  for (const side of [-1, 1]) {
    g.circle(cx + 0.29 * S, side * 0.07 * S, 0.06 * S).fill({ color: 0xff2050 });
    g.circle(cx + 0.31 * S, side * 0.065 * S, 0.022 * S).fill({ color: 0xffffff });
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
