# Quick Start Guide

Get your AI Agent SaaS up and running in 5 steps.

## Prerequisites Checklist

- [ ] Node.js 18+ installed
- [ ] PostgreSQL database accessible
- [ ] Supabase account created
- [ ] OpenAI API key
- [ ] ElevenLabs API key
- [ ] OpenAI API key (optional, for embeddings)

## Step 1: Clone and Install

```bash
cd /home/ranjan/Music/ai_agent
npm install
```

Or use the setup script:

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

## Step 2: Configure Environment

Create `.env` file (copy from `.env.example` if available, or create manually):

```bash
# Required
DATABASE_URL="postgresql://user:pass@localhost:5432/ai_agent_db"
NEXTAUTH_SECRET="$(openssl rand -base64 32)"
NEXTAUTH_URL="http://localhost:3000"
OPENAI_API_KEY="your-key"
SUPABASE_URL="https://xxx.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-key"
ELEVENLABS_API_KEY="your-key"

# Optional
OPENAI_API_KEY="your-key"  # For embeddings
UPLOAD_DIR="./uploads"
MAX_FILE_SIZE=10485760
```

Generate NEXTAUTH_SECRET:
```bash
openssl rand -base64 32
```

## Step 3: Set Up Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database (or use migrate)
npm run db:push
```

## Step 4: Set Up Supabase Vector Database

1. Go to your Supabase project SQL Editor
2. Copy contents of `supabase-setup.sql`
3. Execute the SQL script
4. Verify the `document_embeddings` table was created

Or via CLI:
```bash
psql $DATABASE_URL -f supabase-setup.sql
```

## Step 5: Start the Application

### Development
```bash
npm run dev
```

Visit: http://localhost:3000

### Production
```bash
npm run build
npm start
```

### Production with PM2
```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow instructions to enable on boot
```

## First Steps After Launch

1. **Sign Up**: Create your first account at `/auth/signup`
2. **Create Agent**: Go to Dashboard → Create Agent
3. **Upload Document**: Add a knowledge base document (PDF, TXT, or DOCX)
4. **Wait for Processing**: Document will be processed (check status in sidebar)
5. **Start Chatting**: Ask questions related to your document!

## Troubleshooting

### "Missing required environment variable"
- Check `.env` file exists and has all required variables
- Verify no typos in variable names

### "Database connection failed"
- Verify PostgreSQL is running
- Check DATABASE_URL format: `postgresql://user:password@host:port/database`
- Test connection: `psql $DATABASE_URL`

### "Document processing stuck"
- Check OpenAI API key if using embeddings
- Verify Supabase connection
- Check uploads directory permissions: `chmod 755 uploads`
- Review logs: `pm2 logs` or check console

### "Chat not working"
- Verify OpenAI API key is valid
- Check API quotas/limits
- Ensure at least one document is processed (status: completed)

### "Voice chat not working"
- Requires HTTPS in production (Web Speech API)
- Chrome/Edge browsers recommended
- Check browser console for errors

## Next Steps

- [ ] Configure reverse proxy (Nginx/Caddy) for production
- [ ] Set up SSL certificate (Let's Encrypt)
- [ ] Configure PM2 to auto-restart
- [ ] Set up monitoring and logging
- [ ] Configure backup strategy for database
- [ ] Review and adjust chunk sizes for your use case

## Support

For issues, check:
- `ARCHITECTURE.md` for system design
- `README.md` for detailed documentation
- Application logs: `./logs/` or `pm2 logs`
