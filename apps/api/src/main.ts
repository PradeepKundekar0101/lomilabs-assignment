import { Redis } from "ioredis";
import pg from "pg";
import { createApp } from "./app.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const redisUrl = requireEnv("REDIS_URL");
const port = Number(process.env.PORT ?? 3000);

const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
pool.on("error", (err) => console.error("postgres pool error", err));

// No offline queue: a PING while Redis is down fails at once instead of hanging the health check.
const redis = new Redis(redisUrl, { enableOfflineQueue: false, connectTimeout: 2000 });
redis.on("error", (err: NodeJS.ErrnoException) => console.error("redis error", err.code ?? err.message));

const server = createApp({
  db: () => pool.query("SELECT 1"),
  redis: () => redis.ping(),
}).listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close();
  void pool.end();
  redis.disconnect();
});
