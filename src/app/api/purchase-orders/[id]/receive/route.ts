import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { z } from 'zod'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const receiptItemSchema = z.object({
  purchase_order_item_id: z.string().min(1),
  org_variant_id: z.string().min(1),
  received_quantity: z.number().int().min(0),
  actual_cost_per_unit: z.number().min(0),
  shortage_quantity: z.number().int().min(0).default(0),
  shortage_reason: z.string().optional().or(z.literal('')),
})

const receiveSchema = z.object({
  notes: z.string().optional().or(z.literal('')),
  items: z.array(receiptItemSchema).min(1, 'At least one item is required'),
})

/**
 * Receive goods against a purchase order.
 * Creates a purchase_order_receipt + receipt_items, then processes
 * inventory_transactions (purchase_received) which recalculates WAC.
 *
 * Supports partial deliveries, quantity discrepancies, and price differences.
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_RECEIVE },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to receive stock.')

    const { id: poId } = await params
    const po = await db.purchaseOrder.findFirst({
      where: { id: poId, companyId: company.id },
      include: { items: true },
    })
    if (!po) throw new ApiError(404, 'Purchase order not found.')
    if (po.status === 'cancelled') throw new ApiError(400, 'Cannot receive against a cancelled PO.')
    if (po.status === 'received') throw new ApiError(400, 'This PO has already been fully received.')

    const body = await readBody(req)
    const parsed = receiveSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Create the receipt header
    const receipt = await db.purchaseOrderReceipt.create({
      data: {
        purchaseOrderId: poId,
        organizationId: orgId,
        receivedById: caller.id,
        notes: d.notes || null,
      },
    })

    // Process each receipt item
    let allFullyReceived = true
    for (const ri of d.items) {
      if (ri.received_quantity <= 0) continue // skip zero-quantity lines

      const poItem = po.items.find((item) => item.id === ri.purchase_order_item_id)
      if (!poItem) throw new ApiError(400, `PO item ${ri.purchase_order_item_id} not found on this PO.`)

      // Process the inventory transaction (purchase_received)
      const txnResult = await processInventoryTransaction({
        orgVariantId: ri.org_variant_id,
        locationId: po.deliveryLocationId,
        organizationId: orgId,
        companyId: company.id,
        employeeId: caller.id,
        transactionType: 'purchase_received',
        quantity: ri.received_quantity,
        costPerUnit: ri.actual_cost_per_unit,
        referenceType: 'purchase_order',
        referenceId: poId,
        notes: `PO ${po.poNumber} receipt`,
        metadata: { poItemId: ri.purchase_order_item_id, receiptId: receipt.id },
      })

      if (!txnResult.success) {
        throw new ApiError(500, `Inventory transaction failed for variant ${ri.org_variant_id}: ${txnResult.error}`)
      }

      // Create the receipt item record
      await db.purchaseOrderReceiptItem.create({
        data: {
          purchaseOrderReceiptId: receipt.id,
          purchaseOrderItemId: ri.purchase_order_item_id,
          orgVariantId: ri.org_variant_id,
          receivedQuantity: ri.received_quantity,
          actualCostPerUnit: ri.actual_cost_per_unit,
          shortageQuantity: ri.shortage_quantity,
          shortageReason: ri.shortage_reason || null,
          inventoryTxnId: txnResult.transactionId ?? null,
        },
      })

      // Update the PO item's received_quantity
      await db.purchaseOrderItem.update({
        where: { id: ri.purchase_order_item_id },
        data: { receivedQuantity: { increment: ri.received_quantity } },
      })

      // Decrement incoming on the pool (never below 0)
      const pool = await db.inventoryPool.findUnique({
        where: {
          orgVariantId_locationId: {
            orgVariantId: ri.org_variant_id,
            locationId: po.deliveryLocationId,
          },
        },
        select: { incoming: true },
      })
      if (pool) {
        const newIncoming = Math.max(0, pool.incoming - ri.received_quantity)
        await db.inventoryPool.update({
          where: {
            orgVariantId_locationId: {
              orgVariantId: ri.org_variant_id,
              locationId: po.deliveryLocationId,
            },
          },
          data: { incoming: newIncoming },
        })
      }

      // Check if this item is now fully received
      const updatedItem = await db.purchaseOrderItem.findUnique({
        where: { id: ri.purchase_order_item_id },
        select: { orderedQuantity: true, receivedQuantity: true },
      })
      if (updatedItem && updatedItem.receivedQuantity < updatedItem.orderedQuantity) {
        allFullyReceived = false
      }
    }

    // Update PO status
    const newStatus = allFullyReceived ? 'received' : 'partially_received'
    await db.purchaseOrder.update({
      where: { id: poId },
      data: { status: newStatus },
    })

    await insertAuditLog({
      action: 'purchase_order.received',
      entityType: 'purchase_order',
      entityId: poId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { receiptId: receipt.id, status: newStatus, itemCount: d.items.length },
    })

    const receivedValue = d.items.reduce(
      (sum, ri) => sum + ri.received_quantity * ri.actual_cost_per_unit,
      0,
    )
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'purchase_order',
      entityId: poId,
      metricKey: 'purchase_order.received',
      numericValue: receivedValue,
      dimensions: {
        supplier_id: po.supplierId,
        is_partial: !allFullyReceived,
        item_count: d.items.length,
      },
    })

    return Response.json({
      success: true,
      receipt_id: receipt.id,
      po_status: newStatus,
    })
  } catch (err) {
    return handleError(err)
  }
}
