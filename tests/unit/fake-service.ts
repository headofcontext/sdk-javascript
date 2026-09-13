/** A fake HeadOfContext service behind `fetch`, shaped by contract/openapi.json. */

import type { Json } from "../../src/models.js";

export const CHAIN: Json = {
  subject: "user:alice",
  actor: "agent:assistant",
  root_actor: "agent:assistant",
  depth: 0,
  scope: { capabilities: [{ kind: "read", resource: "document:*" }] },
  delegation: [],
};

export const DECISION: Json = {
  outcome: "ALLOW",
  reason: "allowed",
  decision_id: "d1",
  resource: "tool:mail.send",
  timestamp: "2026-09-07T12:00:00+00:00",
  engine_latency_ms: 1.5,
};

export const MANDATE: Json = {
  mandate_id: "m1",
  subject: "user:alice",
  agent: "agent:assistant",
  scope: { capabilities: [{ kind: "act", resource: "tool:mail.*" }] },
  status: "active",
  created_at: "2026-09-08T09:00:00+00:00",
  expires_at: "2026-09-10T09:00:00+00:00",
  max_token_ttl_minutes: 15,
  created_by: "user:alice",
  revoked_at: null,
  revocation_reason: null,
};

export interface Recorded {
  method: string;
  path: string;
  body: Json | null;
  auth: string | null;
}

export class FakeService {
  readonly requests: Recorded[] = [];
  /** Path -> [status, payload]; a string payload is sent as text, anything else as JSON. */
  readonly responses = new Map<string, [number, unknown]>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const raw = init?.body;
    const body = typeof raw === "string" && raw !== "" ? (JSON.parse(raw) as Json) : null;
    const headers = new Headers(init?.headers);
    this.requests.push({ method, path: url.pathname, body, auth: headers.get("Authorization") });
    const canned = this.responses.get(url.pathname);
    if (canned) return respond(canned[0], canned[1]);
    return this.default(url.pathname, body);
  };

  private default(path: string, body: Json | null): Response {
    const token = {
      token: "b64.token.value",
      chain: CHAIN,
      expires_at: "2026-09-07T13:00:00+00:00",
      revocation_ids: ["r1"],
    };
    if (path.endsWith("/tokens/issue") || path.endsWith("/tokens/attenuate")) {
      return respond(200, token);
    }
    if (path.endsWith("/tokens/inspect") || path.endsWith("/tokens/revoke")) {
      const { token: _, ...inspection } = token;
      return respond(200, inspection);
    }
    if (path.endsWith("/read/filter")) {
      const ids = ((body?.items as { id: string | null }[]) ?? []).map((i) => i.id);
      const kept = ids.filter((i): i is string => typeof i === "string" && i.endsWith("ok"));
      return respond(200, {
        kept,
        dropped: ids.filter((i) => !kept.includes(i as string)).map((i) => i ?? "invalid"),
        strategy: "batch",
      });
    }
    if (path.endsWith("/actions/gate")) return respond(200, { decision: DECISION, approval: null });
    if (path.endsWith("/actions/redeem")) return respond(200, DECISION);
    if (path.endsWith("/mandates")) return respond(200, body ? MANDATE : { mandates: [MANDATE] });
    if (path.includes("/mandates/")) return respond(200, MANDATE);
    if (path.endsWith("/approvals")) return respond(200, { requests: [] });
    if (path.endsWith("/memory/remember")) {
      return respond(200, {
        memory_id: "memory:m1",
        content: body?.content,
        derived_from: body?.derived_from,
        written_for: "user:alice",
        written_by: "agent:assistant",
        created_at: null,
      });
    }
    if (path.endsWith("/memory/recall")) return respond(200, { memories: [] });
    if (path.endsWith("/memory/forget")) {
      return respond(200, {
        memory_id: body?.memory_id,
        content: "",
        derived_from: [],
        written_for: "user:alice",
        written_by: "agent:assistant",
        created_at: null,
      });
    }
    if (path.endsWith("/health")) {
      return respond(200, { status: "ok", service: "headofcontext", connectors: "fresh" });
    }
    if (path.endsWith("/ready")) {
      return respond(200, {
        status: "ready",
        checks: { postgres: "ok", openfga: "ok", connectors: "fresh", schema: "ok" },
      });
    }
    return respond(404, { reason: "not_found", detail: path });
  }
}

function respond(status: number, payload: unknown): Response {
  if (typeof payload === "string") {
    return new Response(payload, { status, headers: { "Content-Type": "text/plain" } });
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
