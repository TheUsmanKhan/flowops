import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { promises as fs } from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UPLOAD_ROOT = path.join(process.cwd(), 'public', 'uploads')
const MAX_SIZE = 2 * 1024 * 1024 // 2 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/**
 * Logo upload endpoint.
 *
 * Stores files locally under /public/uploads/{type}/{id}/ and returns the
 * public URL. The contract mirrors Supabase Storage's upload + getPublicUrl
 * flow, so swapping to Supabase Storage later only requires changing this
 * route — every consumer just uses the returned URL string.
 *
 * Path convention: /api/upload?type={organizations|companies|avatars}&id={entityId}
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const url = new URL(req.url)
    const type = url.searchParams.get('type') ?? 'avatars'
    const id = url.searchParams.get('id') ?? user.id

    if (!['organizations', 'companies', 'avatars'].includes(type)) {
      throw new ApiError(400, 'Invalid upload type.')
    }

    const formData = await req.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      throw new ApiError(400, 'No file provided.')
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      throw new ApiError(400, 'Only JPG, PNG, and WebP images are allowed.')
    }
    if (file.size > MAX_SIZE) {
      throw new ApiError(400, 'File too large. Maximum 2 MB.')
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const filename = `${Date.now()}-logo.${ext}`
    const dir = path.join(UPLOAD_ROOT, type, id)
    await fs.mkdir(dir, { recursive: true })

    const buffer = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(path.join(dir, filename), buffer)

    const publicUrl = `/uploads/${type}/${id}/${filename}`
    return Response.json({ url: publicUrl })
  } catch (err) {
    return handleError(err)
  }
}
