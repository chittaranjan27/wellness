# AI Agent SaaS – Project Creation Prompts

Use this document to **recreate this project from scratch** or **hand it to someone** (developer or AI) so they can build it. All prompts are copy-paste ready.

---

## Give this to someone (single prompt)

**Copy the block below and paste it to an AI assistant or send it to a developer.** It describes the full project in one go. For step-by-step building, use the phased prompts in the rest of this file.

```
Build a production-ready AI Agent SaaS platform with the following.

**Stack:** Next.js 14 (App Router), TypeScript, Node.js runtime (no Edge), Tailwind CSS, PostgreSQL (Prisma), Supabase (pgvector for vectors), OpenAI (chat + embeddings), NextAuth (email/password), ElevenLabs (TTS), bcrypt, pdf-parse, mammoth, uuid. Optional: @agentbill-sdk/sdk for usage tracking.

**Core features:**
1. Auth: sign up, sign in (email/password), session via NextAuth, protected /dashboard.
2. Multi-tenant agents: each user has agents; each agent has name, systemPrompt, language (en, hi, ur, etc.).
3. Knowledge base: upload PDF/DOCX/TXT per agent; chunk text (e.g. 1000 chars, 200 overlap), generate embeddings (OpenAI text-embedding-ada-002), store in Supabase pgvector; document status: pending → processing → completed/failed.
4. RAG chat: for each message, get query embedding, search vector DB by agent_id (top N chunks), fetch chunk text from DB, call OpenAI (e.g. GPT-4o-mini) with system prompt + context + history; save user and assistant messages; return response. Support language-specific replies.
5. Voice: TTS via ElevenLabs (language/voice from config), STT via browser Web Speech API; optional AgentBill tracking for TTS.
6. Embed: public page app/embed/[agentId] and POST /api/embed/chat (no auth) for embeddable widget.

**Structure:** app/ (api, auth, dashboard, embed), lib/ (prisma, auth, auth-options, env, openai, embeddings, vector-db, document-processor, languages, agentbill, textChunker, etc.), components/, prisma/schema, types/. Env: DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ELEVENLABS_API_KEY; optional AGENTBILL_API_KEY, UPLOAD_DIR, MAX_FILE_SIZE.

**Security:** userId on all agent operations; verify ownership on every agent/document/chat API; hash passwords (bcrypt); validate file type/size on upload.

**Deliverables:** Working signup/signin, dashboard with agent list and per-agent page (settings, document list, chat), document upload and processing, RAG chat, voice in/out, optional embed widget and usage tracking. README and QUICKSTART with setup and env steps.
```

---

## How to use this document

| Goal | What to do |
|------|------------|
| **Hand off to someone** | Give them this file and tell them to use the **“Give this to someone”** prompt above, or to follow phases in order. |
| **Build step by step** | Follow **Phase 1 → Phase 2 → …** and copy each prompt (inside the code blocks) into your AI or task list. |
| **Quick setup** | After code is generated, use **QUICKSTART.md** in this repo for env, database, and run instructions. |

**Prerequisites (before building):**
- Node.js 18+
- PostgreSQL (local or cloud)
- Supabase project (for pgvector)
- OpenAI API key
- ElevenLabs API key

---

## Phase 1: Project Setup & Foundation

### Prompt 1.1: Initialize Next.js Project with TypeScript
```
Create a new Next.js 14 project using the App Router with TypeScript. 
Configure it to use Node.js runtime (not edge runtime) for all API routes.
Set up Tailwind CSS for styling.
Configure TypeScript with strict mode enabled.
Create a basic project structure with:
- app/ directory for App Router pages
- lib/ directory for utility functions
- components/ directory for React components
- types/ directory for TypeScript definitions
- prisma/ directory for database schema
```

### Prompt 1.2: Setup Package Dependencies
```
Install the following dependencies for an AI Agent SaaS platform:
- next, react, react-dom (Next.js framework)
- @prisma/client, prisma (Database ORM)
- next-auth, @auth/prisma-adapter (Authentication)
- openai (OpenAI API client)
- @supabase/supabase-js (Vector database)
- elevenlabs (Text-to-speech)
- bcryptjs, @types/bcryptjs (Password hashing)
- pdf-parse, mammoth (Document parsing)
- uuid (UUID generation)
- @agentbill-sdk/sdk (Usage tracking/billing)

Also install dev dependencies:
- TypeScript types for all packages
- ESLint with Next.js config
- Tailwind CSS, PostCSS, Autoprefixer
```

