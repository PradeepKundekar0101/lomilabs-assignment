-- Match the type name used by the assignment's fixtures (expected-fields.json, documents.json).
ALTER TYPE "document_type" RENAME VALUE 'report' TO 'market_report';

-- The run row is inserted at claim time, before the prompt can be built (spec 003).
ALTER TABLE "extraction_runs" ALTER COLUMN "prompt" DROP NOT NULL;
