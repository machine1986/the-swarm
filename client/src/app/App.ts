import { ruleBasedDecision } from "../../../shared/rules.ts";
import { STRATEGIES, type DecisionResult, type StatusResponse, type Strategy } from "../../../shared/types.ts";
import {
  fetchStatus,
  listServerRecordings,
  loadServerRecording,
  requestDecision,
  saveRecordingToServer,
} from "../api/apiClient.ts";
import { DecisionScheduler } from "../api/DecisionScheduler.ts";
import { Autopilot } from "../demo/Autopilot.ts";
import { Hud, type ModeKind } from "../hud/Hud.ts";
import { Overlay } from "../hud/Overlay.ts";
import { Renderer } from "../rendering/Renderer.ts";
import { parseRecording, Recorder, Replayer, type Recording } from "../replay/recording.ts";
import { isWorldCommand, type Command, type MetaCommand } from "../simulation/commands.ts";
import { buildSwarmState } from "../simulation/metrics.ts";
import { randomSeed } from "../simulation/rng.ts";
import { STEP, World, type WorldEvent } from "../simulation/World.ts";

const MAX_STEPS_PER_FRAME = 4;
const MANUAL_HOLD_MS = 8000;

/** Wires simulation, renderer, HUD, decision scheduler, autopilot and record/replay together. */
export class App {
  readonly renderer = new Renderer();
  readonly hud = new Hud();
  readonly overlay = new Overlay();
  readonly recorder = new Recorder();
  readonly replayer = new Replayer();
  readonly autopilot = new Autopilot();
  world!: World;
  scheduler!: DecisionScheduler;

  #status: StatusResponse | null = null;
  #backendOffline = false;
  #paused = false;
  #accumulator = 0;
  #aiEnabled = true;
  #endCard = false;
  #manualHoldUntil = 0;
  #eventSinceRequest = false;
  #lastModel: string | null = null;
  #lastRecording: Recording | null = null;
  #recordingDemo = false;
  #queue: { tick: number; cmd: Command }[] = [];
  #fps = 60;
  #hudAccum = 0;
  #resizeTimer = 0;

  async start(stage: HTMLElement): Promise<void> {
    await this.renderer.init(stage);
    const { width, height } = this.renderer.worldSize;
    this.world = new World(randomSeed(), width, height);

    this.scheduler = new DecisionScheduler({
      getState: () => buildSwarmState(this.world),
      currentStrategy: () => this.world.strategy,
      request: (state, signal) => requestDecision(state, signal),
      onRequest: (state) => {
        const label = this.#eventSinceRequest ? (this.#status?.mode === "live" ? "JEV ANALYZING" : "RULE ENGINE EVALUATING") : null;
        this.#eventSinceRequest = false;
        this.dispatch({ type: "jevRequest", state, label });
      },
      onDecision: (decision, pending) => this.dispatch({ type: "decisionShown", decision, pending }),
      apply: (decision) => this.dispatch({ type: "decision", decision }),
      onError: (message) => this.dispatch({ type: "decisionError", message }),
    });

    this.#bindInput();
    void this.#refreshStatus();
    window.setInterval(() => void this.#refreshStatus(), 15_000);
    this.hud.log("SYSTEM ONLINE", "success");
    this.renderer.app.ticker.add((ticker) => this.#frame(ticker.deltaMS / 1000));
  }

  // ───────────────────────────── command bus ─────────────────────────────

  /** Single entry point for every state change; recorded while a recording runs. */
  dispatch(cmd: Command, record = true): void {
    if (record && this.recorder.active) this.recorder.capture(this.world.tick, cmd);
    if (isWorldCommand(cmd)) {
      if (cmd.type === "reset") this.#resetPresentation();
      this.world.apply(cmd);
      if (cmd.type === "spawnThreats" || cmd.type === "clearThreats") this.#notify();
    } else {
      this.#applyMeta(cmd);
    }
  }

  #applyMeta(cmd: MetaCommand): void {
    switch (cmd.type) {
      case "jevRequest":
        this.hud.setAnalyzing(true, this.#status?.mode === "live" || this.replayer.active ? "ANALYZING" : "EVALUATING");
        if (cmd.label) this.hud.log(cmd.label, "ai");
        break;
      case "decisionShown": {
        const replay = this.replayer.active;
        const decision: DecisionResult = replay ? { ...cmd.decision, source: "replay" } : cmd.decision;
        if (cmd.decision.source === "jev") {
          this.#lastModel = cmd.decision.model;
          this.hud.setError(null);
          this.recorder.noteSource({ mode: "live", model: cmd.decision.model });
        }
        this.hud.setAnalyzing(false);
        this.hud.showDecision(decision, { pending: cmd.pending, replay });
        break;
      }
      case "decisionError":
        this.hud.setAnalyzing(false);
        this.hud.setError(`${cmd.message} — local rules active, retrying with backoff`);
        this.hud.log("JEV UNAVAILABLE · FALLBACK", "warn");
        break;
      case "title":
        this.overlay.title(cmd.text, cmd.variant);
        break;
      case "endCard":
        this.#endCard = cmd.visible;
        this.overlay.endCard(cmd.visible);
        break;
      case "camera":
        this.renderer.camera.zoomTo(cmd.zoom, cmd.duration);
        break;
      case "darken":
        this.renderer.darkenTo(cmd.amount, cmd.duration);
        break;
      case "aiEnabled":
        this.#aiEnabled = cmd.enabled;
        this.hud.setAiPaused(cmd.enabled ? null : "AI PAUSED");
        break;
      case "cinematicLabel":
        this.overlay.cinematicLabel(cmd.text);
        break;
    }
  }

  #resetPresentation(): void {
    this.scheduler.invalidate();
    this.renderer.reset();
    this.hud.clearLog();
    this.hud.resetDecision();
    this.hud.setError(null);
    this.hud.setAnalyzing(false);
    this.overlay.clear();
    this.#endCard = false;
    this.#aiEnabled = true;
    this.hud.setAiPaused(null);
    this.#queue = [];
    this.#accumulator = 0;
  }

  /** Dispatch a command after `seconds` of simulation time (pause-aware, replay-safe). */
  #later(seconds: number, cmd: Command): void {
    this.#queue.push({ tick: this.world.tick + Math.round(seconds / STEP), cmd });
  }

