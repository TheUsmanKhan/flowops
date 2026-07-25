import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CustomerAddress {
  label?: string
  address: string
  city: string
  province?: string
  is_default?: boolean
}

/** Get a single customer with recent order history. */
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

    const recentOrders = await db.order.findMany({
      where: { customerId: customer.id },
      select: {
        id: true,
        flowopsOrderNumber: true,
        status: true,
        totalOrderValue: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })

    let addresses: CustomerAddress[] = []
    try {
      addresses = JSON.parse(customer.addresses) as CustomerAddress[]
    } catch {
      addresses = []
    }

    return Response.json({
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        alternatePhone: customer.alternatePhone,
        email: customer.email,
        addresses,
        totalOrdersCount: customer.totalOrdersCount,
        totalOrderValue: Number(customer.totalOrderValue),
        totalRtoCount: customer.totalRtoCount,
        isFlagged: customer.isFlagged,
        flaggedReason: customer.flaggedReason,
        createdAt: customer.createdAt.toISOString(),
      },
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        flowopsOrderNumber: o.flowopsOrderNumber,
        status: o.status,
        totalOrderValue: Number(o.totalOrderValue),
        createdAt: o.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
