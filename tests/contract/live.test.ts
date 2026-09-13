/**
 * Contract tests against a live HeadOfContext service with the ACME realm and fixtures.
 *
 *   HOC_API_URL=http://localhost:8000 HOC_KEYCLOAK_URL=http://localhost:8180 pnpm test:contract
 *
 * Skipped when the two variables are unset.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Forbidden, HeadOfContext, KeycloakClientCredentials, scope } from "../../src/index.js";

const API = process.env.HOC_API_URL;
const KC = process.env.HOC_KEYCLOAK_URL;

// ACME fixtures from the core checkout (sibling by default); the literals are the same people
// and document as of the fixtures' current generation, for a run without the checkout.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES =
  process.env.HOC_ACME_FIXTURES ?? resolve(HERE, "../../../headofcontext/fixtures/acme/generated");
const KNOWN_USERS: Record<string, string> = {
  rh: "samir.vincent",
  direction: "alice.martin",
  "magasin-lille": "ines.leroy",
};
const KNOWN_DOCS: Record<string, string> = { "internal/rh": "document:acme-0020" };
const FULL_SCOPE = scope({
  read: ["document:*", "memory:*"],
  remember: ["document:*", "memory:*"],
  act: ["tool:*"],
});

interface User {
  username: string;
  department: string;
  intern: boolean;
}
interface Doc {
  id: string;
  confidentiality: string;
  department: string;
}

function fixture<T>(name: string): T[] | null {
  const path = resolve(FIXTURES, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T[]) : null;
}

/** A non-intern member of the department, from the fixtures when they are at hand. */
function usernameOf(department: string): string {
  const users = fixture<User>("users.json");
  if (users === null) return KNOWN_USERS[department] as string;
  const user = users.find((u) => u.department === department && !u.intern);
  if (!user) throw new Error(`no user in ${department}`);
  return user.username;
}

function documentOf(confidentiality: string, department: string): string {
  const docs = fixture<Doc>("documents.json");
  if (docs === null) return KNOWN_DOCS[`${confidentiality}/${department}`] as string;
  const doc = docs.find(
    (d) => d.confidentiality === confidentiality && d.department === department,
  );
  if (!doc) throw new Error(`no ${confidentiality} document in ${department}`);
  return doc.id;
}

