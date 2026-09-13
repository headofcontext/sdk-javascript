/** The client. Every call carries the agent's bearer token; delegated calls carry the biscuit. */

import { type Fetch, StaticToken, type TokenProvider } from "./auth.js";
import {
  Forbidden,
  HeadOfContextError,
  InvalidRequest,
  Unauthorized,
  Unavailable,
} from "./errors.js";
import {
  Approval,
  Decision,
  type FilterResult,
  GateResult,
  type Health,
  Inspection,
  IssuedToken,
  type Json,
  Mandate,
  Memory,
  type Readiness,
  type Scope,
} from "./models.js";

const API = "/v1";

export interface HeadOfContextOptions {
  /** The agent's bearer: a provider (client credentials) or a fixed token. */
  agentToken: TokenProvider | string;
  /** Override the global `fetch` (tests, custom agents, proxies). */
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface FilterOptions<T> {
  /** How to read the `document:` reference of an item. Default: `item.id`. */
  idOf?: (item: T) => unknown;
  relation?: "viewer" | "editor";
  strategy?: "auto" | "batch" | "list_objects";
}

export type ToolArgs = Record<string, unknown>;

export function defaultIdOf(item: unknown): unknown {
  return item !== null && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
}

export class HeadOfContext {
  readonly #base: string;
  readonly #agent: TokenProvider;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, options: HeadOfContextOptions) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#agent =
      typeof options.agentToken === "string"
        ? new StaticToken(options.agentToken)
        : options.agentToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  // -- tokens ------------------------------------------------------------------------------

  /** A root biscuit for (user, this agent, scope), while the user is present. */
  async issue(
    userToken: string,
    scope: Scope,
    options?: { ttlMinutes?: number },
  ): Promise<Session> {
    const body: Json = { user_token: userToken, scope };
    if (options?.ttlMinutes !== undefined) body.ttl_minutes = options.ttlMinutes;
    return new Session(this, IssuedToken.fromJson(await this.#post("/tokens/issue", body)));
  }

  /** A session under a standing mandate: no human token needed (ADR 0016). */
  async issueFromMandate(
    mandateId: string,
    scope: Scope,
    options?: { ttlMinutes?: number },
  ): Promise<Session> {
    const body: Json = { mandate_id: mandateId, scope };
    if (options?.ttlMinutes !== undefined) body.ttl_minutes = options.ttlMinutes;
    return new Session(this, IssuedToken.fromJson(await this.#post("/tokens/issue", body)));
  }

  async attenuate(token: string, toActor: string, scope: Scope): Promise<IssuedToken> {
    return IssuedToken.fromJson(
      await this.#post("/tokens/attenuate", { token, to_actor: toActor, scope }),
    );
  }

  async inspect(token: string): Promise<Inspection> {
    return Inspection.fromJson(await this.#post("/tokens/inspect", { token }));
  }

  async revoke(token: string, reason = "revoked by holder"): Promise<Inspection> {
    return Inspection.fromJson(await this.#post("/tokens/revoke", { token, reason }));
  }

  // -- read --------------------------------------------------------------------------------

  /** Keep the items whose document the subject may view, in the index's order. */
  async filter<T>(
    token: string,
    items: readonly T[],
    options?: FilterOptions<T>,
  ): Promise<FilterResult<T>> {
    const extract = options?.idOf ?? defaultIdOf;
    const refs = items.map((item) => extract(item));
    const data = await this.#post("/read/filter", {
      token,
      items: refs.map((ref) => ({ id: typeof ref === "string" ? ref : null })),
      relation: options?.relation ?? "viewer",
      strategy: options?.strategy ?? "auto",
    });
    const keptRefs = new Set(Array.isArray(data.kept) ? (data.kept as string[]) : []);
    return {
      kept: items.filter((_, index) => keptRefs.has(refs[index] as string)),
      dropped: Array.isArray(data.dropped) ? (data.dropped as string[]) : [],
      strategy: String(data.strategy ?? ""),
    };
  }

  // -- actions -----------------------------------------------------------------------------

  async gate(token: string, tool: string, args: ToolArgs = {}): Promise<GateResult> {
    return GateResult.fromJson(await this.#post("/actions/gate", { token, tool, args }));
  }

  async redeem(
    token: string,
    requestId: string,
    tool: string,
    args: ToolArgs = {},
  ): Promise<Decision> {
    return Decision.fromJson(
      await this.#post("/actions/redeem", { token, request_id: requestId, tool, args }),
    );
  }

  // -- approvals (human caller) ------------------------------------------------------------

  async pendingApprovals(userToken: string): Promise<Approval[]> {
    const data = await this.#request("GET", "/approvals", null, userToken);
    return (Array.isArray(data.requests) ? (data.requests as Json[]) : []).map(Approval.fromJson);
  }

  async resolveApproval(
    userToken: string,
    requestId: string,
    options: { approved: boolean; reason?: string },
  ): Promise<Approval> {
    return Approval.fromJson(
      await this.#request(
        "POST",
        `/approvals/${encodeURIComponent(requestId)}/resolve`,
        { approved: options.approved, reason: options.reason ?? "" },
        userToken,
      ),
    );
  }

  // -- mandates (ADR 0016), by the human ---------------------------------------------------

  async createMandate(
    userToken: string,
    agent: string,
    scope: Scope,
    options: { expiresInHours: number; maxTokenTtlMinutes?: number },
  ): Promise<Mandate> {
    const body: Json = { agent, scope, expires_in_hours: options.expiresInHours };
    if (options.maxTokenTtlMinutes !== undefined) {
      body.max_token_ttl_minutes = options.maxTokenTtlMinutes;
    }
    return Mandate.fromJson(await this.#request("POST", "/mandates", body, userToken));
  }

  async listMandates(userToken: string): Promise<Mandate[]> {
    const data = await this.#request("GET", "/mandates", null, userToken);
    return (Array.isArray(data.mandates) ? (data.mandates as Json[]) : []).map(Mandate.fromJson);
  }

  async revokeMandate(
    userToken: string,
    mandateId: string,
    options?: { reason?: string },
  ): Promise<Mandate> {
    return Mandate.fromJson(
      await this.#request(
        "DELETE",
        `/mandates/${encodeURIComponent(mandateId)}`,
        { reason: options?.reason ?? "revoked by subject" },
        userToken,
      ),
    );
  }

  // -- memory ------------------------------------------------------------------------------

  async remember(
    token: string,
    content: string,
    options?: { derivedFrom?: readonly string[] },
  ): Promise<Memory> {
    return Memory.fromJson(
      await this.#post("/memory/remember", {
        token,
        content,
        derived_from: [...(options?.derivedFrom ?? [])],
      }),
    );
  }

  async recall(token: string, query: string, options?: { limit?: number }): Promise<Memory[]> {
    const data = await this.#post("/memory/recall", {
      token,
      query,
      limit: options?.limit ?? 10,
    });
    return (Array.isArray(data.memories) ? (data.memories as Json[]) : []).map(Memory.fromJson);
  }

