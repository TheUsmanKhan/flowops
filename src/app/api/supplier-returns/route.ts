import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSupplierReturnSchema = z.object({
  purchase_order_id: z.string().optional().or(z.literal('')),
  supplier_id: z.string().min(1),
  org_variant_id: z.string().min(1),
  location_id: z.string().min(1),
  quantity: z.number().int().positive(),
  cost_per_unit: z.number().min(0),
  reason: z.enum(['defective', 'wrong_item', 'quality_issue', 'excess_quantity', 'other']),
  notes: z.string().optional().or(z.literal('')),
})

/** List supplier returns for the active company. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const records = await db.supplierReturn.findMany({
      where: { companyId },
      include: {
        supplier: { select: { name: true } },
        orgVariant: { select: { sku: true, product: { select: { title: true } } } },
        location: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return Response.json({
      records: records.map((r) => ({
        id: r.id,
        supplier: r.supplier.name,
        productTitle: r.orgVariant.product.title,
        sku: r.orgVariant.sku,
        location: r.location.name,
        quantity: r.quantity,
        costPerUnit: Number(r.costPerUnit),
        totalValue: Number(r.costPerUnit) * r.quantity,
        reason: r.reason,
        status: r.status,
        resolutionType: r.resolutionType,
        resolutionAmount: r.resolutionAmount ? Number(r.resolutionAmount) : null,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a supplier return. Processes a supplier_return inventory transaction. */
export async function POST(req: Request) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')

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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_SUPPLIER_RETURNS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage supplier returns.')

    const body = await readBody(req)
    const parsed = createSupplierReturnSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate supplier-return submissions).
    const createSupplierReturn = async () => {
      // Process the inventory transaction (reduces on_hand using existing avg_cost)
      const txnResult = await processInventoryTransaction({
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        organizationId: orgId,
        companyId: company.id,
        employeeId: caller.id,
        transactionType: 'supplier_return',
        quantity: d.quantity,
        costPerUnit: d.cost_per_unit,
        referenceType: 'supplier_return',
        notes: d.notes || `Return to ${d.supplier_id}: ${d.reason}`,
      })
      if (!txnResult.success) {
        throw new ApiError(500, `Inventory transaction failed: ${txnResult.error}`)
      }

      const record = await db.supplierReturn.create({
        data: {
          organizationId: orgId,
          companyId: company.id,
          purchaseOrderId: d.purchase_order_id || null,
          supplierId: d.supplier_id,
          orgVariantId: d.org_variant_id,
          locationId: d.location_id,
          quantity: d.quantity,
          costPerUnit: d.cost_per_unit,
          reason: d.reason,
          status: 'pending',
          notes: d.notes || null,
          inventoryTxnId: txnResult.transactionId ?? null,
          reportedById: caller.id,
        },
      })

      insertAuditLog({
        action: 'supplier_return.created',
        entityType: 'supplier_return',
        entityId: record.id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { quantity: d.quantity, reason: d.reason, totalValue: d.quantity * d.cost_per_unit },
      })

      insertMetricEvent({
        companyId: company.id,
        entityType: 'supplier',
        entityId: d.supplier_id,
        metricKey: 'supplier_return.created',
        numericValue: d.quantity * d.cost_per_unit,
        dimensions: {
          reason: d.reason,
          org_variant_id: d.org_variant_id,
          purchase_order_id: d.purchase_order_id || null,
          location_id: d.location_id,
        },
      })

      return { id: record.id, transactionId: txnResult.transactionId }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'supplier_return.create',
        fn: createSupplierReturn,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createSupplierReturn()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
