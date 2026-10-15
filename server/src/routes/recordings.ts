import express, { Router } from "express";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const NAME = /^[\w.-]+\.json$/;

/** Stores demo recordings as JSON files in the project's recordings/ folder. */
export function createRecordingsRouter(dir: string): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const files = await readdir(dir).catch(() => [] as string[]);
    res.json({ recordings: files.filter((f) => NAME.test(f)).sort().reverse() });
  });

  router.get("/:name", async (req, res) => {
    const name = req.params.name;
    if (!NAME.test(name)) return void res.status(400).json({ error: "Invalid name" });
    try {
      res.type("application/json").send(await readFile(join(dir, name), "utf8"));
    } catch {
      res.status(404).json({ error: "Not found" });
    }
  });

  router.post("/", express.json({ limit: "5mb" }), async (req, res) => {
    const body = req.body as { format?: unknown; createdAt?: unknown } | undefined;
    if (body?.format !== "the-swarm-recording") return void res.status(400).json({ error: "Not a recording" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const name = `swarm-${stamp}.json`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), JSON.stringify(body));
    res.status(201).json({ name });
  });

  return router;
}