### Prompt 1.3: Environment Configuration
```
Create an environment configuration system with the following variables:
- DATABASE_URL (PostgreSQL connection string)
- NEXTAUTH_SECRET (Session secret)
- NEXTAUTH_URL (Application URL)
- OPENAI_API_KEY (OpenAI API key)
- SUPABASE_URL (Supabase project URL)
- SUPABASE_SERVICE_ROLE_KEY (Supabase service role key)
- ELEVENLABS_API_KEY (ElevenLabs API key)
- AGENTBILL_API_KEY (AgentBill SDK key, optional)
- UPLOAD_DIR (File upload directory, default: ./uploads)
- MAX_FILE_SIZE (Max file size in bytes, default: 10MB)
- NODE_ENV (Environment: development/production)

Create a lib/env.ts file that validates all required environment variables at startup and throws errors if any are missing.
```

---

## Phase 2: Database Schema & Setup

### Prompt 2.1: Prisma Schema - User Authentication
```
Create a Prisma schema for PostgreSQL with the following models for authentication:
- User: id (UUID), email (unique), name (optional), password (hashed), emailVerified, createdAt, updatedAt
- Account: NextAuth account model with OAuth provider fields (id, userId, type, provider, providerAccountId, refresh_token, access_token, expires_at, etc.)
- Session: NextAuth session model (id, sessionToken, userId, expires)
- VerificationToken: NextAuth verification token model (identifier, token, expires)

Set up proper relationships and indexes. Use @@map for table naming (users, accounts, sessions, verification_tokens).
```

### Prompt 2.2: Prisma Schema - Agents & Documents
```
Extend the Prisma schema with multi-tenant agent and document models:
- Agent: id (UUID), name, systemPrompt (text), language (default: 'en'), userId, createdAt, updatedAt. Relations: user, documents, chatMessages. Index on userId.
- Document: id (UUID), agentId, filename, filepath, fileSize, mimeType, extractedText (text, optional), status (default: 'pending'), chunksCount, embeddingsCount, errorMessage (optional), createdAt, updatedAt. Relations: agent, chunks. Indexes on agentId and status.
- DocumentChunk: id (UUID), documentId, chunkIndex, text (text), startIndex, endIndex, embedding (JSON, optional), createdAt. Relation: document. Index on documentId.
- ChatMessage: id (UUID), agentId, role ('user' or 'assistant'), content (text), metadata (JSON, optional), createdAt. Relation: agent. Index on [agentId, createdAt].

Ensure all foreign keys use onDelete: Cascade for data integrity.
```

### Prompt 2.3: Prisma Client Setup
```
Create lib/prisma.ts that exports a singleton PrismaClient instance.
Use PrismaClient with proper connection pooling.
Handle connection management for both development and production environments.
Prevent multiple instances of PrismaClient in development (hot reload protection).
```

### Prompt 2.4: Supabase Vector Database Setup
```
Create a SQL script (supabase-setup.sql) to set up pgvector extension and embeddings table:
1. Enable pgvector extension
2. Create document_embeddings table with columns:
   - id (UUID, primary key)
   - agent_id (text, for multi-tenant isolation)
   - chunk_id (text, references document_chunks)
   - embedding (vector(1536) for OpenAI embeddings)
   - created_at (timestamp)
3. Create index on agent_id for fast filtering
4. Create IVFFlat index on embedding column for vector similarity search
5. Create a function for vector similarity search that filters by agent_id

The table should support efficient similarity search with agent isolation.
```

---

## Phase 3: Authentication System

### Prompt 3.1: NextAuth Configuration
```
Set up NextAuth.js v4 with Prisma adapter for authentication:
- Configure Credentials provider for email/password login
- Use bcryptjs to hash passwords with 12 rounds
- Set up session strategy (JWT)
- Configure callbacks for session management
- Create API route at app/api/auth/[...nextauth]/route.ts
- Export NextAuth handler with proper types

Create lib/auth.ts with helper functions for password hashing and validation.
Create lib/auth-options.ts that exports authOptions (providers, callbacks, adapter) for use in the route and getServerSession.
Use @auth/prisma-adapter for database integration.
```

