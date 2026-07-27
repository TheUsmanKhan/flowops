import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single customer with recent order history + CRM stats. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active company')

    const { id } = await params
    const customer = await db.customer.findFirst({
      where: { id, organizationId: orgId },
    })
    if (!customer) throw new ApiError(404, 'Customer not found')

    const allOrders = await db.order.findMany({
      where: { customerId: customer.id },
      select: {
        id: true,
        flowopsOrderNumber: true,
        status: true,
        totalOrderValue: true,
        createdAt: true,
        deliveryAddress: true,
        deliveryCity: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })

    // CRM Stats
    const totalOrders = allOrders.length
    const totalDelivered = allOrders.filter((o) => o.status === 'delivered').length
    const totalReturned = allOrders.filter((o) => o.status === 'rto').length
    const deliveryRatio = totalOrders > 0 ? Math.round((totalDelivered / totalOrders) * 10000) / 100 : 0
    const returnRatio = totalOrders > 0 ? Math.round((totalReturned / totalOrders) * 10000) / 100 : 0

    // Address history
    const addressMap = new Map<string, { address: string; city: string; orderCount: number }>()
    for (const o of allOrders) {
      const addr = o.deliveryAddress || ''
      const city = o.deliveryCity || ''
      const key = `${addr}|${city}`
      if (!addressMap.has(key)) {
        addressMap.set(key, { address: addr, city, orderCount: 0 })
      }
      addressMap.get(key)!.orderCount++
    }

    return Response.json({
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        alternatePhone: customer.alternatePhone,
        email: customer.email,
        shippingAddress: JSON.parse(customer.shippingAddress || '{}'),
        billingAddress: JSON.parse(customer.billingAddress || '{}'),
        totalOrdersCount: customer.totalOrdersCount,
        totalOrderValue: Number(customer.totalOrderValue),
        totalRtoCount: customer.totalRtoCount,
        isFlagged: customer.isFlagged,
        flaggedReason: customer.flaggedReason,
        createdAt: customer.createdAt.toISOString(),
      },
      recentOrders: allOrders.slice(0, 20).map((o) => ({
        id: o.id,
        flowopsOrderNumber: o.flowopsOrderNumber,
        status: o.status,
        totalOrderValue: Number(o.totalOrderValue),
        createdAt: o.createdAt.toISOString(),
      })),
      crmStats: {
        totalOrders,
        totalDelivered,
        totalReturned,
        deliveryRatio,
        returnRatio,
        addressHistory: Array.from(addressMap.values()).sort((a, b) => b.orderCount - a.orderCount),
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
