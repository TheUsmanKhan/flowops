import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Inventory dashboard stats.
 * Returns: total stock value, low stock count, out of stock count,
 * dead stock value, stock movement summary (this month), recent transactions.
 */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    // Fetch all pools for this org with variant info
    const pools = await db.inventoryPool.findMany({
      where: { organizationId: orgId },
      include: {
        orgVariant: {
          select: {
            id: true,
            sku: true,
            fulfillmentType: true,
            product: { select: { title: true } },
          },
        },
        location: { select: { id: true, name: true } },
      },
    })

    const totalStockValue = pools.reduce((sum, p) => sum + p.onHand * Number(p.avgCost), 0)
    const lowStockItems = pools.filter((p) => p.reorderPoint > 0 && p.onHand <= p.reorderPoint && p.onHand > 0)
    const outOfStockItems = pools.filter((p) => p.onHand === 0)

    // Dead stock: no sale in 90+ days (lastSoldAt is null or > 90 days ago)
    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
    const deadStockPools = pools.filter(
      (p) => p.onHand > 0 && (!p.lastSoldAt || p.lastSoldAt < ninetyDaysAgo),
    )
    const deadStockValue = deadStockPools.reduce((sum, p) => sum + p.onHand * Number(p.avgCost), 0)

    // Stock movement this month
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const monthTxns = await db.inventoryTransaction.findMany({
      where: {
        organizationId: orgId,
        recordedAt: { gte: startOfMonth },
      },
      select: { transactionType: true, quantity: true, costPerUnit: true },
    })

    const received = monthTxns.filter((t) => ['purchase_received', 'opening_stock', 'transfer_in', 'return_resellable', 'return_stitched_received'].includes(t.transactionType))
    const sold = monthTxns.filter((t) => t.transactionType === 'sale_dispatched')
    const losses = monthTxns.filter((t) => ['damage_writeoff', 'theft_writeoff', 'missing_writeoff', 'transit_loss', 'supplier_return'].includes(t.transactionType))

    const receivedUnits = received.reduce((s, t) => s + Math.abs(t.quantity), 0)
    const receivedValue = received.reduce((s, t) => s + Math.abs(t.quantity) * Number(t.costPerUnit), 0)
    const soldUnits = sold.reduce((s, t) => s + Math.abs(t.quantity), 0)
    const soldValue = sold.reduce((s, t) => s + Math.abs(t.quantity) * Number(t.costPerUnit), 0)
    const lossUnits = losses.reduce((s, t) => s + Math.abs(t.quantity), 0)
    const lossValue = losses.reduce((s, t) => s + Math.abs(t.quantity) * Number(t.costPerUnit), 0)

    // Recent transactions (last 30)
    const recentTxns = await db.inventoryTransaction.findMany({
      where: { organizationId: orgId },
      include: {
        orgVariant: { select: { sku: true, product: { select: { title: true } } } },
        location: { select: { name: true } },
      },
      orderBy: { recordedAt: 'desc' },
      take: 30,
    })

    return Response.json({
      stats: {
        totalStockValue,
        lowStockCount: lowStockItems.length,
        outOfStockCount: outOfStockItems.length,
        deadStockValue,
      },
      movement: {
        openingValue: totalStockValue - receivedValue + soldValue + lossValue, // approximate
        receivedUnits,
        receivedValue,
        soldUnits,
        soldValue,
        lossUnits,
        lossValue,
        closingValue: totalStockValue,
      },
      stockTable: pools.map((p) => ({
        poolId: p.id,
        variantId: p.orgVariant.id,
        sku: p.orgVariant.sku,
        productTitle: p.orgVariant.product.title,
        location: p.location.name,
        locationId: p.location.id,
        onHand: p.onHand,
        reserved: p.reserved,
        available: p.onHand - p.reserved,
        avgCost: Number(p.avgCost),
        stockValue: p.onHand * Number(p.avgCost),
        incoming: p.incoming,
        fulfillmentType: p.orgVariant.fulfillmentType,
        status:
          p.onHand === 0 ? 'out' :
          p.reorderPoint > 0 && p.onHand <= p.reorderPoint ? 'low' :
          (!p.lastSoldAt || p.lastSoldAt < ninetyDaysAgo) && p.onHand > 0 ? 'dead' :
          'healthy',
      })),
      recentTransactions: recentTxns.map((t) => ({
        id: t.id,
        sku: t.orgVariant.sku,
        productTitle: t.orgVariant.product.title,
        location: t.location.name,
        transactionType: t.transactionType,
        quantity: t.quantity,
        costPerUnit: Number(t.costPerUnit),
        recordedAt: t.recordedAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
