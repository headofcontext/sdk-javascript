/** @headofcontext/client: thin client for the HeadOfContext service. */

export {
  ClientCredentials,
  type ClientCredentialsOptions,
  type Fetch,
  KeycloakClientCredentials,
  type KeycloakClientCredentialsOptions,
  StaticToken,
  type TokenProvider,
} from "./auth.js";
export {
  defaultIdOf,
  type FilterOptions,
  HeadOfContext,
  type HeadOfContextOptions,
  Session,
  type ToolArgs,
} from "./client.js";
export {
  Forbidden,
  HeadOfContextError,
  InvalidRequest,
  Unauthorized,
  Unavailable,
} from "./errors.js";
export { fingerprint } from "./fingerprint.js";
export {
  ActionDenied,
  ApprovalPending,
  type OnDeny,
  refusalMessage,
  ToolGuard,
  type ToolGuardOptions,
} from "./guard.js";
export {
  Approval,
  type Capability,
  Chain,
  Decision,
  type FilterResult,
  GateResult,
  type Health,
  Inspection,
  IssuedToken,
  type Json,
  Mandate,
  Memory,
  type Outcome,
  type Readiness,
  type Scope,
  scope,
} from "./models.js";

export const VERSION = "0.0.0"; // x-release-please-version
