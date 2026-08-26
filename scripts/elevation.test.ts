/**
 * Route-level regression tests for GET /api/elevation (server/routes.ts).
 *
 * The route proxies the USGS 3DEP ImageServer; a regression there silently
 * degrades the app to "flat ground shown". These tests boot the real express
 * routes with the upstream fetch MOCKED (never hits the live USGS service)
 * and assert:
 *   - success: valid GeoTIFF fixture -> feet conversion, rounding, no-data
 *     cells -> null, response shape, in-memory caching
 *   - rejection paths: non-TIFF error body, upstream HTTP error, timeout,
 *     all-no-data coverage gap, out-of-range / inverted / oversized bbox
 * with explicit error messages (never a silent empty grid).
 */
import express from "express";
import { writeArrayBuffer } from "geotiff";
import { registerRoutes } from "../server/routes";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
function check(cond: boolean, label: string) {
  if (!cond) fail(label);
  passed++;
}

const realFetch = globalThis.fetch;
let mockFetch: ((url: string) => Promise<Response>) | null = null;
let upstreamCalls = 0;

// The route calls global fetch at request time; intercept only the USGS URL
// so nothing in these tests can reach the live service.
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.includes("elevation.nationalmap.gov")) {
    upstreamCalls++;
    if (!mockFetch) fail("upstream fetch called with no mock installed");
    return mockFetch!(url);
  }
  return realFetch(input, init);
}) as typeof fetch;

async function makeTiff(valuesM: number[], width: number, height: number): Promise<ArrayBuffer> {
  return (await writeArrayBuffer(new Float32Array(valuesM) as any, {
    height,
    width,
    BitsPerSample: [32],
    SampleFormat: [3],
  })) as ArrayBuffer;
}

function tiffResponse(buf: ArrayBuffer, contentType = "image/tiff", status = 200) {
  return new Response(buf, { status, headers: { "content-type": contentType } });
}

