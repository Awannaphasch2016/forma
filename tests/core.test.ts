import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
import { sameOrigin } from "../lib/http";
import {
  clerkPublishable,
  formaOwnerId,
  formaSession,
  sessionToken,
  verifyClerkJwt,
} from "../lib/sign-in";
import { sessionIdToReconcile } from "../lib/webhook";

function signedToken(sub: string, exp: number) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    kid?: string;
  };
  jwk.kid = "test";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString(
    "base64url",
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString("base64url");
  return { token: `${header}.${payload}.${signature}`, jwks: { keys: [jwk] } };
}

describe("demo security boundaries", () => {
  it("accepts one Clerk session and refuses a live publishable key", async () => {
    expect(clerkPublishable("pk_live_example").status).toBe(404);
    expect(clerkPublishable("pk_test_example").status).toBe(200);
    const good = signedToken("user_pm", Math.floor(Date.now() / 1000) + 60);
    await expect(verifyClerkJwt(good.token, good.jwks)).resolves.toEqual({
      userId: "user_pm",
    });
    const expired = signedToken("user_pm", Math.floor(Date.now() / 1000) - 10);
    await expect(verifyClerkJwt(expired.token, expired.jwks)).rejects.toThrow(
      /Sign in to continue/,
    );
    await expect(verifyClerkJwt("malformed", good.jwks)).rejects.toThrow(
      /Sign in to continue/,
    );
    expect(sessionToken("Bearer session-token", null)).toBe("session-token");
    expect(sessionToken(null, "__session=cookie-token")).toBe("cookie-token");
    const session = formaSession({
      userId: "user_pm",
      memberships: [{ org_id: "org_wewebplus", role_id: "project-manager" }],
      activeOrgIds: ["org_wewebplus"],
      orgNames: { org_wewebplus: "Wewebplus" },
    });
    expect(session).toEqual({
      signedIn: true,
      organization: "Wewebplus",
      role: "Project Manager",
      userId: "user_pm",
    });
    expect(formaOwnerId(session)).toBe("user_pm");
    expect(
      formaOwnerId(
        formaSession({
          userId: "user_pm",
          memberships: [
            { org_id: "org_wewebplus", role_id: "project-manager" },
            { org_id: "org_wewebplus", role_id: "developer" },
          ],
          activeOrgIds: ["org_wewebplus"],
        }),
      ),
    ).toBeNull();
  });
  it("rejects cross-origin and missing-origin mutations", () => {
    expect(() =>
      sameOrigin(
        new Request("https://studio.example/api/projects", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow();
    expect(() =>
      sameOrigin(new Request("https://studio.example/api/projects")),
    ).toThrow();
    expect(() =>
      sameOrigin(
        new Request("https://studio.example/api/projects", {
          headers: { origin: "https://studio.example" },
        }),
      ),
    ).not.toThrow();
  });
  it("allows the deployment host when APP_URL names another origin", () => {
    vi.stubEnv("APP_URL", "https://forma-preview.vercel.app");
    expect(() =>
      sameOrigin(
        new Request("https://forma-abc.vercel.app/api/auth", {
          headers: { origin: "https://forma-abc.vercel.app" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      sameOrigin(
        new Request("https://forma-abc.vercel.app/api/auth", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow();
    vi.unstubAllEnvs();
  });
  it("routes only executor connection and failure lifecycle webhooks", () => {
    expect(
      sessionIdToReconcile({
        type: "agent.session.action_required",
        data: {
          id: "session_1",
          required_action: { type: "environment_connection" },
        },
      }),
    ).toBe("session_1");
    expect(
      sessionIdToReconcile({
        type: "agent.session.action_required",
        data: { id: "session_1", required_action: { type: "approval" } },
      }),
    ).toBeNull();
    expect(
      sessionIdToReconcile({
        type: "agent.session.failed",
        data: { id: "session_1" },
      }),
    ).toBe("session_1");
    expect(sessionIdToReconcile({ type: "agent.session.failed" })).toBeNull();
  });
});
