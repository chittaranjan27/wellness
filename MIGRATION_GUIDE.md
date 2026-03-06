# Migration Guide: Embeddings Storage Fix

## Problem
The app was trying to save embeddings to a `document_embeddings` table in Supabase that didn't exist. This has been fixed to store embeddings directly in the `document_chunks` table in PostgreSQL.

## Steps to Fix

### 1. Run Database Migration
Execute the SQL migration to add the embedding column:

```bash
# Connect to your PostgreSQL database and run:
psql $DATABASE_URL -f migrations/add-embedding-column.sql

# Or manually run the SQL:
```

```sql
ALTER TABLE document_chunks 
ADD COLUMN IF NOT EXISTS embedding JSONB;

CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
ON document_chunks USING gin (embedding);
```

### 2. Update Prisma Client
Generate the Prisma client with the updated schema:

```bash
npx prisma generate
```

### 3. Re-process Existing Documents
If you have existing documents that were processed before this fix, you'll need to re-process them:

1. Delete the old documents from your dashboard
2. Re-upload them so they get processed with the new embedding storage

Or, if you want to keep the documents, you can manually trigger re-processing (this would require additional code).

### 4. Test
1. Upload a new document
2. Wait for it to process (check the document status)
3. Ask a question about the document content
4. The system should now find and use the document context

## What Changed

1. **Prisma Schema**: Added `embedding Json?` field to `DocumentChunk` model
2. **vector-db.ts**: Completely rewritten to use PostgreSQL directly instead of Supabase
3. **document-processor.ts**: Updated to store embeddings in the same table as chunks
4. **chat/route.ts**: Updated to check embeddings in PostgreSQL instead of Supabase

## Notes

- Embeddings are now stored as JSONB in PostgreSQL
- Vector similarity search is done client-side (calculates cosine similarity)
- For better performance with large datasets, consider using pgvector extension (see migration file comments)
