# Wellness AI Agent SaaS

Production-ready AI agent platform tailored for automated wellness health consultations and tailored e-commerce flows, built with Next.js App Router and Node.js.

## Features

- 🔐 User authentication with NextAuth.js
- 🛒 **E-commerce Ready**: Deep integration with Shopify (dynamic AI bundle generation & 1-click checkout)
- 🩺 **Wellness State Machine**: Multi-step automated AI health consultations
- 💎 **Premium UI**: Modern glassmorphism design with responsive micro-animations
- 🤖 Multiple AI agents per user
- 📚 Knowledge base with document upload (PDF, TXT, DOCX)
- 🔍 RAG (Retrieval-Augmented Generation) with vector search
- 💬 Chat interface with OpenAI GPT
- 🎤 Voice chat support (Speech-to-Text + Text-to-Speech)
- 🔒 Agent isolation and security
- 📊 User dashboard

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Runtime**: Node.js 18+ (NO edge functions)
- **Database**: Neon Serverless Postgres with Prisma ORM
- **Vector DB**: Supabase (pgvector) or Neon pgvector
- **AI**: OpenAI GPT-4o-mini (configurable)
- **Embeddings**: OpenAI text-embedding-ada-002 (or Supabase embeddings)
- **TTS**: ElevenLabs API
- **STT**: Browser Web Speech API
- **Styling**: Tailwind CSS
- **Deployment**: PM2 on traditional VPS

## Prerequisites

- Node.js 18 or higher
- Neon Serverless Postgres account
- Supabase account (optional if relying purely on Neon)
- OpenAI API key
- OpenAI API key (for embeddings - optional if using Supabase embeddings)
- ElevenLabs API key
- FastPanel Extended License (for VPS management)

## Installation

1. **Clone the repository**

```bash
cd /home/ranjan/Music/ai_agent
```

2. **Install dependencies**

```bash
npm install
```

3. **Set up environment variables**

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required environment variables:
- `DATABASE_URL`: Neon Postgres connection string
- `NEXTAUTH_SECRET`: Generate with `openssl rand -base64 32`
- `NEXTAUTH_URL`: Your application URL (e.g., `http://localhost:3000`)
- `OPENAI_API_KEY`: OpenAI API key (required for chat and embeddings)
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `ELEVENLABS_API_KEY`: ElevenLabs API key
- `OPENAI_API_KEY`: OpenAI API key (for embeddings)

4. **Set up Neon Serverless Postgres**

```bash
# Generate Prisma client
npm run db:generate

# Run migrations
npm run db:migrate

# Or push schema directly (for development)
npm run db:push
```

5. **Set up Supabase vector database**

Run the SQL script in your Supabase SQL editor:

```bash
# Copy the contents of supabase-setup.sql to Supabase SQL editor
cat supabase-setup.sql
```

Or execute directly if you have `psql` access:

```bash
psql -h your-supabase-host -U postgres -d postgres -f supabase-setup.sql
```

6. **Create uploads directory**

```bash
mkdir -p uploads
chmod 755 uploads
```

## Development

```bash
# Start development server
npm run dev

# Access at http://localhost:3000
```

## Production Deployment (VPS with FastPanel)

1. **Build the application**

```bash
npm run build
```

2. **Set up PM2**

```bash
# Install PM2 globally
npm install -g pm2

# Start application with PM2
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Set up PM2 to start on boot
pm2 startup
```

3. **Configure FastPanel**

- Point your domain to the VPS IP
- Configure reverse proxy to `http://localhost:3000`
- Set up SSL certificate
- Configure firewall rules

4. **Monitor application**

```bash
# View logs
pm2 logs ai-agent-saas

# Monitor status
pm2 status

# Restart application
pm2 restart ai-agent-saas
```

## Project Structure

```
ai_agent/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   │   ├── auth/          # Authentication endpoints
│   │   ├── agents/        # Agent CRUD
│   │   ├── chat/          # Chat API
│   │   ├── upload/        # Document upload
│   │   └── voice/         # Voice chat APIs
│   ├── auth/              # Auth pages (signin, signup)
│   └── dashboard/         # Dashboard pages
├── components/            # React components
├── lib/                   # Utility libraries
│   ├── openai.ts          # OpenAI chat client
│   ├── embeddings.ts      # Embedding generation
│   ├── vector-db.ts       # Vector database operations
│   ├── document-processor.ts # Document processing
│   └── prisma.ts          # Prisma client
├── prisma/                # Prisma schema
├── types/                 # TypeScript type definitions
├── uploads/               # Uploaded documents (gitignored)
└── ecosystem.config.js    # PM2 configuration
```

## API Routes

- `POST /api/chat` - Send chat message with RAG
- `POST /api/sales-agent` - Generate context-aware product bundles and dynamic Shopify shopping carts
- `POST /api/upload` - Upload document for training
- `GET /api/agents` - List user's agents
- `POST /api/agents` - Create new agent
- `GET /api/agents/[id]` - Get agent details
- `PUT /api/agents/[id]` - Update agent
- `DELETE /api/agents/[id]` - Delete agent
- `POST /api/voice/text-to-speech` - Generate speech from text
- `GET /api/documents/[id]` - Get document status

## Security Features

- User authentication with bcrypt password hashing
- Agent ownership verification on all operations
- SQL injection protection via Prisma
- File upload validation (type, size)
- API key storage server-side only
- CORS and CSRF protection via NextAuth

## Performance Considerations

- Document processing happens asynchronously
- Vector search uses indexed embeddings
- Chat messages are paginated
- File uploads use filesystem storage
- PM2 handles process management

## Troubleshooting

### Document processing fails

- Check file size limits in `.env`
- Verify OpenAI API key for embeddings
- Check Supabase vector database connection
- Review uploads directory permissions

### Chat responses are slow

- Verify OpenAI API key and quotas
- Check vector database performance
- Consider increasing chunk size or reducing context chunks

### Voice chat not working

- Ensure browser supports Web Speech API (Chrome/Edge)
- Check HTTPS requirement for Web Speech API
- Verify ElevenLabs API key and quotas

## License

Private - All rights reserved