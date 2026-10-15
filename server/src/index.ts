import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "./routes/api.ts";
import { createRecordingsRouter } from "./routes/recordings.ts";
import { JEV_MODEL, JevService } from "./services/JevService.ts";
import { RequestBudget } from "./services/RequestBudget.ts";

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const port = envInt("PORT", 8787);
const host = process.env.HOST ?? "127.0.0.1";

const jev = new JevService({
  apiKey: process.env.TYPESAFE_API_KEY,
  timeoutMs: envInt("JEV_TIMEOUT_MS", 6000),
});
const budget = new RequestBudget(envInt("JEV_MAX_REQUESTS_PER_MINUTE", 45), envInt("JEV_MAX_REQUESTS_TOTAL", 1500));

const recordingsDir = fileURLToPath(new URL("../../recordings", import.meta.url));

const app = express();
app.disable("x-powered-by");
// Mounted first: recordings get their own (larger) body limit.
app.use("/api/recordings", createRecordingsRouter(recordingsDir));
app.use("/api", express.json({ limit: "4kb" }), createApiRouter(jev, budget));

// Production: serve the built client from the same origin.
const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));
if (process.env.NODE_ENV === "production" && existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  if (status >= 500) console.error("[server]", err);
  res.status(status).json({
    error: status === 413 ? "Request too large" : status === 400 ? "Malformed JSON" : "Internal error",
    code: status < 500 ? "invalid_state" : "internal",
  });
};
app.use(onError);

const server = app.listen(port, host, () => {
  const mode = jev.configured ? `LIVE AI (${JEV_MODEL})` : "SIMULATION (no TYPESAFE_API_KEY)";
  console.log(`[the-swarm] server on http://${host}:${port} · mode: ${mode}`);
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
