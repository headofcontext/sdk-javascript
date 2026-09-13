/** ToolGuard: wrap tool functions so every call is authorized by the service first. */

import type { Session, ToolArgs } from "./client.js";
import { HeadOfContextError } from "./errors.js";
import type { GateResult } from "./models.js";

export type OnDeny = "throw" | "message";

export class ActionDenied extends HeadOfContextError {}

export class ApprovalPending extends HeadOfContextError {
  readonly requestId: string;
  readonly tool: string;

  constructor(requestId: string, tool: string) {
    super("approval_required", `tool '${tool}' requires approval (request ${requestId})`);
    this.requestId = requestId;
    this.tool = tool;
  }
}

export interface ToolGuardOptions {
  /** `"message"` (default) returns the refusal text in place of the tool output; `"throw"` throws. */
  onDeny?: OnDeny;
  /** Framework tool name to tool resource; `tool:` is added when missing. */
  toolMap?: Record<string, string>;
}

/** What the model reads instead of the tool output. Same wording as every other integration. */
export function refusalMessage(name: string, error: ActionDenied | ApprovalPending): string {
  if (error instanceof ApprovalPending) {
    return `HeadOfContext: tool '${name}' requires approval (request ${error.requestId}). Do not retry until it is approved.`;
  }
  return `HeadOfContext denied tool '${name}': ${error.reason}. Do not retry.`;
}

export class ToolGuard {
  readonly #session: Session;
  readonly #onDeny: OnDeny;
  readonly #toolMap: Record<string, string>;

  constructor(session: Session, options: ToolGuardOptions = {}) {
    this.#session = session;
    this.#onDeny = options.onDeny ?? "message";
    this.#toolMap = { ...(options.toolMap ?? {}) };
  }

  resourceFor(name: string): string {
    const resource = this.#toolMap[name] ?? name;
    return resource.startsWith("tool:") ? resource : `tool:${resource}`;
  }

  /** Throws ActionDenied / ApprovalPending unless the call is allowed. */
  async authorize(name: string, args: ToolArgs): Promise<GateResult> {
    const result = await this.#session.gate(this.resourceFor(name), args);
    if (result.allowed) return result;
    if (result.pending && result.approval !== null) {
      throw new ApprovalPending(result.approval.requestId, name);
    }
    throw new ActionDenied(result.decision.reason, `tool '${name}' denied`);
  }

  /**
   * Wrap a tool taking one arguments object. The gate sees exactly that object, so the audit
   * hash and any argument policy match what the tool runs with.
   */
  wrap<A extends ToolArgs, R>(
    name: string,
    fn: (args: A) => R | Promise<R>,
  ): (args: A) => Promise<R | string> {
    return async (args: A) => {
      try {
        await this.authorize(name, args);
      } catch (error) {
        if (error instanceof ActionDenied || error instanceof ApprovalPending) {
          if (this.#onDeny === "throw") throw error;
          return refusalMessage(name, error);
        }
        throw error;
      }
      return fn(args);
    };
  }
}
