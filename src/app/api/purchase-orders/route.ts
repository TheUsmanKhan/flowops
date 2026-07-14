import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { generatePoNumber } from '@/lib/inventory'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const poItemSchema = z.object({
  org_variant_id: z.string().min(1),
  ordered_quantity: z.number().int().positive(),
  cost_per_unit: z.number().min(0),
})

const createPoSchema = z.object({
  supplier_id: z.string().min(1),
  delivery_location_id: z.string().min(1),
  expected_delivery_date: z.string().optional(),
  advance_payment: z.number().min(0).default(0),
  payment_method: z.string().optional().or(z.literal('')),
  notes: z.string().optional().or(z.literal('')),
  items: z.array(poItemSchema).min(1, 'At least one item is required'),
  status: z.enum(['draft', 'ordered']).default('draft'),
})

/** List purchase orders for the active company. */
export async function GET(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? ''

    const orders = await db.purchaseOrder.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
      },
      include: {
        supplier: { select: { name: true } },
        deliveryLocation: { select: { name: true } },
        items: { select: { costPerUnit: true, orderedQuantity: true, receivedQuantity: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return Response.json({
      orders: orders.map((po) => {
        const totalItemsValue = po.items.reduce(
          (sum, item) => sum + Number(item.costPerUnit) * item.orderedQuantity,
          0,
        )
        const receivedValue = po.items.reduce(
          (sum, item) =>
            sum + Number(item.costPerUnit) * Math.min(item.receivedQuantity, item.orderedQuantity),
          0,
        )
        return {
          id: po.id,
          poNumber: po.poNumber,
          status: po.status,
          supplier: po.supplier.name,
          deliveryLocation: po.deliveryLocation.name,
          orderDate: po.orderDate.toISOString(),
          expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
          advancePayment: Number(po.advancePayment),
          itemCount: po._count.items,
          totalItemsValue,
          receivedValue,
          balanceDue: Math.max(0, totalItemsValue - Number(po.advancePayment)),
        }
      }),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a purchase order. */
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage purchase orders.')

    const body = await readBody(req)
    const parsed = createPoSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Verify supplier belongs to this org
    const supplier = await db.supplier.findFirst({
      where: { id: d.supplier_id, organizationId: orgId, isActive: true },
    })
    if (!supplier) throw new ApiError(404, 'Supplier not found.')

    // Verify delivery location
    const location = await db.inventoryLocation.findFirst({
      where: { id: d.delivery_location_id, organizationId: orgId, isActive: true },
    })
    if (!location) throw new ApiError(404, 'Delivery location not found.')

    // Generate PO number
    const poNumber = await generatePoNumber(orgId)

    // Create PO + items
    const po = await db.purchaseOrder.create({
      data: {
        organizationId: orgId,
        companyId: company.id,
        supplierId: d.supplier_id,
        poNumber,
        status: d.status,
        expectedDeliveryDate: d.expected_delivery_date ? new Date(d.expected_delivery_date) : null,
        deliveryLocationId: d.delivery_location_id,
        advancePayment: d.advance_payment,
        paymentMethod: d.payment_method || null,
        notes: d.notes || null,
        createdById: caller.id,
        items: {
          create: d.items.map((item) => ({
            orgVariantId: item.org_variant_id,
            organizationId: orgId,
            orderedQuantity: item.ordered_quantity,
            receivedQuantity: 0,
            costPerUnit: item.cost_per_unit,
          })),
        },
      },
      include: { items: true },
    })

    // If status = 'ordered': update incoming stock on the delivery location's pools
    if (d.status === 'ordered') {
      for (const item of po.items) {
        // Find or create the pool and increment incoming
        await db.inventoryPool.upsert({
          where: {
            orgVariantId_locationId: {
              orgVariantId: item.orgVariantId,
              locationId: d.delivery_location_id,
            },
          },
          update: { incoming: { increment: item.orderedQuantity } },
          create: {
            orgVariantId: item.orgVariantId,
            locationId: d.delivery_location_id,
            organizationId: orgId,
            incoming: item.orderedQuantity,
          },
        })
      }
    }

    await insertAuditLog({
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: po.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { poNumber, status: d.status, itemCount: d.items.length },
    })

    return Response.json({ id: po.id, poNumber })
  } catch (err) {
    return handleError(err)
  }
}
