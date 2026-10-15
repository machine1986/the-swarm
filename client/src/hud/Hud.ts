import { STRATEGIES, type DecisionResult, type Strategy } from "../../../shared/types.ts";
import { STRATEGY_COLORS } from "../simulation/strategies.ts";

export type LogTone = "info" | "threat" | "ai" | "warn" | "success";
export type ModeKind = "live" | "simulation" | "replay" | "connecting";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

/** DOM HUD. Numbers are throttled by the caller; nothing here runs per particle. */
export class Hud {
  readonly #mode = document.querySelector<HTMLElement>(".mode")!;
  readonly #modeLabel = $("mode-label");
  readonly #modeDetail = $("mode-detail");
  readonly #fps = $("stat-fps");
  readonly #pop = $("stat-pop");
  readonly #threats = $("stat-threats");
  readonly #energy = $("stat-energy");
  readonly #energyBar = $("energy-bar");
  readonly #source = $("engine-source");
  readonly #strategy = $("engine-strategy");
  readonly #chip = $("engine-chip");
  readonly #active = $("engine-active");
  readonly #bars = $("bars");
  readonly #confidence = $("m-confidence");
  readonly #urgency = $("m-urgency");
  readonly #urgencySteps = [...$("urgency-steps").children] as HTMLElement[];
  readonly #conserve = $("m-conserve");
  readonly #last = $("m-last");
  readonly #latency = $("m-latency");
  readonly #error = $("engine-error");
  readonly #log = $("log");
  readonly #toast = $("toast");
  readonly #barEls = new Map<Strategy, { row: HTMLElement; fill: HTMLElement; value: HTMLElement }>();
  #shownAt = -1;
  #toastTimer = 0;
  #pending = false;
  #analyzing = false;
  #aiPaused: string | null = null;
  readonly #engine = document.querySelector<HTMLElement>(".engine")!;
  #lastStrategy: Strategy | null = null;

