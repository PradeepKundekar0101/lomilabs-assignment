import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { createVersion } from "./create-version.js";
import { createServices } from "./services.js";

const port = Number(process.env.PORT ?? 3000);
const { db, queue, versionDeps, redisUrl } = createServices();

// No offline queue: a PING while Redis is down fails at once instead of hanging the health check.
const redis = new Redis(redisUrl, { enableOfflineQueue: false, connectTimeout: 2000 });
redis.on("error", (err: NodeJS.ErrnoException) => console.error("redis error", err.code ?? err.message));

const server = createApp({
  checks: {
    db: () => db.$queryRaw`SELECT 1`,
    redis: () => redis.ping(),
  },
  db,
  createVersion: (target, file) => createVersion(versionDeps, target, file),
}).listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close();
  void db.$disconnect();
  void queue.close();
  redis.disconnect();
});
