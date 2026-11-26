import express, { type Express } from "express";

export interface HealthChecks {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export function createApp(checks: HealthChecks): Express {
  const app = express();

  app.get("/health", async (_req, res) => {
    const [db, redis] = await Promise.allSettled([checks.db(), checks.redis()]);
    const body = {
      db: db.status === "fulfilled" ? "ok" : "error",
      redis: redis.status === "fulfilled" ? "ok" : "error",
    };
    for (const [name, r] of Object.entries({ db, redis })) {
      if (r.status === "rejected") console.error(`health: ${name} check failed`, r.reason);
    }
    res.status(body.db === "ok" && body.redis === "ok" ? 200 : 503).json(body);
  });

  return app;
}
