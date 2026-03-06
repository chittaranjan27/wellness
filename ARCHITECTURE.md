# Architecture Overview

## System Architecture

This AI Agent SaaS follows a traditional server-side architecture optimized for VPS deployment with FastPanel.

### Components

1. **Frontend (Next.js App Router)**
   - React Server Components for initial render
   - Client Components for interactivity
   - Tailwind CSS for styling
   - Browser Web Speech API for STT (client-side)

2. **Backend (Next.js API Routes)**
   - Node.js runtime (NO edge functions)
   - RESTful API design
   - Session-based authentication with NextAuth.js
   - Filesystem file storage

3. **Database Layer**
   - PostgreSQL for relational data (users, agents, documents, messages)
   - Prisma ORM for type-safe database access
   - Supabase (pgvector) for vector embeddings

4. **AI Services**
   - OpenAI GPT-4o-mini for chat completions
   - OpenAI text-embedding-ada-002 for embeddings (optional)
   - ElevenLabs for text-to-speech

## Data Flow

### Chat Flow with RAG

1. User sends message via chat interface
2. API route receives request and authenticates user
3. System generates embedding for user query
4. Vector database performs similarity search
5. Top 5 relevant chunks retrieved
6. Chunks injected into OpenAI prompt as context
7. OpenAI generates response with context
8. Response saved to database and returned to client

### Document Processing Flow

1. User uploads document via dashboard
2. File saved to filesystem (`/uploads` directory)
3. Document record created in PostgreSQL with status "pending"
4. Background processing starts:
   - Text extraction (PDF/DOCX/TXT)
   - Text chunking (1000 chars with 200 char overlap)
   - Embedding generation (batch processing)
   - Vector storage in Supabase
5. Document status updated to "completed" or "failed"

## Security Architecture

### Multi-Tenant Isolation

- All database queries filter by `userId`
- Agent ownership verified on every API request
- Documents are scoped to agents, agents to users
- Vector database queries filtered by `agentId`

### Authentication Flow

- Credentials stored with bcrypt hashing (12 rounds)
- JWT tokens for session management
- Server-side session validation
- Protected routes checked in middleware

### API Security

- All API routes require authentication
- File upload validation (type, size)
- SQL injection prevention via Prisma
- XSS protection via React escaping

## Deployment Architecture

### VPS Setup (FastPanel)

```
┌─────────────────┐
│   FastPanel     │
│   (Nginx)       │
└────────┬────────┘
         │
         │ Reverse Proxy
         │
┌────────▼────────┐
│   PM2 Process   │
│   Port 3000     │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌──▼────┐
│Postgres│ │Supabase│
└────────┘ └───────┘
```

### File Storage

- Documents stored in filesystem (`./uploads`)
- No cloud storage dependencies
- File paths stored in database
- Cleanup on document deletion

## Performance Considerations

### Optimization Strategies

1. **Document Processing**
   - Async processing to avoid blocking
   - Batch embedding generation (100 chunks/batch)
   - Chunking at sentence boundaries

2. **Vector Search**
   - Indexed embeddings (IVFFlat index)
   - Limit to top 5 results
   - Client-side fallback if RPC fails

3. **Chat Performance**
   - Recent messages cached (last 50)
   - Streaming responses (future enhancement)
   - Connection pooling via Prisma

4. **File Upload**
   - Direct filesystem write
   - Size validation before processing
   - Background processing queue

## Scalability

### Current Limitations

- Single Node.js process (PM2 fork mode)
- Filesystem storage (local VPS)
- No load balancing

### Future Enhancements

- Horizontal scaling with multiple PM2 instances
- Redis for session storage
- S3-compatible storage for documents
- Message queue for document processing
- CDN for static assets

## Monitoring & Logging

- PM2 process monitoring
- Error logging to files (`./logs/`)
- Console logging for development
- Database query logging in development mode
