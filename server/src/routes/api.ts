import { APIError, APITimeoutError, APIUserAbortError, AuthenticationError } from "@typesafe-ai/sdk";
import { Router, type Response } from "express";
import { ruleBasedDecision } from "../../../shared/rules.ts";
import type { ApiErrorBody, StatusResponse } from "../../../shared/types.ts";
import { JEV_MODEL, JevResponseError, type JevService } from "../services/JevService.ts";
import type { RequestBudget } from "../services/RequestBudget.ts";
import { parseSwarmState, ValidationError } from "../validation.ts";

function fail(res: Response, status: number, body: ApiErrorBody): void {
  res.status(status).json(body);
}

export function createApiRouter(jev: JevService, budget: RequestBudget): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    const body: StatusResponse = {
      ok: true,
      jevConfigured: jev.configured,
      mode: jev.configured ? "live" : "simulation",
      model: jev.configured ? JEV_MODEL : "local-rules",
      budget: budget.status(),
    };
    res.json(body);
  });

  router.post("/decide", async (req, res) => {
    let state;
    try {
      state = parseSwarmState(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return fail(res, 400, { error: err.message, code: "invalid_state" });
      throw err;
    }

    if (!jev.configured) {
      res.json(ruleBasedDecision(state));
      return;
    }
    if (!budget.tryConsume()) {
      const { usedLastMinute, limitPerMinute, usedTotal, limitTotal } = budget.status();
      return fail(res, 429, {
        error: `Jev request budget exhausted (${usedLastMinute}/${limitPerMinute} per minute, ${usedTotal}/${limitTotal} total)`,
        code: "budget_exhausted",
      });
    }

    // Abort the upstream call when the browser gives up on this request.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      res.json(await jev.decide(state, controller.signal));
    } catch (err) {
      if (err instanceof APIUserAbortError) return;
      if (err instanceof APITimeoutError) return fail(res, 504, { error: "Jev timed out", code: "timeout" });
      if (err instanceof AuthenticationError) {
        return fail(res, 502, { error: "Jev rejected the API key (401)", code: "jev_error" });
      }
      if (err instanceof APIError) {
        return fail(res, 502, { error: `Jev returned HTTP ${err.status}`, code: "jev_error" });
      }
      if (err instanceof JevResponseError) {
        return fail(res, 502, { error: `Invalid Jev response: ${err.message}`, code: "jev_error" });
      }
      console.error("[decide] unexpected error", err);
      return fail(res, 502, { error: "Jev unavailable", code: "jev_unavailable" });
    }
  });

  return router;
}
