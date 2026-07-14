import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createLossSchema = z.object({
  org_variant_id: z.string().min(1),
  location_id: z.string().min(1),
  loss_type: z.enum(['damaged', 'theft', 'missing', 'transit_loss']),
  sub_type: z.enum(['confirmed', 'suspected', 'admin_error', 'manufacturing']).optional(),
  damage_type: z.string().optional().or(z.literal('')),
  quantity: z.number().int().positive(),
  cost_per_unit: z.number().min(0),
  notes: z.string().optional().or(z.literal('')),
  responsible_party: z.string().optional().or(z.literal('')),
})

/** List stock loss records for the active company. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const records = await db.stockLossRecord.findMany({
      where: { companyId },
      include: {
        orgVariant: { select: { sku: true, product: { select: { title: true } } } },
        location: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return Response.json({
      records: records.map((r) => ({
        id: r.id,
        productTitle: r.orgVariant.product.title,
        sku: r.orgVariant.sku,
        location: r.location.name,
        lossType: r.lossType,
        subType: r.subType,
        quantity: r.quantity,
        costPerUnit: Number(r.costPerUnit),
        totalLossValue: Number(r.costPerUnit) * r.quantity,
        investigationStatus: r.investigationStatus,
        resolution: r.resolution,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Report a stock loss. Creates a stock_loss_record + processes an inventory transaction. */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_REPORT_LOSS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to report stock loss.')

    const body = await readBody(req)
    const parsed = createLossSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Map loss_type to transaction_type
    const txnTypeMap: Record<string, 'damage_writeoff' | 'theft_writeoff' | 'missing_writeoff' | 'transit_loss'> = {
      damaged: 'damage_writeoff',
      theft: 'theft_writeoff',
      missing: 'missing_writeoff',
      transit_loss: 'transit_loss',
    }
    const txnType = txnTypeMap[d.loss_type]

    // Process the inventory transaction (reduces on_hand)
    const txnResult = await processInventoryTransaction({
      orgVariantId: d.org_variant_id,
      locationId: d.location_id,
      organizationId: orgId,
      companyId: company.id,
      employeeId: caller.id,
      transactionType: txnType,
      quantity: d.quantity,
      costPerUnit: d.cost_per_unit,
      referenceType: 'stock_loss',
      notes: d.notes || null,
    })
    if (!txnResult.success) {
      throw new ApiError(500, `Inventory transaction failed: ${txnResult.error}`)
    }

    // Create the stock_loss_record
    const record = await db.stockLossRecord.create({
      data: {
        organizationId: orgId,
        companyId: company.id,
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        lossType: d.loss_type,
        subType: d.sub_type || null,
        damageType: d.damage_type || null,
        quantity: d.quantity,
        costPerUnit: d.cost_per_unit,
        responsibleParty: d.responsible_party || null,
        notes: d.notes || null,
        reportedById: caller.id,
        inventoryTxnId: txnResult.transactionId ?? null,
      },
    })

    await insertAuditLog({
      action: 'stock_loss.reported',
      entityType: 'stock_loss',
      entityId: record.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { lossType: d.loss_type, quantity: d.quantity, totalValue: d.quantity * d.cost_per_unit },
    })

    return Response.json({ id: record.id, transactionId: txnResult.transactionId })
  } catch (err) {
    return handleError(err)
  }
}
