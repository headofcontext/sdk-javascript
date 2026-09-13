import { beforeEach, describe, expect, it } from "vitest";

import {
  Forbidden,
  fingerprint,
  HeadOfContext,
  HeadOfContextError,
  InvalidRequest,
  scope,
  Unauthorized,
  Unavailable,
} from "../../src/index.js";
import { DECISION, FakeService } from "./fake-service.js";

let service: FakeService;
let client: HeadOfContext;

beforeEach(() => {
  service = new FakeService();
  client = new HeadOfContext("http://hoc.test/", {
    agentToken: "agent-bearer",
    fetch: service.fetch,
  });
});

function last() {
  const recorded = service.requests.at(-1);
  if (!recorded) throw new Error("no request recorded");
  return recorded;
}

describe("tokens", () => {
  it("issue sends the scope under the agent bearer", async () => {
    const session = await client.issue(
      "user-jwt",
      scope({ read: ["document:*"], act: ["tool:mail.*"] }),
    );
    const { method, path, body, auth } = last();
    expect([method, path, auth]).toEqual(["POST", "/v1/tokens/issue", "Bearer agent-bearer"]);
    expect(body).toEqual({
      user_token: "user-jwt",
      scope: {
        capabilities: [
          { kind: "read", resource: "document:*" },
          { kind: "act", resource: "tool:mail.*" },
        ],
      },
    });
    expect(session.chain.subject).toBe("user:alice");
    expect(session.token).toBe("b64.token.value");
    expect(String(session)).not.toContain("b64.token.value");
    expect(await fingerprint(session.token)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("issue passes ttl_minutes only when given", async () => {
    await client.issue("user-jwt", scope({ act: ["tool:*"] }), { ttlMinutes: 5 });
    expect(last().body).toMatchObject({ ttl_minutes: 5 });
    await client.issue("user-jwt", scope({ act: ["tool:*"] }));
    expect(last().body).not.toHaveProperty("ttl_minutes");
  });

  it("issueFromMandate uses the agent credentials only", async () => {
    const session = await client.issueFromMandate("m1", scope({ act: ["tool:mail.send"] }), {
      ttlMinutes: 10,
    });
    const { method, path, body, auth } = last();
    expect([method, path, auth]).toEqual(["POST", "/v1/tokens/issue", "Bearer agent-bearer"]);
    expect(body).toEqual({
      mandate_id: "m1",
      scope: { capabilities: [{ kind: "act", resource: "tool:mail.send" }] },
      ttl_minutes: 10,
    });
    expect(session.token).toBe("b64.token.value");
  });

  it("delegate and revoke", async () => {
    const session = await client.issue("user-jwt", scope({ act: ["tool:*"] }));
    const child = await session.delegate("agent:mailer", scope({ act: ["tool:mail.*"] }));
    expect(last().body).toMatchObject({ to_actor: "agent:mailer" });
    expect(child.token).toBe("b64.token.value");
    expect(child.revocationIds).toEqual(["r1"]);
    await session.revoke("done");
    expect(last().body).toEqual({ token: "b64.token.value", reason: "done" });
  });

  it("inspect returns the chain and the expiry", async () => {
    const inspection = await client.inspect("some-token");
    expect(inspection.chain.actor).toBe("agent:assistant");
    expect(inspection.expiresAt?.toISOString()).toBe("2026-09-07T13:00:00.000Z");
  });
});

describe("read", () => {
  it("filter maps the kept references back to the objects, in order", async () => {
    const session = await client.issue("user-jwt", scope({ read: ["document:*"] }));
    const hits = [
      { doc: "document:a-ok", text: "..." },
      { doc: "document:secret", text: "..." },
      { doc: null },
      { doc: "document:b-ok" },
    ];
    const result = await session.filter(hits, { idOf: (h) => h.doc });
    expect(result.kept).toEqual([hits[0], hits[3]]);
    expect(result.dropped).toEqual(["document:secret", "invalid"]);
    expect(last().body).toMatchObject({
      items: [
        { id: "document:a-ok" },
        { id: "document:secret" },
        { id: null },
        { id: "document:b-ok" },
      ],
      relation: "viewer",
      strategy: "auto",
    });
  });

  it("filter reads `id` by default", async () => {
    const result = await client.filter("t", [{ id: "document:x-ok" }, { id: 3 }, "junk"]);
    expect(result.kept).toEqual([{ id: "document:x-ok" }]);
    expect(result.dropped).toEqual(["invalid", "invalid"]);
  });
});

describe("actions", () => {
  it("gate and redeem", async () => {
    const session = await client.issue("user-jwt", scope({ act: ["tool:*"] }));
    const result = await session.gate("tool:mail.send", { to: "bob" });
    expect(result.allowed).toBe(true);
    expect(result.pending).toBe(false);
    expect(last().body).toEqual({
      token: "b64.token.value",
      tool: "tool:mail.send",
      args: { to: "bob" },
    });
    const decision = await session.redeem("req-1", "tool:mail.send", { to: "bob" });
    expect(decision.allowed).toBe(true);
    expect(decision.decisionId).toBe("d1");
    expect(last().body).toMatchObject({ request_id: "req-1" });
  });

  it("a denial is a result, not an error", async () => {
    service.responses.set("/v1/actions/gate", [
      200,
      { decision: { ...DECISION, outcome: "DENY", reason: "not_related" }, approval: null },
    ]);
    const result = await client.gate("t", "tool:hr.export");
    expect(result.allowed).toBe(false);
    expect(result.decision.reason).toBe("not_related");
  });

  it("a pending approval carries the request", async () => {
    service.responses.set("/v1/actions/gate", [
      200,
      {
        decision: { ...DECISION, outcome: "REQUIRE_APPROVAL", reason: "approval_required" },
        approval: {
          request_id: "req-9",
          subject: "user:alice",
          actor: "agent:assistant",
          delegation_depth: 0,
          tool: "tool:payment.send",
          args_hash: "h",
          status: "pending",
          created_at: "2026-09-07T12:00:00+00:00",
          expires_at: "2026-09-07T13:00:00+00:00",
          approval_reason: "approval_required",
        },
      },
    ]);
    const result = await client.gate("t", "tool:payment.send", { amount: 5 });
    expect(result.pending).toBe(true);
    expect(result.approval?.requestId).toBe("req-9");
    expect(result.approval?.status).toBe("pending");
  });
});

describe("approvals", () => {
  it("use the human's token", async () => {
    await client.pendingApprovals("user-jwt");
    expect(last()).toMatchObject({ method: "GET", path: "/v1/approvals", auth: "Bearer user-jwt" });
    service.responses.set("/v1/approvals/req-1/resolve", [
      200,
      {
        request_id: "req-1",
        subject: "user:alice",
        actor: "agent:assistant",
        tool: "tool:x",
        status: "approved",
        created_at: null,
        expires_at: null,
        resolved_by: "user:carol",
      },
    ]);
    const approval = await client.resolveApproval("carol-jwt", "req-1", {
      approved: true,
      reason: "ok",
    });
    expect(approval.status).toBe("approved");
    expect(approval.resolvedBy).toBe("user:carol");
    expect(last()).toMatchObject({
      auth: "Bearer carol-jwt",
      body: { approved: true, reason: "ok" },
    });
  });
});

describe("mandates", () => {
  it("are created, listed and revoked by the human", async () => {
    const mandate = await client.createMandate(
      "user-jwt",
      "agent:assistant",
      scope({ act: ["tool:mail.*"] }),
      {
        expiresInHours: 48,
        maxTokenTtlMinutes: 15,
      },
    );
    expect(last()).toMatchObject({
      method: "POST",
      path: "/v1/mandates",
      auth: "Bearer user-jwt",
      body: {
        agent: "agent:assistant",
        scope: { capabilities: [{ kind: "act", resource: "tool:mail.*" }] },
        expires_in_hours: 48,
        max_token_ttl_minutes: 15,
      },
    });
    expect(mandate.active).toBe(true);
    expect(mandate.mandateId).toBe("m1");

    const listed = await client.listMandates("user-jwt");
    expect(last()).toMatchObject({ method: "GET", path: "/v1/mandates" });
    expect(listed.map((m) => m.mandateId)).toEqual(["m1"]);

    await client.revokeMandate("user-jwt", "m1", { reason: "done" });
    expect(last()).toMatchObject({
      method: "DELETE",
      path: "/v1/mandates/m1",
      body: { reason: "done" },
      auth: "Bearer user-jwt",
    });
  });
});

describe("memory", () => {
  it("round trip", async () => {
    const session = await client.issue(
      "user-jwt",
      scope({ read: ["memory:*"], remember: ["document:*"] }),
    );
    const memory = await session.remember("Summary", { derivedFrom: ["document:hr-1"] });
    expect(memory.memoryId).toBe("memory:m1");
    expect(memory.derivedFrom).toEqual(["document:hr-1"]);
    expect(await session.recall("summary")).toEqual([]);
    expect(last().body).toMatchObject({ query: "summary", limit: 10 });
    await session.forget(memory.memoryId);
    expect(last().path).toBe("/v1/memory/forget");
  });
});

describe("errors", () => {
  it.each([
    [401, { reason: "identity_error", detail: "bad" }, Unauthorized],
    [403, { reason: "token_revoked", detail: "revoked" }, Forbidden],
    [422, { detail: [{ msg: "bad" }] }, InvalidRequest],
    [503, { reason: "engine_unavailable", detail: "down" }, Unavailable],
    [429, { reason: "rate_limited", detail: "slow down" }, HeadOfContextError],
  ])("maps HTTP %i", async (status, payload, error) => {
    service.responses.set("/v1/tokens/inspect", [status, payload]);
    const thrown = await client.inspect("some-token").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(error);
    const typed = thrown as HeadOfContextError;
    expect(typed.status).toBe(status);
    if (status !== 422) expect(typed.reason).toBe((payload as { reason?: string }).reason);
  });

  it("a transport failure is Unavailable", async () => {
    const down = new HeadOfContext("http://hoc.test", {
      agentToken: "t",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const thrown = await down.health().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Unavailable);
    expect((thrown as Unavailable).reason).toBe("transport_error");
  });

  it("never puts the token in an error message", async () => {
    service.responses.set("/v1/tokens/inspect", [
      403,
      { reason: "token_revoked", detail: "revoked" },
    ]);
    const thrown = (await client.inspect("secret-token-value").catch((e: unknown) => e)) as Error;
    expect(thrown.message).not.toContain("secret-token-value");
  });
});

describe("probes", () => {
  it("health", async () => {
    expect((await client.health()).status).toBe("ok");
    expect(last()).toMatchObject({ method: "GET", path: "/v1/health", auth: null });
  });

  it("ready", async () => {
    const body = await client.ready();
    expect(body.status).toBe("ready");
    expect(body.checks.openfga).toBe("ok");
    expect(last()).toMatchObject({ method: "GET", path: "/v1/ready", auth: null });
  });

  it("not_ready is data, not an error", async () => {
    service.responses.set("/v1/ready", [
      503,
      { status: "not_ready", checks: { postgres: "ok", openfga: "error: refused" } },
    ]);
    const body = await client.ready();
    expect(body.status).toBe("not_ready");
    expect(body.checks.openfga).toMatch(/^error:/);
  });

  it("a dead proxy is not_ready with no checks", async () => {
    service.responses.set("/v1/ready", [503, "upstream connect error"]);
    expect(await client.ready()).toEqual({ status: "not_ready", checks: {} });
  });

  it("other ready errors still throw", async () => {
    service.responses.set("/v1/ready", [429, { reason: "rate_limited", detail: "slow down" }]);
    const thrown = (await client.ready().catch((e: unknown) => e)) as HeadOfContextError;
    expect(thrown).toBeInstanceOf(HeadOfContextError);
    expect([thrown.status, thrown.reason]).toEqual([429, "rate_limited"]);
  });
});
