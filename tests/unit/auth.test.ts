import { describe, expect, it } from "vitest";

import { KeycloakClientCredentials, Unauthorized } from "../../src/index.js";

describe("KeycloakClientCredentials", () => {
  it("posts client credentials and caches the token", async () => {
    let calls = 0;
    const provider = new KeycloakClientCredentials({
      issuer: "http://kc/realms/acme/",
      clientId: "assistant",
      clientSecret: "s",
      fetch: async (input, init) => {
        calls += 1;
        expect(String(input)).toBe("http://kc/realms/acme/protocol/openid-connect/token");
        const body = String(init?.body);
        expect(body).toContain("grant_type=client_credentials");
        expect(body).toContain("client_id=assistant");
        return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 300 }), {
          status: 200,
        });
      },
    });
    expect(await provider.token()).toBe("tok-1");
    expect(await provider.token()).toBe("tok-1");
    expect(calls).toBe(1);
  });

  it("refreshes an expired token", async () => {
    let calls = 0;
    const provider = new KeycloakClientCredentials({
      issuer: "http://kc/realms/acme",
      clientId: "a",
      clientSecret: "s",
      refreshMarginSeconds: 0,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 0 }), {
          status: 200,
        });
      },
    });
    expect(await provider.token()).toBe("tok-1");
    expect(await provider.token()).toBe("tok-2");
  });

  it("an issuer refusal is Unauthorized, without the secret in the message", async () => {
    const provider = new KeycloakClientCredentials({
      issuer: "http://kc/realms/acme",
      clientId: "a",
      clientSecret: "very-secret",
      fetch: async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
    });
    const thrown = (await provider.token().catch((e: unknown) => e)) as Error;
    expect(thrown).toBeInstanceOf(Unauthorized);
    expect(thrown.message).not.toContain("very-secret");
  });

  it("a missing access token is Unauthorized", async () => {
    const provider = new KeycloakClientCredentials({
      issuer: "http://kc/realms/acme",
      clientId: "a",
      clientSecret: "s",
      fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    await expect(provider.token()).rejects.toBeInstanceOf(Unauthorized);
  });

  it("a network failure is Unauthorized", async () => {
    const provider = new KeycloakClientCredentials({
      issuer: "http://kc/realms/acme",
      clientId: "a",
      clientSecret: "s",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(provider.token()).rejects.toBeInstanceOf(Unauthorized);
  });
});