  #notify(): void {
    this.#eventSinceRequest = true;
    this.scheduler.notifyEvent();
  }

  // ───────────────────────────── frame loop ─────────────────────────────

  #frame(rawDt: number): void {
    const dt = Math.min(rawDt, 0.1);
    if (rawDt > 0) this.#fps += (1 / Math.max(rawDt, 1e-3) - this.#fps) * 0.05;

    if (!this.#paused) {
      this.#accumulator += dt;
      let steps = 0;
      while (this.#accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
        this.#beforeStep();
        this.world.step();
        this.#accumulator -= STEP;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.#accumulator = 0; // don't spiral after a stall
    }

    const events = this.world.drainEvents();
    this.renderer.handleEvents(events);
    this.#handleWorldEvents(events);

    this.scheduler.enabled =
      !this.#paused &&
      this.#aiEnabled &&
      !this.#endCard &&
      !this.replayer.active &&
      !document.hidden &&
      performance.now() >= this.#manualHoldUntil &&
      this.world.cinematic.kind === "none";
    if (!this.replayer.active) this.scheduler.update();

    this.renderer.render(this.world, this.#paused ? 1 : this.#accumulator / STEP, this.#paused ? 0 : dt);

    this.#hudAccum += rawDt;
    if (this.#hudAccum >= 0.1) {
      this.#hudAccum = 0;
      this.#refreshHud();
    }
  }

  #beforeStep(): void {
    const tick = this.world.tick;
    if (this.replayer.active) {
      for (const cmd of this.replayer.due(tick)) this.dispatch(cmd, false);
      if (this.replayer.finished && tick >= this.replayer.recording!.durationTicks) this.#endReplay();
      return;
    }
    if (this.#queue.length > 0) {
      const due = this.#queue.filter((q) => q.tick <= tick);
      this.#queue = this.#queue.filter((q) => q.tick > tick);
      for (const q of due) this.dispatch(q.cmd);
    }
    if (this.autopilot.active) {
      const { commands, ended } = this.autopilot.update(this.world);
      for (const cmd of commands) this.dispatch(cmd);
      if (ended) this.#onDemoEnd();
    }
  }

  #handleWorldEvents(events: readonly WorldEvent[]): void {
    let spawned = 0;
    for (const e of events) {
      switch (e.type) {
        case "threatSpawned":
          spawned++;
          break;
        case "threatDestroyed":
          this.#notify();
          break;
        case "strategyChanged":
          if (e.cause === "decision") this.hud.log(`STRATEGY: ${e.strategy}`, "ai");
          else if (e.cause === "auto") this.hud.log(`AUTO TRANSITION · ${e.strategy}`, "info");
          break;
        case "log":
          this.hud.log(e.text, e.tone);
          break;
        default:
          break;
      }
    }
    if (spawned > 0) {
      this.hud.log(spawned === 1 ? "THREAT DETECTED" : `${spawned} THREATS DETECTED`, "threat");
      this.#notify();
    }
  }

  #refreshHud(): void {
    const w = this.world;
    this.hud.setStats({ fps: this.#fps, population: w.aliveCount, capacity: w.capacity, threats: w.threats.length, energy: w.energy });
    const [kind, detail] = this.#modeView();
    this.hud.setMode(kind, detail);
    const note =
      w.cinematic.kind !== "none"
        ? "CINEMATIC"
        : w.lastCause === "auto"
          ? "AUTO"
          : w.formBlend < 0.98
            ? "TRANSITIONING"
            : "";
    this.hud.setActiveStrategy(w.strategy, note);
    this.hud.tick();
    this.#syncButtons();
  }

  #modeView(): [ModeKind, string] {
    if (this.replayer.active) {
      const rec = this.replayer.recording!;
      const progress = Math.min(100, Math.round((this.world.tick / Math.max(1, rec.durationTicks)) * 100));
      return ["replay", `${rec.source.mode === "live" ? "RECORDED JEV SESSION" : "RECORDED SIMULATION"} · ${progress}%`];
    }
    if (!this.#status) {
      return this.#backendOffline ? ["simulation", "BACKEND OFFLINE · LOCAL RULES"] : ["connecting", "CONTACTING BACKEND…"];
    }
    if (this.#status.mode === "simulation") return ["simulation", "NO TYPESAFE_API_KEY · LOCAL RULES"];
    if (this.scheduler.fallbackActive) return ["simulation", `FALLBACK · ${this.scheduler.lastError ?? "API PAUSED"}`];
    if (performance.now() < this.#manualHoldUntil) return ["live", "AI ON HOLD · MANUAL OVERRIDE"];
    const model = (this.#lastModel ?? this.#status.model).toUpperCase();
    return ["live", `${model} · ${this.scheduler.requestsLastMinute}/${this.scheduler.config.maxRequestsPerMinute} REQ/MIN`];
  }

  async #refreshStatus(): Promise<void> {
    try {
      this.#status = await fetchStatus();
      this.#backendOffline = false;
    } catch {
      this.#status = null;
      this.#backendOffline = true;
    }
  }

  // ───────────────────────────── actions ─────────────────────────────

  #blockedByReplay(): boolean {
    if (!this.replayer.active) return false;
    this.hud.toast("REPLAY RUNNING · STOP REPLAY FIRST");
    return true;
  }

  addThreatNearSwarm(): void {
    if (this.#blockedByReplay()) return;
    const a = Math.random() * Math.PI * 2;
    const d = 280 + Math.random() * 200;
    this.dispatch({ type: "spawnThreat", x: this.world.centerX + Math.cos(a) * d, y: this.world.centerY + Math.sin(a) * d });
  }

  chaos(): void {
    if (this.#blockedByReplay()) return;
    this.dispatch({ type: "darken", amount: 0.42, duration: 0.5 });
    this.dispatch({ type: "title", text: "CRITICAL EVENT", variant: "warning" });
    this.dispatch({ type: "camera", zoom: 0.9, duration: 1.2 });
    this.dispatch({ type: "spawnThreats", count: 15 + Math.floor(Math.random() * 6), chaos: true });
    this.#later(2.8, { type: "title", text: null });
    this.#later(2.8, { type: "darken", amount: 0.1, duration: 2 });
    this.#later(6, { type: "camera", zoom: 1, duration: 3 });
  }

  reset(): void {
    this.autopilot.stop();
    if (this.replayer.active) this.#stopReplay();
    if (this.recorder.active) void this.#stopRecording();
    this.#recordingDemo = false;
    this.#paused = false;
    const { width, height } = this.renderer.worldSize;
    this.dispatch({ type: "reset", seed: randomSeed(), width, height });
    this.hud.log("SIMULATION RESET", "info");
  }

  togglePause(): void {
    this.#paused = !this.#paused;
    this.hud.toast(this.#paused ? "PAUSED" : "RESUMED", 1200);
  }

  toggleCinematic(): void {
    const on = document.body.classList.toggle("cinematic");
    if (on) this.hud.toast("CINEMATIC MODE · PRESS C OR ESC TO EXIT", 1800);
  }

  toggleDemo(): void {
    if (this.autopilot.active) {
      this.autopilot.stop();
      if (this.#recordingDemo) void this.#stopRecording();
      this.#recordingDemo = false;
      this.hud.toast("DEMO STOPPED");
      return;
    }
    if (this.replayer.active) this.#stopReplay();
    this.#startRecording();
    this.#recordingDemo = true;
    this.autopilot.start(this.world.tick);
    this.hud.toast("AUTOPILOT DEMO · RECORDING", 2000);
  }

  toggleRecording(): void {
    if (this.recorder.active) {
      void this.#stopRecording();
    } else {
      if (this.#blockedByReplay()) return;
      this.#startRecording();
      this.hud.toast("RECORDING · FRESH SWARM", 1800);
    }
  }

  #startRecording(): void {
    this.autopilot.stop();
    this.#paused = false;
    const { width, height } = this.renderer.worldSize;
    const seed = randomSeed();
    this.dispatch({ type: "reset", seed, width, height }, false);
    this.recorder.start(seed, width, height, {
      mode: this.#status?.mode ?? "simulation",
      model: this.#status?.mode === "live" ? this.#status.model : null,
    });
    this.hud.log("RECORDING STARTED", "warn");
  }

  async #stopRecording(): Promise<void> {
    const rec = this.recorder.stop(this.world.tick);
    if (!rec) return;
    this.#lastRecording = rec;
    this.hud.log("RECORDING STOPPED", "warn");
    const name = await saveRecordingToServer(JSON.stringify(rec));
    this.hud.toast(name ? `SAVED · recordings/${name}` : "RECORDING READY · USE EXPORT TO SAVE", 3200);
  }

  #onDemoEnd(): void {
    if (this.#recordingDemo) void this.#stopRecording();
    this.#recordingDemo = false;
    this.hud.toast("DEMO COMPLETE · ESC OR RESET TO CONTINUE", 4000);
  }

  exportRecording(): void {
    if (!this.#lastRecording) {
      this.hud.toast("NO RECORDING YET");
      return;
    }
    const blob = new Blob([JSON.stringify(this.#lastRecording, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `swarm-recording-${this.#lastRecording.createdAt.replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  toggleReplay(): void {
    if (this.replayer.active) {
      this.#stopReplay();
      this.reset();
      return;
    }
    const rec = this.#lastRecording;
    if (!rec) {
      this.hud.toast("NO RECORDING · RECORD OR LOAD ONE FIRST");
      return;
    }
    this.autopilot.stop();
    if (this.recorder.active) void this.#stopRecording();
    this.#paused = false;
    this.replayer.start(rec);
    this.dispatch({ type: "reset", seed: rec.seed, width: rec.width, height: rec.height }, false);
    this.overlay.replayTag(true);
    this.hud.log("REPLAY STARTED", "ai");
  }

  #stopReplay(): void {
    this.replayer.stop();
    this.overlay.replayTag(false);
  }

  #endReplay(): void {
    this.#stopReplay();
    this.#paused = true;
    this.hud.toast("REPLAY COMPLETE · RESET TO CONTINUE", 4000);
  }

  loadRecording(data: unknown): void {
    try {
      this.#lastRecording = parseRecording(data);
      this.hud.toast("RECORDING LOADED · PRESS PLAY REPLAY");
    } catch (err) {
      this.hud.toast(`LOAD FAILED · ${(err as Error).message}`, 4000);
    }
  }

  forceStrategy(strategy: Strategy): void {
    if (this.#blockedByReplay()) return;
    const state = buildSwarmState(this.world);
    const base = ruleBasedDecision(state);
    const decision: DecisionResult = {
      ...base,
      strategy,
      strategyProbabilities: Object.fromEntries(STRATEGIES.map((s) => [s, s === strategy ? 1 : 0])) as Record<Strategy, number>,
      model: "manual-override",
    };
    this.#manualHoldUntil = performance.now() + MANUAL_HOLD_MS;
    // Drop any in-flight or queued AI decision so it can't overwrite the override.
    this.scheduler.invalidate();
    this.dispatch({ type: "decisionShown", decision, pending: false });
    this.dispatch({ type: "decision", decision });
    this.hud.toast(`MANUAL OVERRIDE · ${strategy} · AI HOLD ${MANUAL_HOLD_MS / 1000}s`, 2000);
  }

  // ───────────────────────────── input ─────────────────────────────

  #bindInput(): void {
    const canvas = this.renderer.app.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.#endCard) return;
      if (this.#blockedByReplay()) return;
      const p = this.renderer.screenToWorld(e.clientX, e.clientY);
      this.dispatch({ type: "spawnThreat", x: p.x, y: p.y });
    });

    const actions: Record<string, () => void> = {
      addThreat: () => this.addThreatNearSwarm(),
      spawn5: () => !this.#blockedByReplay() && this.dispatch({ type: "spawnThreats", count: 5, chaos: false }),
      clear: () => !this.#blockedByReplay() && this.dispatch({ type: "clearThreats" }),
      chaos: () => this.chaos(),
      pause: () => this.togglePause(),
      reset: () => this.reset(),
      cinematic: () => this.toggleCinematic(),
      demo: () => this.toggleDemo(),
      record: () => this.toggleRecording(),
      export: () => this.exportRecording(),
      load: () => void this.#openLoadDialog(),
      replay: () => this.toggleReplay(),
    };
    document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        actions[btn.dataset.action!]?.();
        btn.blur();
      });
    });

    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("dialog")) return;
      const key = e.key.toLowerCase();
      if (key === " ") {
        e.preventDefault();
        this.togglePause();
      } else if (key === "r") this.reset();
      else if (key === "c") this.toggleCinematic();
      else if (key === "d") this.toggleDemo();
      else if (key === "t") this.addThreatNearSwarm();
      else if (key === "x") this.chaos();
      else if (key === "escape") {
        if (this.#endCard) this.reset();
        else document.body.classList.remove("cinematic");
      } else if (key >= "1" && key <= "6") this.forceStrategy(STRATEGIES[Number(key) - 1]!);
    });

    const fileInput = document.getElementById("file-input") as HTMLInputElement;
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      (document.getElementById("load-dialog") as HTMLDialogElement).close();
      if (!file) return;
      try {
        this.loadRecording(JSON.parse(await file.text()));
      } catch {
        this.hud.toast("LOAD FAILED · INVALID JSON", 4000);
      }
    });
    document.getElementById("load-file")!.addEventListener("click", () => fileInput.click());

    window.addEventListener("resize", () => {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = window.setTimeout(() => {
        if (this.replayer.active) return; // replays keep their recorded world size
        const { width, height } = this.renderer.worldSize;
        this.dispatch({ type: "bounds", width, height });
      }, 200);
    });
  }

  async #openLoadDialog(): Promise<void> {
    const dialog = document.getElementById("load-dialog") as HTMLDialogElement;
    const list = document.getElementById("load-list")!;
    list.replaceChildren();
    const names = await listServerRecordings();
    if (names.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No recordings in recordings/ yet.";
      list.appendChild(li);
    }
    for (const name of names) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = name;
      btn.addEventListener("click", async () => {
        dialog.close();
        try {
          this.loadRecording(await loadServerRecording(name));
        } catch (err) {
          this.hud.toast(`LOAD FAILED · ${(err as Error).message}`, 4000);
        }
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    dialog.showModal();
  }

  #syncButtons(): void {
    const btn = (action: string) => document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    btn("pause").textContent = this.#paused ? "RESUME" : "PAUSE";
    btn("pause").classList.toggle("on", this.#paused);
    btn("cinematic").classList.toggle("on", document.body.classList.contains("cinematic"));
    btn("demo").textContent = this.autopilot.active ? "STOP DEMO" : "RECORD DEMO";
    btn("demo").classList.toggle("on", this.autopilot.active);
    const rec = btn("record");
    rec.classList.toggle("recording", this.recorder.active);
    rec.querySelector("span:last-child")!.textContent = this.recorder.active ? "STOP REC" : "START REC";
    btn("export").disabled = !this.#lastRecording;
    btn("replay").disabled = !this.#lastRecording && !this.replayer.active;
    btn("replay").textContent = this.replayer.active ? "STOP REPLAY" : "PLAY REPLAY";
  }
}