  async forget(token: string, memoryId: string): Promise<void> {
    await this.#post("/memory/forget", { token, memory_id: memoryId });
  }

  // -- probes ------------------------------------------------------------------------------

  /** Liveness: the process serves requests. */
  async health(): Promise<Health> {
    return (await parse(await this.#get(`${API}/health`))) as Health;
  }

  /**
   * Readiness (ADR 0020): `{ status: "ready" | "not_ready", checks: { name: string } }`.
   * A `not_ready` answer comes with HTTP 503 and is returned as data, never thrown: the probe's
   * job is to say which dependency fails. A 503 without a readiness body (a proxy answering for
   * a pod that is down) is reported the same way, with no checks.
   */
  async ready(): Promise<Readiness> {
    const response = await this.#get(`${API}/ready`);
    if (response.status !== 503) return (await parse(response)) as Readiness;
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (data !== null && typeof data === "object" && "status" in data) return data as Readiness;
    return { status: "not_ready", checks: {} };
  }

  // -- internals ---------------------------------------------------------------------------

  async #get(path: string): Promise<Response> {
    try {
      return await this.#fetch(`${this.#base}${path}`, {
        method: "GET",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw transportError(error);
    }
  }

  async #post(path: string, body: Json): Promise<Json> {
    return this.#request("POST", path, body, await this.#agent.token());
  }

  async #request(method: string, path: string, body: Json | null, bearer: string): Promise<Json> {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (body !== null) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${API}${path}`, init);
    } catch (error) {
      throw transportError(error);
    }
    return parse(response);
  }
}

function transportError(error: unknown): Unavailable {
  const name = error instanceof Error ? error.name : "Error";
  return new Unavailable("transport_error", name);
}

async function parse(response: Response): Promise<Json> {
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (response.status === 200) {
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Json)
      : { value: payload };
  }
  let reason = "http_error";
  let detail = text.slice(0, 200);
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Json;
    if (p.reason !== undefined) reason = String(p.reason);
    if (p.detail !== undefined)
      detail = typeof p.detail === "string" ? p.detail : JSON.stringify(p.detail);
  }
  const status = response.status;
  if (status === 401) throw new Unauthorized(reason, detail, status);
  if (status === 403) throw new Forbidden(reason, detail, status);
  if (status === 422) throw new InvalidRequest("invalid_request", detail, status);
  if (status >= 500) throw new Unavailable(reason, detail, status);
  throw new HeadOfContextError(reason, detail, status);
}

/** A biscuit bound to this client's agent. Every call re-verifies it server-side. */
export class Session {
  readonly #client: HeadOfContext;
  readonly issued: IssuedToken;

  constructor(client: HeadOfContext, issued: IssuedToken) {
    this.#client = client;
    this.issued = issued;
  }

  get token(): string {
    return this.issued.token;
  }

  get chain(): IssuedToken["chain"] {
    return this.issued.chain;
  }

  /** Never includes the token; use `fingerprint(session.token)` to name it in a log. */
  toString(): string {
    return `Session(subject=${this.chain.subject}, actor=${this.chain.actor})`;
  }

  filter<T>(items: readonly T[], options?: FilterOptions<T>): Promise<FilterResult<T>> {
    return this.#client.filter(this.token, items, options);
  }

  gate(tool: string, args: ToolArgs = {}): Promise<GateResult> {
    return this.#client.gate(this.token, tool, args);
  }

  redeem(requestId: string, tool: string, args: ToolArgs = {}): Promise<Decision> {
    return this.#client.redeem(this.token, requestId, tool, args);
  }

  /** The attenuated token to hand to a sub-agent, which uses it with its own credentials. */
  delegate(toActor: string, scope: Scope): Promise<IssuedToken> {
    return this.#client.attenuate(this.token, toActor, scope);
  }

  revoke(reason = "revoked by holder"): Promise<Inspection> {
    return this.#client.revoke(this.token, reason);
  }

  remember(content: string, options?: { derivedFrom?: readonly string[] }): Promise<Memory> {
    return this.#client.remember(this.token, content, options);
  }

  recall(query: string, options?: { limit?: number }): Promise<Memory[]> {
    return this.#client.recall(this.token, query, options);
  }

  forget(memoryId: string): Promise<void> {
    return this.#client.forget(this.token, memoryId);
  }
}