async function main() {
  const app = express();
  const server = await registerRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") fail("no listen address");
  const base = `http://127.0.0.1:${address.port}/api/elevation`;

  const bbox = (west: number, span = 0.01) =>
    `west=${west}&east=${west + span}&south=40&north=${40 + span}&size=16`;

  async function get(qs: string): Promise<{ status: number; body: any }> {
    const res = await realFetch(`${base}?${qs}`);
    return { status: res.status, body: await res.json() };
  }

  // ---- [1] success: valid GeoTIFF -> feet grid with no-data -> null --------
  {
    const w = 4, h = 4;
    const valuesM = Array.from({ length: w * h }, (_, i) => 100 + i * 0.5);
    valuesM[5] = -3.4028235e38; // 3DEP float-extreme no-data
    valuesM[10] = 20000;        // above plausible Earth elevation
    mockFetch = async () => tiffResponse(await makeTiff(valuesM, w, h));
    const { status, body } = await get(bbox(-100));
    check(status === 200, `[1] expected 200, got ${status}: ${JSON.stringify(body)}`);
    check(body.width === w && body.height === h, "[1] width/height echo the raster");
    check(Array.isArray(body.valuesFt) && body.valuesFt.length === w * h, "[1] valuesFt is a full grid");
    check(body.valuesFt[0] === 328.08, `[1] 100 m -> 328.08 ft (2-dp rounding), got ${body.valuesFt[0]}`);
    check(body.valuesFt[15] === Math.round(107.5 * 3.28084 * 100) / 100, "[1] last cell converted");
    check(body.valuesFt[5] === null && body.valuesFt[10] === null, "[1] no-data cells are null, never faked");
    check(body.bounds.west === -100 && body.bounds.north === 40.01, "[1] bounds echo the request");
    check(typeof body.source === "string" && body.source.includes("3DEP"), "[1] source attribution present");
    check(typeof body.resolutionM === "number" && body.resolutionM > 0, "[1] resolutionM present");
  }

  // ---- [2] cache: identical request never re-hits upstream -----------------
  {
    const before = upstreamCalls;
    mockFetch = async () => fail("[2] cache miss: upstream re-fetched for identical bbox");
    const { status, body } = await get(bbox(-100));
    check(status === 200 && body.valuesFt[0] === 328.08, "[2] cached payload served");
    check(upstreamCalls === before, "[2] no upstream call on cache hit");
  }

  // ---- [3] non-TIFF error body (HTML with 200) -> explicit 502 -------------
  {
    mockFetch = async () =>
      new Response("<html>Service Error</html>", { status: 200, headers: { "content-type": "text/html" } });
    const { status, body } = await get(bbox(-101));
    check(status === 502, `[3] expected 502 for HTML body, got ${status}`);
    check(/USGS 3DEP.*unavailable/.test(body.message), `[3] explicit message, got "${body.message}"`);
  }

  // ---- [4] upstream HTTP failure -> sanitized explicit 502 -----------------
  {
    mockFetch = async () =>
      new Response("oops", { status: 503, headers: { "content-type": "image/tiff" } });
    const { status, body } = await get(bbox(-102));
    check(status === 502 && /USGS 3DEP.*unavailable/.test(body.message) && !body.message.includes("503"),
      `[4] sanitized 502, got ${status} "${body.message}"`);
  }

  // ---- [5] timeout -> same sanitized public 502 -----------------------------
  {
    mockFetch = async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    };
    const { status, body } = await get(bbox(-103));
    check(status === 502, `[5] expected 502 on timeout, got ${status}`);
    check(/unavailable/.test(body.message) && !body.message.includes("aborted"),
      `[5] sanitized timeout message, got "${body.message}"`);
  }

  // ---- [6] garbage body that claims to be TIFF -> 502 (parser rejects) -----
  {
    mockFetch = async () => tiffResponse(new TextEncoder().encode("not a tiff at all").buffer as ArrayBuffer);
    const { status, body } = await get(bbox(-104));
    check(status === 502 && typeof body.message === "string" && body.message.length > 0,
      `[6] corrupt TIFF -> explicit 502, got ${status}`);
  }

  // ---- [7] all-no-data coverage gap -> explicit 502 -------------------------
  {
    mockFetch = async () => tiffResponse(await makeTiff(new Array(16).fill(-3.4028235e38), 4, 4));
    const { status, body } = await get(bbox(-105));
    check(status === 502, `[7] expected 502 for full no-data, got ${status}`);
    check(body.message.includes("outside USGS 3DEP coverage"), `[7] coverage message, got "${body.message}"`);
  }

  // ---- [8] bbox validation -> 400, upstream never contacted -----------------
  {
    const before = upstreamCalls;
    mockFetch = async () => fail("[8] upstream contacted for invalid bbox");
    const badQueries: Array<[string, string]> = [
      ["missing params", "west=-100"],
      ["non-numeric", "west=abc&east=-99&south=40&north=41"],
      ["inverted west/east", "west=-99&east=-100&south=40&north=41"],
      ["inverted south/north", "west=-100&east=-99&south=41&north=40"],
      ["latitude out of range", "west=-100&east=-99&south=86&north=87"],
      ["longitude out of range", "west=181&east=182&south=40&north=41"],
      ["oversized lon span", "west=-100&east=-97&south=40&north=40.5"],
      ["oversized lat span", "west=-100&east=-99.5&south=40&north=43"],
    ];
    for (const [label, qs] of badQueries) {
      const { status, body } = await get(qs);
      check(status === 400, `[8] ${label}: expected 400, got ${status}`);
      check(typeof body.message === "string" && /(?:must be|bbox|WGS84)/.test(body.message),
        `[8] ${label}: explicit validation message`);
    }
    check(upstreamCalls === before, "[8] invalid bboxes never reach upstream");
  }

  console.log(`PASS: /api/elevation route tests (${passed} checks)`);
  server.close();
  process.exit(0);
}

main().catch((e) => fail(`unexpected error: ${e?.stack || e}`));
