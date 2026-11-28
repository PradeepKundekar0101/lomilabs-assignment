-- Soft delete (spec 011): a deleted document is hidden from the app and the API; its versions, values and reviews stay.
-- AlterTable
ALTER TABLE "documents" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
