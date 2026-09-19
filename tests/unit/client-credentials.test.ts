// ClientCredentials posts to the endpoint it is given; the Keycloak flavour derives it.
import { describe, expect, it } from "vitest";
import { ClientCredentials, KeycloakClientCredentials, Unauthorized } from "../../src/index.js";

function issuer(seen: { url: string; body: string }[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    seen.push({ url: String(input), body });
    if (!body.includes("client_secret=s3cret"))
      return Response.json({ error: "invalid_client" }, { status: 401 });
    return Response.json({ access_token: "tok-1", expires_in: 3600 });
  }) as typeof fetch;
}

describe("ClientCredentials", () => {
  it("posts to the given endpoint and caches the token", async () => {
    const seen: { url: string; body: string }[] = [];
    const provider = new ClientCredentials({
      tokenUrl: "https://cloud.example/oauth/token",
      clientId: "a",
      clientSecret: "s3cret",
      fetch: issuer(seen),
    });
    expect(await provider.token()).toBe("tok-1");
    expect(seen[0]!.url).toBe("https://cloud.example/oauth/token");
    expect(seen[0]!.body).toContain("grant_type=client_credentials");
    expect(await provider.token()).toBe("tok-1");
    expect(seen).toHaveLength(1);
  });

  it("rejects a relative endpoint and a bad secret", async () => {
    expect(
      () => new ClientCredentials({ tokenUrl: "/oauth/token", clientId: "a", clientSecret: "b" }),
    ).toThrow(TypeError);
    const provider = new ClientCredentials({
      tokenUrl: "https://cloud.example/oauth/token",
      clientId: "a",
      clientSecret: "wrong",
      fetch: issuer([]),
    });
    await expect(provider.token()).rejects.toBeInstanceOf(Unauthorized);
  });
});

describe("KeycloakClientCredentials", () => {
  it("derives the endpoint from the issuer", async () => {
    const seen: { url: string; body: string }[] = [];
    const provider = new KeycloakClientCredentials({
      issuer: "https://kc.example/realms/acme/",
      clientId: "a",
      clientSecret: "s3cret",
      fetch: issuer(seen),
    });
    expect(provider.tokenUrl).toBe("https://kc.example/realms/acme/protocol/openid-connect/token");
    await provider.token();
    expect(seen[0]!.url).toBe(provider.tokenUrl);
  });
});
