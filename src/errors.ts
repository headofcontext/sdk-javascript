/** Errors. The reason codes mirror the service's `reason` field. */

export class HeadOfContextError extends Error {
  readonly reason: string;
  readonly detail: string;
  readonly status: number;

  constructor(reason: string, detail = "", status = 0) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = new.target.name;
    this.reason = reason;
    this.detail = detail;
    this.status = status;
  }
}

/** The bearer token was missing or invalid (HTTP 401). */
export class Unauthorized extends HeadOfContextError {}

/** A token, caller or invariant problem (HTTP 403). Decisions never raise this. */
export class Forbidden extends HeadOfContextError {}

/** The service could not decide: engine, journal or connector unavailable (HTTP 503). */
export class Unavailable extends HeadOfContextError {}

/** The request did not match the contract (HTTP 422). */
export class InvalidRequest extends HeadOfContextError {}