  constructor() {
    for (const s of STRATEGIES) {
      const row = document.createElement("div");
      row.className = "bar";
      row.innerHTML = `<span>${s}</span><span class="bar-track"><span class="bar-fill"></span></span><span class="bar-value">—</span>`;
      this.#bars.appendChild(row);
      this.#barEls.set(s, {
        row,
        fill: row.querySelector(".bar-fill")!,
        value: row.querySelector(".bar-value")!,
      });
    }
  }

  setMode(kind: ModeKind, detail: string): void {
    this.#mode.dataset.mode = kind;
    this.#modeLabel.textContent =
      kind === "live" ? "LIVE AI" : kind === "replay" ? "REPLAY" : kind === "connecting" ? "CONNECTING" : "SIMULATION";
    this.#modeDetail.textContent = detail;
  }

  setStats(s: { fps: number; population: number; capacity: number; threats: number; energy: number }): void {
    this.#fps.textContent = String(Math.round(s.fps));
    this.#pop.textContent = `${s.population.toLocaleString("en-US")} / ${s.capacity.toLocaleString("en-US")}`;
    this.#threats.textContent = String(s.threats);
    this.#threats.style.color = s.threats > 0 ? "var(--threat)" : "";
    this.#energy.textContent = `${Math.round(s.energy)}%`;
    this.#energyBar.style.width = `${Math.max(0, Math.min(100, s.energy))}%`;
    this.#energyBar.classList.toggle("low", s.energy < 30);
  }

  setActiveStrategy(strategy: Strategy, note: string): void {
    this.#active.textContent = `ACTIVE BEHAVIOR · ${strategy}${note ? ` · ${note}` : ""}`;
  }

  setAnalyzing(on: boolean, label = "ANALYZING"): void {
    this.#analyzing = on;
    this.#chipText(label);
  }

  /** `replay`: decision comes from a recording; `pending`: waiting for strategy cooldown. */
  showDecision(d: DecisionResult, opts: { pending: boolean; replay: boolean }): void {
    this.#pending = opts.pending;
    this.#shownAt = performance.now();
    const fromJev = d.source === "jev" || (d.source === "replay" && d.model !== "local-rules" && d.model !== "manual-override");
    const manual = d.model === "manual-override";

    if (opts.replay) {
      this.#source.textContent = fromJev ? `REPLAY · RECORDED ${d.model.toUpperCase()}` : "REPLAY · RECORDED LOCAL RULES · NOT JEV";
    } else if (fromJev) {
      this.#source.textContent = `JEV · ${d.model.toUpperCase()}${d.requestId ? ` · ${d.requestId.slice(-8)}` : ""}`;
    } else {
      this.#source.textContent = manual ? "MANUAL OVERRIDE · NOT JEV" : "LOCAL RULE ENGINE · NOT JEV";
    }
    this.#source.className = `engine-source ${fromJev ? "jev" : "sim"}`;

    const color = hex(STRATEGY_COLORS[d.strategy]);
    this.#strategy.style.setProperty("--strategy-color", color);
    this.#strategy.textContent = d.strategy;
    if (d.strategy !== this.#lastStrategy) {
      this.#strategy.classList.remove("flash");
      void this.#strategy.offsetWidth; // restart animation
      this.#strategy.classList.add("flash");
      this.#lastStrategy = d.strategy;
    }

    this.#bars.classList.toggle("sim", !fromJev);
    let top: Strategy = d.strategy;
    for (const s of STRATEGIES) if (d.strategyProbabilities[s] > d.strategyProbabilities[top]) top = s;
    for (const s of STRATEGIES) {
      const el = this.#barEls.get(s)!;
      const p = d.strategyProbabilities[s];
      el.fill.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
      el.value.textContent = fromJev ? pct(p) : s === d.strategy ? "RULE" : "—";
      el.row.classList.toggle("top", s === top);
    }

    this.#confidence.textContent = d.strategyConfidence === null ? "N/A · RULES" : pct(d.strategyConfidence);
    const level = Math.round(d.urgency);
    this.#urgency.textContent = fromJev ? `${d.urgency.toFixed(2)} / 3` : `LEVEL ${level}`;
    // One square per rubric level (0–3), lit up to the reported level.
    this.#urgencySteps.forEach((step, i) => {
      step.classList.toggle("on", i <= level);
      step.classList.toggle("hot", level >= 3);
    });
    this.#conserve.textContent = fromJev
      ? pct(d.conserveEnergyProbability)
      : d.conserveEnergyProbability >= 1
        ? "RULE · YES"
        : d.conserveEnergyProbability > 0
          ? "RULE · LEAN"
          : "RULE · NO";
    this.#latency.textContent = fromJev ? `${Math.round(d.latencyMs)} ms` : "LOCAL";
    this.#chipText();
  }

  /** Cinematic sequences: make clear that no AI decision is driving the swarm right now. */
  setAiPaused(reason: string | null): void {
    this.#aiPaused = reason;
    this.#engine.classList.toggle("paused", reason !== null);
    this.#chipText();
  }

  setError(message: string | null): void {
    this.#error.hidden = !message;
    this.#error.textContent = message ? `⚠ ${message}` : "";
  }

  /** Call ~10×/s to refresh relative times. */
  tick(): void {
    if (this.#shownAt < 0) return;
    const s = (performance.now() - this.#shownAt) / 1000;
    this.#last.textContent = s < 60 ? `${s.toFixed(1)}s AGO` : `${Math.floor(s / 60)}m AGO`;
  }

  resetDecision(): void {
    this.#shownAt = -1;
    this.#lastStrategy = null;
    this.#strategy.textContent = "—";
    this.#source.textContent = "AWAITING FIRST DECISION";
    this.#source.className = "engine-source";
    for (const el of this.#barEls.values()) {
      el.fill.style.width = "0";
      el.value.textContent = "—";
      el.row.classList.remove("top");
    }
    for (const id of [this.#confidence, this.#urgency, this.#conserve, this.#last, this.#latency]) id.textContent = "—";
    this.#urgencySteps.forEach((s) => s.classList.remove("on", "hot"));
    this.#pending = false;
    this.#chipText();
  }

  log(text: string, tone: LogTone = "info"): void {
    const li = document.createElement("li");
    li.className = tone;
    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const span = document.createElement("span");
    span.textContent = text;
    li.append(time, span);
    this.#log.prepend(li);
    while (this.#log.children.length > 5) this.#log.lastElementChild!.remove();
  }

  clearLog(): void {
    this.#log.replaceChildren();
  }

  toast(message: string, ms = 2600): void {
    this.#toast.textContent = message;
    this.#toast.hidden = false;
    clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => (this.#toast.hidden = true), ms);
  }

  #chipText(label = "ANALYZING"): void {
    if (this.#aiPaused) {
      this.#chip.textContent = this.#aiPaused;
      this.#chip.className = "engine-chip hold";
    } else if (this.#analyzing) {
      this.#chip.textContent = label;
      this.#chip.className = "engine-chip analyzing";
    } else if (this.#pending) {
      this.#chip.textContent = "COOLDOWN";
      this.#chip.className = "engine-chip hold";
    } else if (this.#shownAt >= 0) {
      this.#chip.textContent = "APPLIED";
      this.#chip.className = "engine-chip";
    } else {
      this.#chip.textContent = "";
      this.#chip.className = "engine-chip";
    }
  }
}
