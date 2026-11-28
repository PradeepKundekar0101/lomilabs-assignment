import type { z } from "zod";
import type { WorkerEnvSchema } from "../schemas/env.schema.js";

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;
