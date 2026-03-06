#!/bin/bash
# Setup script for AI Agent SaaS
# Run this after cloning the repository

set -e

echo "Setting up AI Agent SaaS..."

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18 or higher is required. Current version: $(node -v)"
  exit 1
fi

echo "✓ Node.js version check passed"

# Install dependencies
echo "Installing dependencies..."
npm install

echo "✓ Dependencies installed"

# Create uploads directory
echo "Creating uploads directory..."
mkdir -p uploads
chmod 755 uploads

echo "✓ Uploads directory created"

# Generate Prisma client
echo "Generating Prisma client..."
npm run db:generate

echo "✓ Prisma client generated"

# Check if .env exists
if [ ! -f .env ]; then
  echo "⚠️  Warning: .env file not found. Please copy .env.example to .env and fill in your configuration."
  echo "   cp .env.example .env"
else
  echo "✓ .env file found"
fi

echo ""
echo "Setup complete! Next steps:"
echo "1. Copy .env.example to .env and fill in your API keys"
echo "2. Set up PostgreSQL database and update DATABASE_URL in .env"
echo "3. Run 'npm run db:push' to create database schema"
echo "4. Set up Supabase and run supabase-setup.sql"
echo "5. Run 'npm run dev' to start development server"
echo ""
