import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { apiRateLimit, corsAllowlist, securityHeaders } from "./middleware/security";

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders());
app.use(corsAllowlist());
app.use(apiRateLimit());
app.use(express.json({ limit: "64kb", strict: true }));
app.use(express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 100 }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const candidate = Number(err?.status || err?.statusCode);
    const status = candidate >= 400 && candidate < 500 ? candidate : 500;
    const message = status === 413 ? "Request body is too large" :
      status === 400 ? "Invalid request body" : "Internal Server Error";
    if (!res.headersSent) res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Hosted development/production remains on :5000 unless PORT is set.
  // The audited desktop/static companion proxy defaults to loopback :53117.
  const loopbackOnly = process.env.BESSFORGE_LOOPBACK_ONLY === "1";
  const port = parseInt(process.env.PORT || (loopbackOnly ? "53117" : "5000"), 10);
  const host = loopbackOnly ? "127.0.0.1" : "0.0.0.0";
  // SO_REUSEPORT is unsupported on Windows (ENOTSUP); keep it on POSIX only.
  const listenOptions: { port: number; host: string; reusePort?: boolean } = { port, host };
  if (process.platform !== "win32") listenOptions.reusePort = true;
  server.listen(listenOptions, () => {
    log(`serving on ${host}:${port}`);
  });
})();
