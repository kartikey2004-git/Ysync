import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  isPostgresReachable,
  startAuthServer,
  createTestUser,
  signIn,
  authenticatedFetch,
  uniqueEmail,
  type TestServerContext,
} from "./helpers/authTestHelpers.js";

const postgresAvailable = await isPostgresReachable();

describe.skipIf(!postgresAvailable)("Authentication integration (requires live Postgres)", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await startAuthServer();
  });

  afterAll(async () => {
    await ctx?.cleanup();
  });

  test("unauthenticated request to /api/documents returns 401", async () => {
    const res = await fetch(`${ctx.httpUrl}/api/documents`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHENTICATED");
  });

  test("sign-up creates a user and returns a session cookie", async () => {
    const email = uniqueEmail();
    const cookie = await createTestUser(ctx.httpUrl, email, "Test1234!!", "Test User");
    expect(cookie).toContain("ysync.session_token=");
  });

  test("sign-in returns a session cookie for an existing user", async () => {
    const email = uniqueEmail();
    const password = "Test1234!!";
    await createTestUser(ctx.httpUrl, email, password, "Sign In Test");

    const cookie = await signIn(ctx.httpUrl, email, password);
    expect(cookie).toContain("ysync.session_token=");
  });

  test("session cookie authenticates subsequent requests", async () => {
    const email = uniqueEmail();
    const cookie = await createTestUser(ctx.httpUrl, email, "Test1234!!", "Cookie Test");

    const res = await authenticatedFetch(ctx.httpUrl, "/api/documents", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("invalid session cookie is rejected", async () => {
    const res = await authenticatedFetch(
      ctx.httpUrl,
      "/api/documents",
      "ysync.session_token=completely-bogus-value",
    );
    expect(res.status).toBe(401);
  });

  test("tampered session cookie is rejected", async () => {
    const email = uniqueEmail();
    const cookie = await createTestUser(ctx.httpUrl, email, "Test1234!!", "Tamper Test");
    const tampered = cookie.replace(/=(.{4})/, "=XXXX");

    const res = await authenticatedFetch(ctx.httpUrl, "/api/documents", tampered);
    expect(res.status).toBe(401);
  });

  test("GET /api/auth/get-session returns user info for authenticated user", async () => {
    const email = uniqueEmail();
    const cookie = await createTestUser(ctx.httpUrl, email, "Test1234!!", "Session Info");

    const res = await authenticatedFetch(ctx.httpUrl, "/api/auth/get-session", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string; name: string } };
    expect(body.user.email).toBe(email);
    expect(body.user.name).toBe("Session Info");
  });

  test("GET /api/auth/get-session returns null/401 for unauthenticated request", async () => {
    const res = await fetch(`${ctx.httpUrl}/api/auth/get-session`);
    // Better Auth returns 200 with null body or 401 depending on version
    const body = await res.json();
    if (res.status === 200) {
      expect(body).toBeNull();
    } else {
      expect(res.status).toBe(401);
    }
  });
});
