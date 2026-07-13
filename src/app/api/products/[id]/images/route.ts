import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { db } from '@/lib/db'
import { promises as fs } from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UPLOAD_ROOT = path.join(process.cwd(), 'public', 'uploads')
const MAX_SIZE = 5 * 1024 * 1024 // 5 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/**
 * Upload a product image.
 * POST /api/products/[id]/images  (multipart form-data: file=..., variant_id=...)
 * - If first image for the product: is_primary = true
 * - Stores locally under /public/uploads/products/{orgId}/{productId}/
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id: productId } = await params
    const product = await db.orgProduct.findFirst({ where: { id: productId, organizationId: orgId } })
    if (!product) throw new ApiError(404, 'Product not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const isOwner = product.sourceCompanyId === companyId
    const elevated = caller.role.roleTier === 'elevated'
    if (!isOwner && !elevated) {
      throw new ApiError(403, 'Only the source company can upload images.')
    }
    const allowed =
      elevated ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_EDIT },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to edit products.')

    const formData = await req.formData()
    const file = formData.get('file')
    const variantId = (formData.get('variant_id') as string) || null

    if (!(file instanceof File)) throw new ApiError(400, 'No file provided.')
    if (!ALLOWED_TYPES.includes(file.type)) {
      throw new ApiError(400, 'Only JPG, PNG, and WebP images are allowed.')
    }
    if (file.size > MAX_SIZE) {
      throw new ApiError(400, 'File too large. Maximum 5 MB.')
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const dir = path.join(UPLOAD_ROOT, 'products', orgId, productId)
    await fs.mkdir(dir, { recursive: true })
    const buffer = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(path.join(dir, filename), buffer)

    const storagePath = `products/${orgId}/${productId}/${filename}`
    const publicUrl = `/uploads/${storagePath}`

    // Check if this is the first image
    const imageCount = await db.orgProductImage.count({ where: { productId } })
    const isPrimary = imageCount === 0

    const image = await db.orgProductImage.create({
      data: {
        productId,
        organizationId: orgId,
        variantId: variantId || null,
        storagePath,
        publicUrl,
        displayOrder: imageCount,
        isPrimary,
        uploadedById: caller.id,
      },
    })

    await insertAuditLog({
      action: 'product.image_uploaded',
      entityType: 'product_image',
      entityId: image.id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { productId, isPrimary, variantId },
    })

    return Response.json({ success: true, image_id: image.id, public_url: publicUrl, is_primary: isPrimary })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Delete a product image.
 * DELETE /api/products/[id]/images?image_id=xxx
 * - Removes from storage + database
 * - If deleted image was primary: promotes next image
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id: productId } = await params
    const product = await db.orgProduct.findFirst({ where: { id: productId, organizationId: orgId } })
    if (!product) throw new ApiError(404, 'Product not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const isOwner = product.sourceCompanyId === companyId
    const elevated = caller.role.roleTier === 'elevated'
    if (!isOwner && !elevated) {
      throw new ApiError(403, 'Only the source company can delete images.')
    }

    const url = new URL(req.url)
    const imageId = url.searchParams.get('image_id')
    if (!imageId) throw new ApiError(400, 'image_id query parameter is required.')

    const image = await db.orgProductImage.findFirst({ where: { id: imageId, productId } })
    if (!image) throw new ApiError(404, 'Image not found.')

    // Delete from storage
    const fullPath = path.join(UPLOAD_ROOT, image.storagePath)
    try {
      await fs.unlink(fullPath)
    } catch {
      /* best-effort */
    }

    await db.orgProductImage.delete({ where: { id: imageId } })

    // If deleted image was primary, promote the next one
    if (image.isPrimary) {
      const nextImage = await db.orgProductImage.findFirst({
        where: { productId },
        orderBy: { displayOrder: 'asc' },
      })
      if (nextImage) {
        await db.orgProductImage.update({
          where: { id: nextImage.id },
          data: { isPrimary: true },
        })
      }
    }

    await insertAuditLog({
      action: 'product.image_deleted',
      entityType: 'product_image',
      entityId: imageId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { wasPrimary: image.isPrimary },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
