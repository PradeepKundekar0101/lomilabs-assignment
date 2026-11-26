import { Worker } from "bullmq";
import { Redis } from "ioredis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");

// BullMQ workers need maxRetriesPerRequest: null so blocking commands survive reconnects.
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker(
  "extraction",
  async (job) => {
    console.log(`extraction job ${job.id}`);
  },
  { connection },
);

worker.on("ready", () => console.log("worker ready"));
worker.on("error", (err: NodeJS.ErrnoException) => console.error("worker error", err.code ?? err.message));

process.on("SIGTERM", () => void worker.close().then(() => connection.quit()));
