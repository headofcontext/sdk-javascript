/**
 * The contract's response shapes as plain classes. Field names are camelCase here; the wire
 * format stays the service's snake_case. No validation library: the service is the source of
 * truth, the client only reads what it returns.
 */

export type Json = Record<string, unknown>;

export interface Capability {
  kind: "read" | "act" | "remember";
  resource: string;
}

/** The `scope` body sent to the service. */
export interface Scope {
  capabilities: Capability[];
}

/** Build a scope: `scope({ read: ["document:*"], act: ["tool:mail.*"] })`. */
export function scope(caps: { read?: string[]; act?: string[]; remember?: string[] }): Scope {
  const capabilities: Capability[] = [];
  for (const resource of caps.read ?? []) capabilities.push({ kind: "read", resource });
  for (const resource of caps.act ?? []) capabilities.push({ kind: "act", resource });
  for (const resource of caps.remember ?? []) capabilities.push({ kind: "remember", resource });
  return { capabilities };
}

function date(value: unknown): Date | null {
  return typeof value === "string" ? new Date(value) : null;
}

function str(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function optional(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

export class Chain {
  constructor(
    readonly subject: string,
    readonly actor: string,
    readonly rootActor: string,
    readonly depth: number,
    readonly scope: Scope,
    readonly delegation: Json[],
  ) {}

  static fromJson(data: Json): Chain {
    return new Chain(
      str(data.subject),
      str(data.actor),
      str(data.root_actor),
      Number(data.depth),
      (data.scope as Scope) ?? { capabilities: [] },
      Array.isArray(data.delegation) ? (data.delegation as Json[]) : [],
    );
  }
}

export class IssuedToken {
  constructor(
    readonly token: string,
    readonly chain: Chain,
    readonly expiresAt: Date | null,
    readonly revocationIds: string[],
  ) {}

  static fromJson(data: Json): IssuedToken {
    return new IssuedToken(
      str(data.token),
      Chain.fromJson(data.chain as Json),
      date(data.expires_at),
      strings(data.revocation_ids),
    );
  }
}

export class Inspection {
  constructor(
    readonly chain: Chain,
    readonly expiresAt: Date | null,
    readonly revocationIds: string[],
  ) {}

  static fromJson(data: Json): Inspection {
    return new Inspection(
      Chain.fromJson(data.chain as Json),
      date(data.expires_at),
      strings(data.revocation_ids),
    );
  }
}

export type Outcome = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export class Decision {
  constructor(
    readonly outcome: Outcome,
    readonly reason: string,
    readonly decisionId: string,
    readonly resource: string,
    readonly timestamp: Date | null,
  ) {}

  get allowed(): boolean {
    return this.outcome === "ALLOW";
  }

  static fromJson(data: Json): Decision {
    return new Decision(
      str(data.outcome) as Outcome,
      str(data.reason),
      str(data.decision_id),
      str(data.resource),
      date(data.timestamp),
    );
  }
}

export class Approval {
  constructor(
    readonly requestId: string,
    readonly subject: string,
    readonly actor: string,
    readonly tool: string,
    readonly status: string,
    readonly createdAt: Date | null,
    readonly expiresAt: Date | null,
    readonly resolvedBy: string | null,
    readonly resolutionReason: string | null,
  ) {}

  static fromJson(data: Json): Approval {
    return new Approval(
      str(data.request_id),
      str(data.subject),
      str(data.actor),
      str(data.tool),
      str(data.status),
      date(data.created_at),
      date(data.expires_at),
      optional(data.resolved_by),
      optional(data.resolution_reason),
    );
  }
}

export class GateResult {
  constructor(
    readonly decision: Decision,
    readonly approval: Approval | null,
  ) {}

  get allowed(): boolean {
    return this.decision.allowed;
  }

  /** The call is parked: a human must resolve `approval.requestId` before `redeem`. */
  get pending(): boolean {
    return this.decision.outcome === "REQUIRE_APPROVAL" && this.approval !== null;
  }

  static fromJson(data: Json): GateResult {
    const approval = data.approval as Json | null | undefined;
    return new GateResult(
      Decision.fromJson(data.decision as Json),
      approval ? Approval.fromJson(approval) : null,
    );
  }
}

export interface FilterResult<T> {
  /** The items the subject may view, in the order they were given. */
  kept: T[];
  /** The references that were dropped; `"invalid"` for an item without a reference. */
  dropped: string[];
  strategy: string;
}

export class Memory {
  constructor(
    readonly memoryId: string,
    readonly content: string,
    readonly derivedFrom: string[],
    readonly writtenFor: string,
    readonly writtenBy: string,
    readonly createdAt: Date | null,
  ) {}

  static fromJson(data: Json): Memory {
    return new Memory(
      str(data.memory_id),
      str(data.content),
      strings(data.derived_from),
      str(data.written_for),
      str(data.written_by),
      date(data.created_at),
    );
  }
}

/** A standing authorization from a human to an agent (ADR 0016). */
export class Mandate {
  constructor(
    readonly mandateId: string,
    readonly subject: string,
    readonly agent: string,
    readonly scope: Scope,
    readonly status: string,
    readonly createdAt: Date | null,
    readonly expiresAt: Date | null,
    readonly maxTokenTtlMinutes: number,
    readonly createdBy: string,
    readonly revokedAt: Date | null,
    readonly revocationReason: string | null,
  ) {}

  get active(): boolean {
    return this.status === "active";
  }

  static fromJson(data: Json): Mandate {
    return new Mandate(
      str(data.mandate_id),
      str(data.subject),
      str(data.agent),
      (data.scope as Scope) ?? { capabilities: [] },
      str(data.status),
      date(data.created_at),
      date(data.expires_at),
      Number(data.max_token_ttl_minutes ?? 0),
      str(data.created_by),
      date(data.revoked_at),
      optional(data.revocation_reason),
    );
  }
}

/** Liveness answer of `GET /v1/health`. */
export interface Health {
  status: string;
  [key: string]: unknown;
}

/** Readiness answer of `GET /v1/ready` (ADR 0020). */
export interface Readiness {
  status: "ready" | "not_ready" | string;
  checks: Record<string, string>;
  [key: string]: unknown;
}
