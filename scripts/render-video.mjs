#!/usr/bin/env node
// Renders a recording frame-exactly into a video.
//
//   npm run render:video -- [recording.json] [--fps 60] [--prores] [--url http://127.0.0.1:5173]
//
// Requires a running app (`npm run dev`, or `npm start` with --url http://127.0.0.1:8787),
// Google Chrome and ffmpeg. Without a recording argument the newest file in recordings/ is used.
// The video size follows the recording: 1920×1080 for landscape, 1080×1920 for portrait sessions.
//
// A virtual clock is installed in the page (timers, requestAnimationFrame, performance.now and
// CSS animations), so every video frame advances exactly 1/fps seconds no matter how long the
// screenshot takes. Frames are piped straight into ffmpeg.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fps: { type: "string", default: "60" },
    prores: { type: "boolean", default: false },
    url: { type: "string", default: "http://127.0.0.1:5173/" },
    out: { type: "string", default: join(root, "exports") },
    "keep-replay-tag": { type: "boolean", default: false },
  },
});

function newestRecording() {
  const dir = join(root, "recordings");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error("No recordings found in recordings/. Record one first (RECORD DEMO).");
  return files[0];
}

const recPath = resolve(positionals[0] ?? newestRecording());
const recording = JSON.parse(readFileSync(recPath, "utf8"));
if (recording.format !== "the-swarm-recording") throw new Error(`${recPath} is not a THE SWARM recording`);

const fps = Number(opts.fps);
// The world is laid out with its shorter side = 1080 units, so world size = viewport size.
const width = Math.round(recording.width);
const height = Math.round(recording.height);
const durationSec = recording.durationTicks / 60 + 0.5;
const frames = Math.ceil(durationSec * fps);
const fadeStart = (durationSec - 0.6).toFixed(2);

mkdirSync(opts.out, { recursive: true });
const name = `${basename(recPath, ".json")}-${width}x${height}-${fps}fps`;
const mp4 = join(opts.out, `${name}.mp4`);
const mov = join(opts.out, `${name}-prores.mov`);
const color = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
const base = `fade=t=out:st=${fadeStart}:d=0.6,scale=in_range=full:out_range=tv:out_color_matrix=bt709`;

const ffArgs = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "-"];
if (opts.prores) {
  ffArgs.push("-filter_complex", `[0:v]${base},split=2[a][b];[a]format=yuv420p[h264];[b]format=yuv422p10le[pr]`);
  ffArgs.push("-map", "[h264]");
} else {
  ffArgs.push("-vf", `${base},format=yuv420p`);
}
ffArgs.push("-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high", "-tune", "film", ...color, "-movflags", "+faststart", mp4);
if (opts.prores) ffArgs.push("-map", "[pr]", "-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", ...color, mov);

console.log(`Rendering ${basename(recPath)} → ${width}×${height} @ ${fps} fps, ${frames} frames`);
const ffmpeg = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "inherit", "inherit"] });
const ffmpegDone = new Promise((res, rej) => {
  ffmpeg.on("error", rej);
  ffmpeg.on("exit", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}`))));
});

const browser = await chromium.launch({
  channel: process.env.RENDER_BROWSER_CHANNEL ?? "chrome",
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.addInitScript(installVirtualClock);
  await page.goto(opts.url);
  await page.waitForFunction(() => window.swarm?.world, null, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  for (let i = 0; i < 10; i++) await page.evaluate(() => window.__advance(1000 / 60));

  await page.evaluate(
    ({ rec, hideTag }) => {
      const style = document.createElement("style");
      style.textContent = `#toast{visibility:hidden!important}${hideTag ? "#replay-tag{display:none!important}" : ""}`;
      document.head.appendChild(style);
      document.body.classList.add("cinematic");
      window.swarm.loadRecording(rec);
      window.swarm.toggleReplay();
    },
    { rec: recording, hideTag: !opts["keep-replay-tag"] },
  );

  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    await page.evaluate((ms) => window.__advance(ms), 1000 / fps);
    const jpeg = await page.screenshot({ type: "jpeg", quality: 95 });
    if (!ffmpeg.stdin.write(jpeg)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (f % (fps * 5) === 0) {
      const pct = Math.round((f / frames) * 100);
      console.log(`  ${pct}% · frame ${f}/${frames} · ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }
} finally {
  ffmpeg.stdin.end();
  await browser.close();
}
await ffmpegDone;
console.log(`Done: ${mp4}${opts.prores ? `\n      ${mov}` : ""}`);

/** Runs inside the page before any app code: replaces wall-clock time with a manual clock. */
function installVirtualClock() {
  let now = 0;
  const start = Date.now();
  let timerSeq = 0;
  const timers = new Map();
  let frameCallbacks = new Map();
  let frameSeq = 0;
  performance.now = () => now;
  Date.now = () => start + now;
  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++timerSeq;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
    return id;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    const id = ++timerSeq;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { at: now + every, fn, args, every });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestAnimationFrame = (cb) => {
    const id = ++frameSeq;
    frameCallbacks.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => frameCallbacks.delete(id);
  window.__advance = (ms) => {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const entry of timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every;
      else timers.delete(id);
      try {
        if (typeof t.fn === "function") t.fn(...t.args);
      } catch (e) {
        console.error(e);
      }
    }
    now = target;
    const due = frameCallbacks;
    frameCallbacks = new Map();
    for (const cb of due.values()) {
      try {
        cb(now);
      } catch (e) {
        console.error(e);
      }
    }
    // CSS animations and transitions follow the virtual clock too.
    for (const a of document.getAnimations()) {
      if (a.playState !== "paused") a.pause();
      a.currentTime = (Number(a.currentTime) || 0) + ms;
    }
  };
}