### Prompt 3.2: Sign Up API Route
```
Create POST /api/auth/signup route that:
- Accepts email, name, and password in request body
- Validates email format and password strength (min 8 characters)
- Checks if user already exists
- Hashes password using bcryptjs (12 rounds)
- Creates user in database with Prisma
- Returns success response or appropriate error messages
- Handles all error cases gracefully
```

### Prompt 3.3: Authentication Pages
```
Create authentication pages:
- app/auth/signin/page.tsx: Sign in page with email/password form
- app/auth/signup/page.tsx: Sign up page with email/password/name form

Both pages should:
- Use Tailwind CSS for modern, responsive styling
- Include form validation
- Show error messages
- Redirect to dashboard on successful authentication
- Have proper loading states
- Use Next.js server actions or API routes for form submission
```

### Prompt 3.4: Middleware for Route Protection
```
Create middleware.ts that:
- Protects all /dashboard routes requiring authentication
- Redirects unauthenticated users to /auth/signin
- Allows public access to /auth routes and API routes
- Uses NextAuth getToken to verify sessions
- Handles API route authentication separately (check session in API routes)
```

---

## Phase 4: OpenAI Integration

### Prompt 4.1: OpenAI Chat Client
```
Create lib/openai.ts with:
- OpenAI client initialization using OPENAI_API_KEY
- Function generateChatResponse(systemPrompt, userMessage, contextChunks, language)
- Integrate AgentBill SDK for usage tracking (wrap OpenAI client if AGENTBILL_API_KEY is set)
- Support for language-specific responses (use language parameter)
- Use GPT-4o-mini model (cost-effective, configurable)
- Inject RAG context chunks into the prompt
- Return generated response text
- Handle errors gracefully
- Support multiple languages with language instructions in prompts
```

### Prompt 4.2: Embeddings Generation
```
Create lib/embeddings.ts with:
- OpenAI embeddings client initialization
- Function generateEmbedding(text) that returns 1536-dimensional vector
- Function generateEmbeddingsBatch(texts[]) for batch processing
- Use text-embedding-ada-002 model
- Integrate AgentBill SDK for usage tracking
- Error handling and retry logic
- Return embedding vectors as number arrays
```

### Prompt 4.3: Language Support
```
Create lib/languages.ts with:
- Language configuration interface with: code, name, openaiLanguage, elevenlabsVoiceId
- Default languages: English (en), Hindi (hi), Urdu (ur), and extendable
- Functions: getLanguageByCode(code), getDefaultLanguage()
- Export language configurations for use in chat and TTS
- Support for multilingual OpenAI responses
```

---

## Phase 5: Vector Database & RAG

### Prompt 5.1: Vector Database Client
```
Create lib/vector-db.ts with Supabase integration:
- Initialize Supabase client using SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
- Function storeEmbedding(agentId, chunkId, embedding) to store vectors
- Function searchSimilarChunks(agentId, queryEmbedding, limit) for similarity search
- Use RPC function for vector similarity search (cosine distance)
- Filter results by agentId for multi-tenant isolation
- Return top N similar chunks with metadata
- Handle errors and provide fallback if RPC fails
- Use pgvector cosine distance operator
```

### Prompt 5.2: Document Processor
```
Create lib/document-processor.ts for document processing:
- Function processDocument(documentId) that:
  1. Reads document from filesystem using filepath
  2. Extracts text based on mimeType (PDF using pdf-parse, DOCX using mammoth, TXT direct read)
  3. Chunks text using a chunking utility (e.g. lib/textChunker.ts: ~1000 chars, ~200 overlap, split at sentence boundaries when possible)
  4. Generates embeddings for all chunks (batch processing, e.g. 100 chunks per batch)
  5. Stores embeddings in Supabase vector database
  6. Updates document status: pending → processing → completed/failed
  7. Stores chunk data in PostgreSQL DocumentChunk table
  8. Updates chunksCount and embeddingsCount
  9. Handles errors and updates errorMessage on failure

- Make processing asynchronous and non-blocking
- Support PDF, DOCX, and TXT file formats
- Validate file size and type before processing

Create lib/textChunker.ts with a function that splits text into chunks (e.g. 1000 chars, 200 overlap) and prefers sentence boundaries.
```

---

## Phase 6: API Routes - Core Functionality

