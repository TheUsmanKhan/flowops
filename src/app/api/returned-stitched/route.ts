import { db } from '@/lib/db'
import { getWorkspace, requirePermission, handleError } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List returned stitched inventory for the active company.
 * Filters: status, org_variant_id, date range.
 * Joined with variant + product details.
 *
 * NOTE: The POST (create/receive) handler was removed in MERGE-RETURNED-STITCHED-INTO-RTO.
 * Returned-stitched rows are now created automatically by restockOrderForRto()
 * when a made_to_order item is restocked from an RTO. The list/mark-sold/write-off
 * endpoints remain so staff can manage the returned-stitched pool.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)

    const companyId = ctx.company.id

    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? ''
    const variantId = url.searchParams.get('org_variant_id') ?? ''

    const items = await db.returnedStitchedInventory.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
        ...(variantId ? { orgVariantId: variantId } : {}),
      },
      include: {
        orgVariant: {
          include: {
            product: { select: { id: true, title: true, slug: true } },
          },
        },
      },
      orderBy: { receivedAt: 'desc' },
    })

    return Response.json({
      items: items.map((i) => ({
        id: i.id,
        variant: {
          id: i.orgVariant.id,
          sku: i.orgVariant.sku,
          attributeValues: JSON.parse(i.orgVariant.attributeValues),
          product: i.orgVariant.product,
        },
        quantity: i.quantity,
        condition: i.condition,
        totalCost: Number(i.totalCost),
        suggestedResalePrice: i.suggestedResalePrice ? Number(i.suggestedResalePrice) : null,
        returnReason: i.returnReason,
        status: i.status,
        photos: JSON.parse(i.photos),
        notes: i.notes,
        receivedAt: i.receivedAt.toISOString(),
        soldAt: i.soldAt?.toISOString() ?? null,
        writtenOffAt: i.writtenOffAt?.toISOString() ?? null,
        writeOffReason: i.writeOffReason,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
