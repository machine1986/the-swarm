import type { ApiErrorBody, DecisionResult, StatusResponse, SwarmState } from "../../../shared/types.ts";

export class DecisionRequestError extends Error {
  readonly code: ApiErrorBody["code"] | "network" | "aborted";
  constructor(message: string, code: DecisionRequestError["code"]) {
    super(message);
    this.code = code;
  }
}

export async function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const res = await fetch("/api/status", { signal });
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return (await res.json()) as StatusResponse;
}

export async function requestDecision(state: SwarmState, signal: AbortSignal): Promise<DecisionResult> {
  let res: Response;
  try {
    res = await fetch("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new DecisionRequestError("Request timed out", "aborted");
    throw new DecisionRequestError(`Backend unreachable (${(err as Error).message})`, "network");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new DecisionRequestError(body?.error ?? `HTTP ${res.status}`, body?.code ?? "internal");
  }
  return (await res.json()) as DecisionResult;
}

export async function saveRecordingToServer(json: string): Promise<string | null> {
  try {
    const res = await fetch("/api/recordings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });
    if (!res.ok) return null;
    return ((await res.json()) as { name: string }).name;
  } catch {
    return null;
  }
}

export async function listServerRecordings(): Promise<string[]> {
  try {
    const res = await fetch("/api/recordings");
    if (!res.ok) return [];
    return ((await res.json()) as { recordings: string[] }).recordings;
  } catch {
    return [];
  }
}

export async function loadServerRecording(name: string): Promise<unknown> {
  const res = await fetch(`/api/recordings/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