### Prompt 6.1: Agents API Routes
```
Create CRUD API routes for agents at app/api/agents/:
- GET /api/agents: List all agents for authenticated user (filter by userId)
- POST /api/agents: Create new agent (name, systemPrompt, language) for authenticated user
- GET /api/agents/[id]: Get single agent details (verify ownership)
- PUT /api/agents/[id]: Update agent (verify ownership, update name/systemPrompt/language)
- DELETE /api/agents/[id]: Delete agent and cascade delete documents/messages (verify ownership)

All routes must:
- Verify authentication using getServerSession
- Filter/verify by userId for security (multi-tenant isolation)
- Return proper HTTP status codes
- Handle errors gracefully
- Use Prisma for database operations
```

### Prompt 6.2: Chat API Route
```
Create POST /api/chat route (and GET for fetching message history) that:
- POST: Accepts agentId, message, and optional language
- Verifies user authentication and agent ownership (getServerSession + authOptions, then prisma.agent with userId)
- Retrieves agent and system prompt
- Performs RAG: generates query embedding (lib/embeddings), searches vector DB for similar chunks by agent_id (top 5), retrieves full chunk text from PostgreSQL DocumentChunk
- Calls generateChatResponse (lib/openai) with system prompt, context chunks, and conversation history
- Saves both user message and assistant response to ChatMessage table
- Returns response text (and optionally message list on GET)
- Handles errors and returns appropriate status codes
- Supports language-specific responses
- Set runtime = 'nodejs' for the route
```

### Prompt 6.3: Document Upload API Route
```
Create POST /api/upload route that:
- Accepts multipart/form-data with file and agentId
- Verifies authentication and agent ownership
- Validates file type (PDF, DOCX, TXT) and size (MAX_FILE_SIZE)
- Saves file to filesystem (UPLOAD_DIR)
- Creates Document record in database with status 'pending'
- Starts asynchronous document processing (don't await)
- Returns document ID and status
- Handles file errors and validation errors
- Uses proper file naming to avoid conflicts
```

### Prompt 6.4: Document Status API Route
```
Create GET /api/documents/[id] route that:
- Verifies authentication
- Retrieves document by ID and verifies ownership (via agent.userId)
- Returns document status, chunksCount, embeddingsCount, errorMessage
- Allows checking processing progress
```

---

## Phase 7: Voice Features

### Prompt 7.1: Text-to-Speech API Route
```
Create POST /api/voice/text-to-speech route that:
- Verifies authentication
- Accepts text, language, and optional voiceId
- Uses language configuration to select appropriate ElevenLabs voice
- Generates speech using ElevenLabs API (monolingual for English, multilingual for others)
- Streams audio directly to client (ReadableStream)
- Returns audio/mpeg content type
- Integrates AgentBill SDK for usage tracking (trackSignal method)
- Handles errors gracefully
- Uses generateSpeech wrapper function with usage tracking
```

### Prompt 7.2: Speech-to-Text (Client-Side)
```
Create client-side speech-to-text functionality:
- Use browser Web Speech API (SpeechRecognition)
- Create types/types/speech.d.ts for TypeScript definitions
- Create component or hook for voice input
- Handle browser compatibility (Chrome/Edge)
- Support multiple languages
- Provide start/stop recording functionality
- Convert speech to text and integrate with chat input
```

---

## Phase 8: Frontend Components

### Prompt 8.1: Dashboard Layout
```
Create app/dashboard/layout.tsx:
- Protected route wrapper (redirect if not authenticated)
- Sidebar navigation with:
  - User info
  - List of agents (with create new button)
  - Documents list per agent
- Main content area
- Responsive design with Tailwind CSS
- Use server components where possible
- Fetch user and agents data server-side
```

### Prompt 8.2: Dashboard Home Page
```
Create app/dashboard/page.tsx:
- Lists all user's agents
- Shows agent count, document count summary
- Quick actions: Create Agent, Upload Document
- Agent cards with name, document count, last activity
- Links to individual agent pages
- Clean, modern UI with Tailwind CSS
```

### Prompt 8.3: Agent Management Pages
```
Create agent management pages:
- app/dashboard/agents/page.tsx: List all agents with create form
- app/dashboard/agents/[id]/page.tsx: Agent detail page with:
  - Agent settings (name, system prompt, language)
  - Document list with upload functionality
  - Chat interface component
  - Edit/delete agent functionality

All pages should:
- Verify agent ownership
- Use server components for data fetching
- Have proper error handling
- Use Tailwind CSS for styling
```

