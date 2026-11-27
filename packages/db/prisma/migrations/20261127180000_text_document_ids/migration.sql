-- Document ids become text so seeded documents keep the fixture manifest's ids (doc-invoice-001). Uploads still get a uuid, as text.
-- DropForeignKey
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_document_id_fkey";

-- AlterTable
ALTER TABLE "documents" DROP CONSTRAINT "documents_pkey",
ALTER COLUMN "id" SET DEFAULT (gen_random_uuid())::text,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "document_versions" ALTER COLUMN "document_id" SET DATA TYPE TEXT;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

