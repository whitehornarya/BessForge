import assert from "node:assert/strict";
import express from "express";
import { registerRoutes } from "../server/routes";
import { apiRateLimit, corsAllowlist, securityHeaders } from "../server/middleware/security";

const originalFetch = globalThis.fetch;
const seen: string[] = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  seen.push(url);
  if (url.includes("TIGERweb")) {
    return new Response(JSON.stringify({
      features: [{ attributes: { BASENAME: "Test" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`credential leak: ${url}`);
};

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders(), corsAllowlist(), apiRateLimit());
const server = await registerRoutes(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

try {
  const health = await originalFetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await health.json() as { version: string }).version, "1.0.1");

  const before = seen.length;
  const invalid = await originalFetch(`${base}/api/geocode?lat=1e2&lon=-100`);
  assert.equal(invalid.status, 400);
  assert.equal(seen.length, before, "invalid input must not reach an upstream");

  const geocode = await originalFetch(`${base}/api/geocode?lat=40&lon=-100&url=https://evil.example`);
  assert.equal(geocode.status, 200);
  assert.equal(seen.length, before + 3);
  assert(seen.slice(-3).every(url => new URL(url).hostname === "tigerweb.geo.census.gov"));

  const blockedCors = await originalFetch(`${base}/api/status`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(blockedCors.status, 403);
  assert.equal(blockedCors.headers.get("access-control-allow-origin"), null);

  delete process.env.CESIUM_ION_TOKEN;
  const satellite = await originalFetch(`${base}/api/satellite?lat=40&lon=-100`);
  assert.equal(satellite.status, 502);
  const body = JSON.stringify(await satellite.json());
  assert(!body.includes("CESIUM_ION_TOKEN"), "configuration and credential details must be sanitized");
  assert(!body.includes("access_token"), "upstream query credentials must not appear in client errors");
  assert(!body.includes("eyJ"), "JWT fragments must not appear in client errors");
  assert(
    seen.some(url => url.includes("api.cesium.com")),
    "bundled Cesium token should authorize the ion imagery request"
  );
  console.log("proxy-hardening: all assertions passed");
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}