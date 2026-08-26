import express, { type NextFunction, type Request, type Response } from "express";
import { registerRoutes } from "./routes";
import { apiRateLimit, corsAllowlist, securityHeaders } from "./middleware/security";

process.env.NODE_ENV = "production";
process.env.BESSFORGE_LOOPBACK_ONLY = "1";

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders());
app.use(corsAllowlist());
app.use(apiRateLimit());
app.use(express.json({ limit: "64kb", strict: true }));
app.use(express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 100 }));

(async () => {
  const server = await registerRoutes(app);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const candidate = Number((err as { status?: unknown; statusCode?: unknown })?.status ??
      (err as { statusCode?: unknown })?.statusCode);
    const status = candidate >= 400 && candidate < 500 ? candidate : 500;
    const message = status === 413 ? "Request body is too large" :
      status === 400 ? "Invalid request body" : "Internal Server Error";
    if (!res.headersSent) res.status(status).json({ message });
  });

  const configuredPort = Number.parseInt(process.env.PORT ?? "53117", 10);
  const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
    ? configuredPort : 53117;
  server.once("error", error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  server.listen({ host: "127.0.0.1", port }, () => {
    const address = server.address();
    const actualPort = address && typeof address !== "string" ? address.port : port;
    console.log(`BESSForge local API ready on 127.0.0.1:${actualPort}`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
})().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});