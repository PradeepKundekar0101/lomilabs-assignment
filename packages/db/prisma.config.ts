import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `generate` and `migrate diff` need no database, so allow an unset URL there.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
