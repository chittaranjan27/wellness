<<<<<<< HEAD
# AI Agent SaaS

Production-ready AI agent platform similar to Chatling.ai, built with Next.js App Router and Node.js runtime.

## Features

- 🔐 User authentication with NextAuth.js
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
- **Database**: PostgreSQL with Prisma ORM
- **Vector DB**: Supabase (pgvector)
- **AI**: OpenAI GPT-4o-mini (configurable)
- **Embeddings**: OpenAI text-embedding-ada-002 (or Supabase embeddings)
- **TTS**: ElevenLabs API
- **STT**: Browser Web Speech API
- **Styling**: Tailwind CSS
- **Deployment**: PM2 on traditional VPS

## Prerequisites

- Node.js 18 or higher
- PostgreSQL database
- Supabase account (for vector database)
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
- `DATABASE_URL`: PostgreSQL connection string
- `NEXTAUTH_SECRET`: Generate with `openssl rand -base64 32`
- `NEXTAUTH_URL`: Your application URL (e.g., `http://localhost:3000`)
- `OPENAI_API_KEY`: OpenAI API key (required for chat and embeddings)
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `ELEVENLABS_API_KEY`: ElevenLabs API key
- `OPENAI_API_KEY`: OpenAI API key (for embeddings)

4. **Set up PostgreSQL database**

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
=======
# ai_agent



## Getting started

To make it easy for you to get started with GitLab, here's a list of recommended next steps.

Already a pro? Just edit this README.md and make it your own. Want to make it easy? [Use the template at the bottom](#editing-this-readme)!

## Add your files

* [Create](https://docs.gitlab.com/ee/user/project/repository/web_editor.html#create-a-file) or [upload](https://docs.gitlab.com/ee/user/project/repository/web_editor.html#upload-a-file) files
* [Add files using the command line](https://docs.gitlab.com/topics/git/add_files/#add-files-to-a-git-repository) or push an existing Git repository with the following command:

```
cd existing_repo
git remote add origin https://gitlab.com/kchittaranjandora/ai_agent.git
git branch -M main
git push -uf origin main
```

## Integrate with your tools

* [Set up project integrations](https://gitlab.com/kchittaranjandora/ai_agent/-/settings/integrations)

## Collaborate with your team

* [Invite team members and collaborators](https://docs.gitlab.com/ee/user/project/members/)
* [Create a new merge request](https://docs.gitlab.com/ee/user/project/merge_requests/creating_merge_requests.html)
* [Automatically close issues from merge requests](https://docs.gitlab.com/ee/user/project/issues/managing_issues.html#closing-issues-automatically)
* [Enable merge request approvals](https://docs.gitlab.com/ee/user/project/merge_requests/approvals/)
* [Set auto-merge](https://docs.gitlab.com/user/project/merge_requests/auto_merge/)

## Test and Deploy

Use the built-in continuous integration in GitLab.

* [Get started with GitLab CI/CD](https://docs.gitlab.com/ee/ci/quick_start/)
* [Analyze your code for known vulnerabilities with Static Application Security Testing (SAST)](https://docs.gitlab.com/ee/user/application_security/sast/)
* [Deploy to Kubernetes, Amazon EC2, or Amazon ECS using Auto Deploy](https://docs.gitlab.com/ee/topics/autodevops/requirements.html)
* [Use pull-based deployments for improved Kubernetes management](https://docs.gitlab.com/ee/user/clusters/agent/)
* [Set up protected environments](https://docs.gitlab.com/ee/ci/environments/protected_environments.html)

***

# Editing this README

When you're ready to make this README your own, just edit this file and use the handy template below (or feel free to structure it however you want - this is just a starting point!). Thanks to [makeareadme.com](https://www.makeareadme.com/) for this template.

## Suggestions for a good README

Every project is different, so consider which of these sections apply to yours. The sections used in the template are suggestions for most open source projects. Also keep in mind that while a README can be too long and detailed, too long is better than too short. If you think your README is too long, consider utilizing another form of documentation rather than cutting out information.

## Name
Choose a self-explaining name for your project.

## Description
Let people know what your project can do specifically. Provide context and add a link to any reference visitors might be unfamiliar with. A list of Features or a Background subsection can also be added here. If there are alternatives to your project, this is a good place to list differentiating factors.

## Badges
On some READMEs, you may see small images that convey metadata, such as whether or not all the tests are passing for the project. You can use Shields to add some to your README. Many services also have instructions for adding a badge.

## Visuals
Depending on what you are making, it can be a good idea to include screenshots or even a video (you'll frequently see GIFs rather than actual videos). Tools like ttygif can help, but check out Asciinema for a more sophisticated method.

## Installation
Within a particular ecosystem, there may be a common way of installing things, such as using Yarn, NuGet, or Homebrew. However, consider the possibility that whoever is reading your README is a novice and would like more guidance. Listing specific steps helps remove ambiguity and gets people to using your project as quickly as possible. If it only runs in a specific context like a particular programming language version or operating system or has dependencies that have to be installed manually, also add a Requirements subsection.

## Usage
Use examples liberally, and show the expected output if you can. It's helpful to have inline the smallest example of usage that you can demonstrate, while providing links to more sophisticated examples if they are too long to reasonably include in the README.

## Support
Tell people where they can go to for help. It can be any combination of an issue tracker, a chat room, an email address, etc.

## Roadmap
If you have ideas for releases in the future, it is a good idea to list them in the README.

## Contributing
State if you are open to contributions and what your requirements are for accepting them.

For people who want to make changes to your project, it's helpful to have some documentation on how to get started. Perhaps there is a script that they should run or some environment variables that they need to set. Make these steps explicit. These instructions could also be useful to your future self.

You can also document commands to lint the code or run tests. These steps help to ensure high code quality and reduce the likelihood that the changes inadvertently break something. Having instructions for running tests is especially helpful if it requires external setup, such as starting a Selenium server for testing in a browser.

## Authors and acknowledgment
Show your appreciation to those who have contributed to the project.

## License
For open source projects, say how it is licensed.

## Project status
If you have run out of energy or time for your project, put a note at the top of the README saying that development has slowed down or stopped completely. Someone may choose to fork your project or volunteer to step in as a maintainer or owner, allowing your project to keep going. You can also make an explicit request for maintainers.
>>>>>>> 46f720c737584f0cd8363775959dff56bbca50f0
