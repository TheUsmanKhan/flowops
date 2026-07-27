import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { db } from '@/lib/db'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB for payment proofs, 2MB for logos
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/**
 * Generic file upload endpoint.
 * Stores files locally under /public/uploads/{type}/{id}/{filename}
 * Returns { url } with the public URL path.
 *
 * Types: organizations, companies, avatars (2MB limit)
 *        order_screenshot, payment-proofs (5MB limit)
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const url = new URL(req.url)
    const type = url.searchParams.get('type') || 'general'
    const id = url.searchParams.get('id') || 'temp'

    const formData = await req.formData()
    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      throw new ApiError(400, 'No file provided')
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      throw new ApiError(400, 'Only JPG, PNG, and WebP images are allowed.')
    }

    // Validate file size
    const maxSize = ['order_screenshot', 'payment-proofs'].includes(type) ? MAX_FILE_SIZE : 2 * 1024 * 1024
    if (file.size > maxSize) {
      throw new ApiError(400, `File too large. Maximum ${Math.round(maxSize / 1024 / 1024)} MB.`)
    }

    // Get user's org for path
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId || 'unknown'

    // Build storage path
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_')
    const dirPath = path.join(process.cwd(), 'public', 'uploads', type, orgId, id)
    const filePath = path.join(dirPath, `${timestamp}-${safeName}`)

    // Create directory if needed
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true })
    }

    // Write file
    const arrayBuffer = await file.arrayBuffer()
    await writeFile(filePath, Buffer.from(arrayBuffer))

    // Return the public URL path
    const publicUrl = `/uploads/${type}/${orgId}/${id}/${timestamp}-${safeName}`

    return Response.json({ url: publicUrl })
  } catch (err) {
    return handleError(err)
  }
}
