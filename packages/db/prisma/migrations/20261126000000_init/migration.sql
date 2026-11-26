-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('invoice', 'lease', 'report');

-- CreateEnum
CREATE TYPE "version_status" AS ENUM ('queued', 'extracting', 'extracted', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "run_outcome" AS ENUM ('succeeded', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('pending', 'approved', 'corrected', 'carried_over');

-- CreateEnum
CREATE TYPE "review_action" AS ENUM ('approve', 'correct');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "document_type" NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_version_id" UUID,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "pdf" BYTEA NOT NULL,
    "parsed_text" TEXT,
    "status" "version_status" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "raw_response" TEXT,
    "outcome" "run_outcome",
    "error" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_values" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version_id" UUID NOT NULL,
    "field_key" TEXT NOT NULL,
    "value" TEXT,
    "evidence" TEXT,
    "evidence_start" INTEGER,
    "evidence_end" INTEGER,
    "gap_reason" TEXT,
    "review_status" "review_status" NOT NULL DEFAULT 'pending',
    "previous_value_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extracted_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "value_id" UUID NOT NULL,
    "action" "review_action" NOT NULL,
    "corrected_value" TEXT,
    "note" TEXT,
    "carried_from_review_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_current_version_id_key" ON "documents"("current_version_id");

-- CreateIndex
CREATE INDEX "document_versions_status_lease_until_idx" ON "document_versions"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "extraction_runs_version_id_idx" ON "extraction_runs"("version_id");

-- CreateIndex
CREATE INDEX "extracted_values_previous_value_id_idx" ON "extracted_values"("previous_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_values_version_id_field_key_key" ON "extracted_values"("version_id", "field_key");

-- CreateIndex
CREATE INDEX "reviews_value_id_idx" ON "reviews"("value_id");

-- CreateIndex
CREATE INDEX "reviews_carried_from_review_id_idx" ON "reviews"("carried_from_review_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_previous_value_id_fkey" FOREIGN KEY ("previous_value_id") REFERENCES "extracted_values"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_id_fkey" FOREIGN KEY ("value_id") REFERENCES "extracted_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_carried_from_review_id_fkey" FOREIGN KEY ("carried_from_review_id") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Prisma cannot express CHECK constraints; a gap reason is only allowed when no value was found.
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_value_or_gap_reason" CHECK ("value" IS NULL OR "gap_reason" IS NULL);
