import assert from "assert";

import { DEV_ORIGINS, isOriginAllowed, normalizeOrigin, readOriginPolicy } from "../src/origins.js";

describe("origins", () => {
  it("normalizes bare http(s) origins only", () => {
    assert.strictEqual(normalizeOrigin("https://Play.Example.com"), "https://play.example.com");
    assert.strictEqual(normalizeOrigin("https://play.example.com:443"), "https://play.example.com");
    assert.strictEqual(normalizeOrigin("http://localhost:5173"), "http://localhost:5173");
    for (const bad of [
      "",
      "null",
      "play.example.com",
      "https://play.example.com/",
      "https://play.example.com/game",
      "https://play.example.com?x=1",
      "https://user:pw@play.example.com",
      "ftp://play.example.com",
      "javascript:alert(1)",
    ]) {
      assert.strictEqual(normalizeOrigin(bad), null, bad);
    }
  });

  it("allows the Vite origins outside production", () => {
    const policy = readOriginPolicy({});
    assert.deepStrictEqual([...policy.allowed], DEV_ORIGINS);
  });

  it("allows no browser origin in production unless configured", () => {
    const policy = readOriginPolicy({ NODE_ENV: "production" });
    assert.strictEqual(policy.allowed.size, 0);
    assert.strictEqual(isOriginAllowed("http://localhost:5173", policy), false);
  });

  it("reads ALLOWED_ORIGINS exactly and reports invalid entries", () => {
    const policy = readOriginPolicy({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: " https://play.example.com , https://*.example.com,https://play.example.com/,,",
    });
    assert.deepStrictEqual([...policy.allowed], ["https://play.example.com"]);
    assert.deepStrictEqual(policy.rejected, ["https://*.example.com", "https://play.example.com/"]);
  });

  it("matches exact origins, not look-alikes", () => {
    const policy = readOriginPolicy({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://play.example.com" });
    assert.strictEqual(isOriginAllowed("https://play.example.com", policy), true);
    assert.strictEqual(isOriginAllowed("https://PLAY.example.com", policy), true);
    assert.strictEqual(isOriginAllowed("http://play.example.com", policy), false);
    assert.strictEqual(isOriginAllowed("https://play.example.com.evil.example", policy), false);
    assert.strictEqual(isOriginAllowed("https://evilplay.example.com", policy), false);
    assert.strictEqual(isOriginAllowed("null", policy), false);
  });

  it("allows a listed Vercel preview exactly, and none of its look-alikes", () => {
    // Placeholder names: a real list holds this project's own preview URLs.
    const branch = "https://myapp-git-feat-colyseus-myteam.vercel.app";
    const policy = readOriginPolicy({ NODE_ENV: "production", ALLOWED_ORIGINS: `https://myapp.vercel.app,${branch}` });
    assert.strictEqual(isOriginAllowed(branch, policy), true);
    assert.strictEqual(isOriginAllowed("https://myapp.vercel.app", policy), true);
    for (const other of [
      "https://myapp-git-main-myteam.vercel.app", // another branch: list it to allow it
      "https://myapp-abc123-myteam.vercel.app", // a per-deployment URL
      "https://myapp-git-feat-colyseus-myteam.vercel.app.evil.example",
      "https://evil-myapp-git-feat-colyseus-myteam.vercel.app",
      "http://myapp-git-feat-colyseus-myteam.vercel.app",
    ]) {
      assert.strictEqual(isOriginAllowed(other, policy), false, other);
    }
    // patterns are not a feature: they are reported, never stored
    const patterned = readOriginPolicy({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://*.vercel.app,https://myapp-*.vercel.app" });
    assert.strictEqual(patterned.allowed.size, 0);
    assert.deepStrictEqual(patterned.rejected, ["https://*.vercel.app", "https://myapp-*.vercel.app"]);
  });

  it("lets requests without an Origin through (not a browser; origin is not auth)", () => {
    const policy = readOriginPolicy({ NODE_ENV: "production" });
    assert.strictEqual(isOriginAllowed(undefined, policy), true);
    assert.strictEqual(isOriginAllowed(null, policy), true);
    assert.strictEqual(isOriginAllowed("", policy), true);
  });
});