async function userToken(username: string): Promise<string> {
  const response = await fetch(`${KC}/realms/acme/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "headofcontext",
      client_secret: "hoc-dev-secret",
      username,
      password: "password",
      scope: "openid",
    }),
  });
  if (!response.ok) throw new Error(`Keycloak answered ${response.status} for ${username}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

function agent(clientId: string, clientSecret: string): HeadOfContext {
  return new HeadOfContext(API as string, {
    agentToken: new KeycloakClientCredentials({
      issuer: `${KC}/realms/acme`,
      clientId,
      clientSecret,
    }),
  });
}

async function forbidden(promise: Promise<unknown>): Promise<Forbidden> {
  const thrown = await promise.catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(Forbidden);
  return thrown as Forbidden;
}

describe.skipIf(!API || !KC)("live service", () => {
  const hoc = () => agent("assistant", "assistant-dev-secret");

  it("health", async () => {
    expect((await hoc().health()).status).toBe("ok");
  });

  it("ready names every dependency (ADR 0020)", async () => {
    const body = await hoc().ready();
    expect(body.status).toBe("ready");
    expect(Object.keys(body.checks)).toEqual(
      expect.arrayContaining(["postgres", "openfga", "connectors", "schema"]),
    );
  });

  it("issue, filter, gate: zero leak across departments", async () => {
    const client = hoc();
    const rhUser = usernameOf("rh");
    const rh = await client.issue(
      await userToken(rhUser),
      scope({ read: ["document:*"], act: ["tool:*"] }),
    );
    const store = await client.issue(
      await userToken(usernameOf("magasin-lille")),
      scope({ read: ["document:*"], act: ["tool:*"] }),
    );
    const hrDoc = documentOf("internal", "rh");
    expect(rh.chain.subject).toBe(`user:${rhUser}`);
    expect((await rh.filter([{ id: hrDoc }])).kept).toEqual([{ id: hrDoc }]);
    expect((await store.filter([{ id: hrDoc }])).kept).toEqual([]);
    expect((await rh.gate("tool:mail.send")).allowed).toBe(true);
  });

  it("delegation narrows, revocation propagates", async () => {
    const rh = await hoc().issue(await userToken(usernameOf("rh")), scope({ act: ["tool:*"] }));
    const child = await rh.delegate("agent:mailer", scope({ act: ["tool:mail.*"] }));
    const mailer = agent("mailer", "mailer-dev-secret");
    expect((await mailer.gate(child.token, "tool:mail.send")).allowed).toBe(true);
    await forbidden(mailer.gate(child.token, "tool:finance.report"));
    await mailer.revoke(child.token, "done");
    expect((await forbidden(mailer.gate(child.token, "tool:mail.send"))).reason).toBe(
      "token_revoked",
    );
    expect((await rh.gate("tool:mail.send")).allowed).toBe(true);
  });

  it("mandate lifecycle (ADR 0016)", async () => {
    const client = hoc();
    const boss = usernameOf("direction");
    const human = await userToken(boss);
    const mandate = await client.createMandate(
      human,
      "agent:assistant",
      scope({ act: ["tool:mail.*"] }),
      {
        expiresInHours: 1,
        maxTokenTtlMinutes: 15,
      },
    );
    expect(mandate.active).toBe(true);
    expect(mandate.subject).toBe(`user:${boss}`);
    expect((await client.listMandates(human)).map((m) => m.mandateId)).toContain(mandate.mandateId);

    const session = await client.issueFromMandate(
      mandate.mandateId,
      scope({ act: ["tool:mail.send"] }),
    );
    expect(session.chain.subject).toBe(mandate.subject);
    expect(session.issued.revocationIds.some((r) => r.startsWith("mandate:"))).toBe(true);
    expect((await session.gate("tool:mail.send", { to: "x" })).allowed).toBe(true);

    expect((await client.revokeMandate(human, mandate.mandateId, { reason: "done" })).status).toBe(
      "revoked",
    );
    expect((await forbidden(session.gate("tool:mail.send", { to: "x" }))).reason).toBe(
      "token_revoked",
    );
    expect(
      (
        await forbidden(
          client.issueFromMandate(mandate.mandateId, scope({ act: ["tool:mail.send"] })),
        )
      ).reason,
    ).toBe("mandate_revoked");
  });

  it("memory with provenance", async () => {
    const client = hoc();
    const rh = await client.issue(await userToken(usernameOf("rh")), FULL_SCOPE);
    const store = await client.issue(await userToken(usernameOf("magasin-lille")), FULL_SCOPE);
    const hrDoc = documentOf("internal", "rh");
    const memory = await rh.remember("Grille salaires 2026: +3 % vendeurs", {
      derivedFrom: [hrDoc],
    });
    expect(memory.derivedFrom).toEqual([hrDoc]);
    expect(memory.writtenFor).toBe(rh.chain.subject);
    try {
      expect((await rh.recall("salaires", { limit: 5 })).map((m) => m.memoryId)).toEqual([
        memory.memoryId,
      ]);
      expect(await store.recall("salaires", { limit: 5 })).toEqual([]);
    } finally {
      await rh.forget(memory.memoryId);
    }
    expect((await rh.recall("salaires", { limit: 5 })).map((m) => m.memoryId)).not.toContain(
      memory.memoryId,
    );
  });

  it("approval round trip (ADR 0008, ADR 0017)", async () => {
    const client = hoc();
    const rh = await client.issue(await userToken(usernameOf("rh")), scope({ act: ["tool:*"] }));
    const args = { year: 2026 };
    const parked = await rh.gate("tool:hr.export", args);
    expect(parked.pending).toBe(true);
    const requestId = parked.approval?.requestId as string;

    const stranger = await userToken(usernameOf("magasin-lille"));
    expect((await client.pendingApprovals(stranger)).map((r) => r.requestId)).not.toContain(
      requestId,
    );
    expect(
      (await forbidden(client.resolveApproval(stranger, requestId, { approved: true }))).reason,
    ).toBe("approver_not_authorized");

    const boss = await userToken(usernameOf("direction"));
    expect((await client.pendingApprovals(boss)).map((r) => r.requestId)).toContain(requestId);
    expect(
      (await client.resolveApproval(boss, requestId, { approved: true, reason: "ok" })).status,
    ).toBe("approved");

    expect((await rh.redeem(requestId, "tool:hr.export", args)).allowed).toBe(true);
    const replay = await rh.redeem(requestId, "tool:hr.export", args);
    expect([replay.outcome, replay.reason]).toEqual(["DENY", "approval_consumed"]);
  });
});
