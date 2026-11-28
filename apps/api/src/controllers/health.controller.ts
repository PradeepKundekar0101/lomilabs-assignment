import type { Request, Response } from "express";
import type { AppDeps } from "../types/app.js";

export function healthController({ checks }: Pick<AppDeps, "checks">) {
  return {
    /** 200 whenever the process answers: the load balancer's check, so a Postgres or Redis outage does not get the api replaced. */
    live(_req: Request, res: Response) {
      res.json({ status: "ok" });
    },
    /** 200 with the version and queue counts when Postgres and Redis are up; 503, with null counts for the one that is down. */
    async check(_req: Request, res: Response) {
      const [db, redis] = await Promise.allSettled([checks.db(), checks.redis()]);
      for (const [name, r] of Object.entries({ db, redis })) {
        if (r.status === "rejected") console.error(`health: ${name} check failed`, r.reason);
      }
      const up = db.status === "fulfilled" && redis.status === "fulfilled";
      res.status(up ? 200 : 503).json({
        db: db.status === "fulfilled" ? "ok" : "error",
        redis: redis.status === "fulfilled" ? "ok" : "error",
        versions: db.status === "fulfilled" ? db.value : null,
        queue: redis.status === "fulfilled" ? redis.value : null,
      });
    },
  };
}