### Prompt 8.4: Chat Component
```
Create components/AgentChat.tsx:
- Real-time chat interface
- Message list with user/assistant messages
- Input field with send button
- Language selector dropdown
- Voice input button (integrate STT)
- Voice output toggle (integrate TTS)
- Loading states
- Error handling
- Scroll to latest message
- Fetch initial messages from API
- Send messages via POST /api/chat
- Beautiful, modern UI with Tailwind CSS
- Support for multiple languages
```

### Prompt 8.5: Document List Component
```
Create components/DocumentList.tsx:
- Display list of documents for an agent
- Show document status (pending, processing, completed, failed)
- Show file name, size, upload date
- Progress indicators for processing
- Delete document functionality
- Upload new document button
- Refresh status functionality
- Error message display for failed documents
```

### Prompt 8.6: Additional Components
```
Create supporting components:
- components/DashboardNav.tsx: Navigation bar/header
- components/AgentListItem.tsx: Agent list item component
- components/ChatMessage.tsx: Individual chat message component
- components/LanguageSelector.tsx: Language selection dropdown
- components/VoiceChatButton.tsx: Voice input/output button
- components/FloatingChatWidget.tsx: Embeddable chat widget
- components/EmbedCodeGenerator.tsx: Generate embed code for agents
- contexts/AgentContext.tsx: React context for agent state management

All components should use Tailwind CSS and be responsive.
```

---

## Phase 9: Embedding & Widget Features

### Prompt 9.1: Embed Route
```
Create app/embed/[agentId]/page.tsx:
- Public embeddable chat widget page (no auth required)
- Load agent by ID (public access)
- Display chat interface in widget format
- Minimal styling, embeddable in iframe
- Support for custom styling via URL params
- Limit functionality to chat only (no settings)
```

### Prompt 9.2: Embed Chat API Route
```
Create POST /api/embed/chat route:
- Public endpoint (no authentication required)
- Accepts agentId, message, language
- Performs same RAG and chat functionality as /api/chat
- Rate limiting consideration (optional)
- Return response text
- No message history saving (or optional)
```

---

## Phase 10: Usage Tracking & Billing

### Prompt 10.1: AgentBill Integration
```
Integrate AgentBill SDK for usage tracking:
- Create lib/agentbill.ts utility for shared AgentBill initialization
- Wrap OpenAI client with AgentBill in lib/openai.ts and lib/embeddings.ts
- Track ElevenLabs usage in text-to-speech route using trackSignal method
- Configure AgentBill with API key from environment
- Track provider, model, tokens, latency, cost metrics
- Handle tracking errors gracefully (don't fail requests)
- Support optional AgentBill API key (works without it)
```

---

## Phase 11: Configuration & Build

### Prompt 11.1: Next.js Configuration
```
Configure next.config.js:
- Set output to 'standalone' for production
- Configure images if needed
- Set up environment variable handling
- Configure for Node.js runtime (no edge functions)
- Set proper build optimizations
```

### Prompt 11.2: TypeScript Configuration
```
Configure tsconfig.json:
- Enable strict mode
- Set proper paths alias (@/* for app directory)
- Configure for Next.js App Router
- Include all necessary directories
- Set proper module resolution
```

### Prompt 11.3: Tailwind Configuration
```
Configure tailwind.config.ts:
- Set content paths for Next.js App Router
- Add custom theme if needed
- Configure plugins
- Set up proper purge settings
```

### Prompt 11.4: PM2 Configuration
```
Create ecosystem.config.js for PM2:
- Configure app name, script, instances
- Set environment variables
- Configure log files
- Set restart policy
- Configure for production deployment
```

---

## Phase 12: Documentation & Scripts

### Prompt 12.1: Documentation Files
```
Create comprehensive documentation:
- README.md: Project overview, features, installation, usage
- ARCHITECTURE.md: System architecture, data flow, security
- QUICKSTART.md: Quick setup guide, troubleshooting
- MIGRATION_GUIDE.md: Database migration instructions (if applicable)

Include:
- Feature list
- Tech stack details
- Prerequisites
- Installation steps
- Configuration guide
- API documentation
- Deployment instructions
- Troubleshooting guide
```

