/**
 * Document Upload API Route
 * Handles file uploads and initiates document processing
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { prisma } from '@/lib/prisma'
import { env } from '@/lib/env'
import { processDocument } from '@/lib/document-processor'
import { v4 as uuidv4 } from 'uuid'

export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes for large file processing

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File
    const agentId = formData.get('agentId') as string

    if (!file || !agentId) {
      return NextResponse.json({ error: 'Missing file or agentId' }, { status: 400 })
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify agent ownership
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: user.id,
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found or access denied' }, { status: 403 })
    }

    // Validate file size
    if (file.size > env.MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds maximum of ${env.MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 400 }
      )
    }

    // Validate file type
    const allowedMimeTypes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ]

    if (!allowedMimeTypes.includes(file.type)) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }

    // Create upload directory if it doesn't exist
    const uploadDir = env.UPLOAD_DIR
    await mkdir(uploadDir, { recursive: true })

    // Generate unique filename
    const fileExtension = file.name.split('.').pop()
    const filename = `${uuidv4()}.${fileExtension}`
    const filepath = join(uploadDir, filename)

    // Save file to filesystem
    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    await writeFile(filepath, buffer)

    // Create document record
    const document = await prisma.document.create({
      data: {
        agentId,
        filename: file.name,
        filepath,
        fileSize: file.size,
        mimeType: file.type,
        status: 'pending',
      },
    })

    // Process document asynchronously (don't wait for completion)
    processDocument(document.id).catch((error) => {
      console.error('Background document processing error:', error)
    })

    return NextResponse.json({
      documentId: document.id,
      status: 'pending',
      message: 'File uploaded successfully. Processing in background.',
    })
  } catch (error) {
    console.error('Upload API error:', error)
    return NextResponse.json(
      { error: 'Failed to upload file', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
