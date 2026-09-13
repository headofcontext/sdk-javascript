/** Bearer token providers for the agent (client credentials) and for humans (their own token). */

import { Unauthorized } from "./errors.js";

export type Fetch = typeof globalThis.fetch;

export interface TokenProvider {
  token(): Promise<string>;
}

export class StaticToken implements TokenProvider {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  token(): Promise<string> {
    return Promise.resolve(this.#token);
  }
}

export interface KeycloakClientCredentialsOptions {
  /** The OIDC issuer, e.g. `https://keycloak.example.com/realms/acme`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Override the global `fetch` (tests, custom agents). */
  fetch?: Fetch;
  timeoutMs?: number;
  /** Refresh this many seconds before the cached token expires. */
  refreshMarginSeconds?: number;
}

/** OAuth 2.0 client credentials against an OIDC issuer; caches the token until near expiry. */
export class KeycloakClientCredentials implements TokenProvider {
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #marginMs: number;
  #cached: { token: string; expiresAt: number } | null = null;

  constructor(options: KeycloakClientCredentialsOptions) {
    this.#issuer = options.issuer.replace(/\/+$/, "");
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#marginMs = (options.refreshMarginSeconds ?? 30) * 1000;
  }

  async token(): Promise<string> {
    if (this.#cached && this.#cached.expiresAt - this.#marginMs > Date.now()) {
      return this.#cached.token;
    }
    let body: unknown;
    try {
      const response = await this.#fetch(`${this.#issuer}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        throw new Unauthorized("client_credentials_failed", `issuer answered ${response.status}`);
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof Unauthorized) throw error;
      throw new Unauthorized("client_credentials_failed", "could not obtain an agent token");
    }
    const token = (body as { access_token?: unknown }).access_token;
    if (typeof token !== "string" || token === "") {
      throw new Unauthorized("client_credentials_failed", "issuer returned no access token");
    }
    const expiresIn = Number((body as { expires_in?: unknown }).expires_in ?? 300);
    this.#cached = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }
}