### Prompt 12.2: Utility Scripts
```
Create helpful scripts in scripts/ directory:
- setup.sh: Initial setup script (create directories, set permissions)
- Database migration scripts if needed
- Utility scripts for common tasks

Add npm scripts to package.json:
- dev, build, start (Next.js)
- db:generate, db:push, db:migrate, db:studio (Prisma)
- lint (ESLint)
```

---

## Phase 13: Testing & Refinement

### Prompt 13.1: Error Handling & Validation
```
Add comprehensive error handling:
- API route error handling with try-catch
- Validation for all inputs
- Proper HTTP status codes
- User-friendly error messages
- Logging for debugging
- Graceful degradation
```

### Prompt 13.2: Security Hardening
```
Implement security best practices:
- SQL injection prevention (Prisma)
- XSS prevention (React escaping)
- CSRF protection (NextAuth)
- File upload validation
- Authentication on all protected routes
- Multi-tenant isolation (userId filtering)
- Password hashing (bcrypt)
- Environment variable security
```

### Prompt 13.3: Performance Optimization
```
Optimize performance:
- Database indexing (Prisma schema)
- Batch processing for embeddings
- Efficient vector search
- Connection pooling (Prisma)
- Proper React component optimization
- Lazy loading where appropriate
- File size limits
```

---

## Final Checklist

### Prompt 13.4: Final Integration
```
Verify complete integration:
- All API routes working
- Authentication flow complete
- Database schema deployed
- Vector database configured
- Document processing working
- Chat with RAG functioning
- Voice features operational
- Usage tracking integrated
- Frontend components rendering
- Error handling in place
- Security measures active
- Documentation complete
- Ready for production deployment
```

---

## Deployment Prompts

### Prompt 14.1: Production Build
```
Set up production build:
- Configure environment variables
- Run database migrations
- Build Next.js application
- Test build locally
- Verify all features work
```

### Prompt 14.2: PM2 Deployment
```
Deploy with PM2:
- Install PM2 globally
- Start application with ecosystem.config.js
- Configure auto-restart
- Set up log rotation
- Configure for system startup
- Monitor application status
```

### Prompt 14.3: VPS Configuration
```
Configure VPS deployment:
- Set up reverse proxy (Nginx/Caddy)
- Configure SSL certificates
- Set up firewall rules
- Configure domain pointing
- Set up monitoring
- Configure backups
```

---

## Optional features (after core is done)

These extend the project; build them only if needed. Reference the existing codebase for patterns (lib/crm.service, lib/crawler.service, lib/analytics.service, lib/product.service, and their API routes).

| Feature | Purpose | Key pieces |
|--------|--------|------------|
| **CRM / leads** | Capture leads from chat (name, email, etc.) | lib/crm.service.ts, POST /api/crm, GET /api/crm/leads, export by agent |
| **Web crawl** | Ingest content from URLs for an agent | lib/crawler.service.ts, POST /api/crawl, GET /api/crawl/status/[agentId] |
| **Analytics** | Log conversations, response times, fallbacks | lib/analytics.service.ts, GET /api/analytics/[agentId] |
| **Product suggestions** | Recommend products from documents in chat | lib/product.service.ts, product-related logic in chat route |
| **Agent settings API** | CRUD for agent config via API | GET/PUT /api/agent/settings/[id] |

Use the phased prompts above for the **core** app first; then add these from the repo or by describing each feature in a short prompt.

---

## Summary

- **Hand-off:** Use the **“Give this to someone”** prompt at the top to describe the whole project in one go.
- **Step-by-step:** Use **Phase 1 through Phase 14** in order; copy each prompt from the code blocks.
- **Setup:** After generation, follow **QUICKSTART.md** for env, database, and run steps.

You get a production-style AI Agent SaaS with:

✅ Multi-tenant authentication (NextAuth, Prisma)  
✅ AI agent management (CRUD, ownership)  
✅ RAG-powered chat (OpenAI + pgvector)  
✅ Document processing (PDF/DOCX/TXT, chunking, embeddings)  
✅ Voice (ElevenLabs TTS, Web Speech API STT)  
✅ Optional usage tracking (AgentBill)  
✅ Embeddable widget (embed route + public chat API)  
✅ Production deployment (PM2, env, docs)  

Each phased prompt targets one component so the build stays structured and easy to hand off.
