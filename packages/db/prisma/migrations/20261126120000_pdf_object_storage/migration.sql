-- AlterTable
ALTER TABLE "document_versions" DROP COLUMN "pdf",
ADD COLUMN     "mime_type" TEXT NOT NULL,
ADD COLUMN     "sha256" TEXT NOT NULL,
ADD COLUMN     "size_bytes" INTEGER NOT NULL,
ADD COLUMN     "storage_key" TEXT NOT NULL;

