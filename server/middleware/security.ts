import type { Request, RequestHandler } from "express";

const API_LIMITS: Record<string, number> = {
  "/api/satellite": 12,
  "/api/vicinity": 30,
  "/api/geocode": 60,
  "/api/elevation": 20,
  "/api/rainfall": 30,
};

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "tauri:"].includes(url.protocol)) return null;
    return url.origin === "null" && url.protocol === "tauri:" ? "tauri://localhost" : url.origin;
  } catch {
    return null;
  }
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const development = process.env.NODE_ENV !== "production";
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      // Drei's Troika text renderer uses a blob worker whose bootstrap loads
      // generated blob scripts with importScripts(). worker-src permits the
      // outer worker; script-src must separately permit those inner scripts.
      `script-src 'self' blob: 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      // Troika resolves fallback glyph fonts from its jsDelivr-hosted index.
      `connect-src 'self' https://cdn.jsdelivr.net${development ? " ws: wss:" : ""}`,
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "frame-ancestors 'self'",
    ].join("; "));
    next();
  };
}

export function corsAllowlist(): RequestHandler {
  const configured = new Set(
    (process.env.BESSFORGE_ALLOWED_ORIGINS ?? "")
      .split(",").map(x => normalizedOrigin(x.trim())).filter((x): x is string => !!x),
  );
  const desktopOrDevelopment = process.env.NODE_ENV !== "production" ||
    process.env.BESSFORGE_LOOPBACK_ONLY === "1";

  return (req, res, next) => {
    const raw = req.get("origin");
    if (!raw) return next();
    const origin = normalizedOrigin(raw);
    const host = req.get("host");
    const sameOrigin = !!origin && !!host &&
      (origin === `http://${host}` || origin === `https://${host}`);
    let local = false;
    if (origin && desktopOrDevelopment) {
      try {
        const parsed = new URL(origin);
        local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ||
          origin === "tauri://localhost" || origin === "http://tauri.localhost" ||
          origin === "https://tauri.localhost";
      } catch { /* rejected below */ }
    }
    const opaqueDesktop = raw === "null" && process.env.BESSFORGE_LOOPBACK_ONLY === "1";
    if ((!origin && !opaqueDesktop) || (origin && !configured.has(origin) && !sameOrigin && !local)) {
      res.status(403).json({ message: "Origin is not allowed" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", raw);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function clientKey(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}

export function apiRateLimit(): RequestHandler {
  const windowMs = 60_000;
  const maxClients = 4096;
  const clients = new Map<string, Map<string, { start: number; count: number }>>();
  return (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const route = Object.hasOwn(API_LIMITS, req.path) ? req.path : "/api/*";
    const limit = API_LIMITS[route] ?? 120;
    const key = clientKey(req);
    let routes = clients.get(key);
    if (!routes) {
      if (clients.size >= maxClients) clients.delete(clients.keys().next().value as string);
      routes = new Map();
      clients.set(key, routes);
    } else {
      clients.delete(key);
      clients.set(key, routes);
    }
    const now = Date.now();
    let bucket = routes.get(route);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      routes.set(route, bucket);
    }
    bucket.count++;
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - bucket.start)) / 1000)));
      res.status(429).json({ message: "Too many requests" });
      return;
    }
    next();
  };
}