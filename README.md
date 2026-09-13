# @headofcontext/client

Thin TypeScript client for the [HeadOfContext](https://github.com/headofcontext/headofcontext)
service: the single authorization layer for enterprise AI agents (READ, ACT, DELEGATE,
REMEMBER). No runtime dependency; built on the global `fetch`. Node 20+, Deno, Bun and
browsers.

```bash
npm install @headofcontext/client
```

```ts
import { HeadOfContext, KeycloakClientCredentials, scope } from "@headofcontext/client";

const agent = new KeycloakClientCredentials({
  issuer: "https://keycloak.example.com/realms/acme",
  clientId: "assistant",
  clientSecret: process.env.ASSISTANT_SECRET!,
});
const hoc = new HeadOfContext("https://headofcontext.example.com", { agentToken: agent });

// The user is present: get a root biscuit for (user, this agent, scope).
const session = await hoc.issue(
  userAccessToken,
  scope({ read: ["document:*", "memory:*"], act: ["tool:mail.*"] }),
);

// READ: keep only what the user may see, before anything reaches the model.
const { kept } = await session.filter(indexResults, { idOf: (hit) => hit.documentId });

// ACT: authorize a tool call under the user's identity.
const result = await session.gate("tool:mail.send", { to: "bob@acme.example" });
if (result.allowed) sendMail(/* ... */);
else if (result.pending) park(result.approval!.requestId);

// DELEGATE: hand a narrower token to a sub-agent (its own client credentials).
const child = await session.delegate("agent:mailer", scope({ act: ["tool:mail.send"] }));

// REMEMBER: provenance-aware memory.
await session.remember("Summary…", { derivedFrom: ["document:hr-1"] });
const memories = await session.recall("salary grid");
```

Denials are results (`outcome === "DENY"`), never exceptions. Authentication and token
failures throw `Unauthorized` / `Forbidden`; an unavailable service throws `Unavailable`; a
request outside the contract throws `InvalidRequest`. Every error carries the service's
`reason` and `status`.

## Guarding tools

`ToolGuard` wraps a tool function so that every call is gated first, with the same refusal
wording as the other HeadOfContext integrations.

```ts
import { ToolGuard } from "@headofcontext/client";

const guard = new ToolGuard(session, { toolMap: { send_mail: "mail.send" } });
const sendMail = guard.wrap("send_mail", async ({ to }: { to: string }) => mailer.send(to));

await sendMail({ to: "bob@acme.example" });
// "HeadOfContext denied tool 'send_mail': not_related. Do not retry." when the service says no
```

With `onDeny: "throw"` a refusal throws `ActionDenied` or `ApprovalPending` instead.

## Approvals

A gated tool can answer `REQUIRE_APPROVAL`: the call is parked under a `requestId`, bound to
the hash of its arguments. A human resolves it with their own access token, then the agent
redeems it once, with the same tool and arguments.

```ts
// The agent parks the call.
const parked = await session.gate("tool:hr.export", { year: 2026 });
const requestId = parked.approval!.requestId; // parked.pending === true

// A human lists and resolves what they may approve.
for (const request of await hoc.pendingApprovals(managerAccessToken)) { /* ... */ }
await hoc.resolveApproval(managerAccessToken, requestId, { approved: true, reason: "ok" });

// The agent redeems: ALLOW once, then DENY with reason "approval_consumed".
const decision = await session.redeem(requestId, "tool:hr.export", { year: 2026 });
```

The approver must hold `tool:<id>#approver` in OpenFGA (directly or through a group);
`pendingApprovals` only lists those requests, and resolving another one throws `Forbidden`
with reason `approver_not_authorized`.

## Mandates

A mandate is a standing authorization from a human to an agent: created while the human is
present, used by the agent alone afterwards, revoked in one call. The subject stays the human;
every token issued under the mandate is a subset of its scope and dies with it.

```ts
// The human, once.
const mandate = await hoc.createMandate(userAccessToken, "agent:assistant", scope({ act: ["tool:mail.*"] }), {
  expiresInHours: 48,
  maxTokenTtlMinutes: 15,
});
await hoc.listMandates(userAccessToken);

// The agent, later, with its own client credentials only.
const session = await hoc.issueFromMandate(mandate.mandateId, scope({ act: ["tool:mail.send"] }));

// The human, when done: tokens already issued are dead before the next decision,
// and a new issue throws Forbidden with reason "mandate_revoked".
await hoc.revokeMandate(userAccessToken, mandate.mandateId, { reason: "done" });
```

## Tokens

`session.delegate(toActor, scope)` (`hoc.attenuate` on a raw token) returns a narrower token
for a sub-agent; a wider scope throws `Forbidden` with reason `scope_escalation`. The sub-agent
uses it with its own credentials: `mailer.gate(child.token, ...)`. `session.revoke()`
(`hoc.revoke(token)`) invalidates that token and everything attenuated from it; later calls
throw `Forbidden` with reason `token_revoked`. Revoking a token never revokes the mandate it was
issued under. `hoc.inspect(token)` returns the chain without deciding anything.

Tokens never appear in error messages or in `String(session)`; `fingerprint(token)` gives the
sha256 prefix to name one in a log.

## Probes

`await hoc.health()` is liveness: `{ status: "ok", ... }` while the process serves requests.
`await hoc.ready()` is readiness: `{ status: "ready" | "not_ready", checks: { postgres, openfga,
connectors, schema } }`. A `not_ready` answer (HTTP 503) is returned as data, not thrown, so you
can read which check fails.

## Options

```ts
new HeadOfContext(baseUrl, {
  agentToken,        // a TokenProvider (client credentials) or a fixed bearer string
  fetch,             // optional: your own fetch (proxies, custom agents, tests)
  timeoutMs,         // optional, default 15000
});
```

The client is written against `contract/openapi.json`, copied from the core repository at the
commit recorded in `contract/core-ref`.

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
