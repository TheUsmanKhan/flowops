/**
 * OMS — Customer server actions.
 *
 * Lightweight customer record management (NOT a full CRM). Tracks order
 * history stats and RTO flag for return-fraud detection.
 *
 * Every mutation calls insertAuditLog(). Metric events will be added
 * in a later step (per the OMS build plan).
 */

import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { getWorkspace, requirePermission, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { customerInputSchema, type CustomerInput } from '@/lib/validations/order.schemas'
import type { Prisma } from '@prisma/client'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

interface CustomerFilters {
  search?: string
  isFlagged?: boolean
  limit?: number
  offset?: number
}

// ──────────────────────────────────────────────────────────────
// findOrCreateCustomer
// ──────────────────────────────────────────────────────────────

export async function findOrCreateCustomer(
  input: CustomerInput & { organizationId: string; companyId: string },
): Promise<ActionResult<{ customerId: string; isNewCustomer: boolean }>> {
  try {
    const ctx = await getWorkspace()
    const parsed = customerInputSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid customer data' }
    }
    const d = parsed.data

    // 1. Search by organization + phone
    const existing = await db.customer.findFirst({
      where: {
        organizationId: ctx.company.organizationId,
        phone: d.phone,
      },
    })

    if (existing) {
      // Silently update name if the new value differs (lightweight record,
      // not authoritative CRM data — per the spec)
      const updateData: Prisma.CustomerUncheckedUpdateInput = {}
      if (d.name && d.name !== existing.name) updateData.name = d.name
      if (d.email && d.email !== existing.email) updateData.email = d.email
      if (d.alternate_phone && d.alternate_phone !== existing.alternatePhone) {
        updateData.alternatePhone = d.alternate_phone
      }
      if (d.shipping_address) {
        updateData.shippingAddress = JSON.stringify(d.shipping_address)
      }
      if (d.billing_address) {
        updateData.billingAddress = JSON.stringify(d.billing_address)
      }

      if (Object.keys(updateData).length > 0) {
        await db.customer.update({ where: { id: existing.id }, data: updateData })
      }

      return { success: true, data: { customerId: existing.id, isNewCustomer: false } }
    }

    // 2. Create new customer
    const customer = await db.customer.create({
      data: {
        organizationId: ctx.company.organizationId,
        name: d.name,
        phone: d.phone,
        alternatePhone: d.alternate_phone || null,
        email: d.email || null,
        shippingAddress: JSON.stringify(d.shipping_address),
        billingAddress: JSON.stringify(d.billing_address ?? d.shipping_address),
      },
    })

    await insertAuditLog({
      action: 'customer.created',
      entityType: 'customer',
      entityId: customer.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { name: customer.name, phone: customer.phone },
    })

    return { success: true, data: { customerId: customer.id, isNewCustomer: true } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to find or create customer',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// updateCustomerStats — internal helper, not exposed
// ──────────────────────────────────────────────────────────────

export async function updateCustomerStats(customerId: string): Promise<void> {
  const orders = await db.order.findMany({
    where: { customerId, status: { not: 'cancelled' } },
    select: { totalOrderValue: true, status: true },
  })

  const totalOrdersCount = orders.length
  const totalOrderValue = orders.reduce(
    (sum, o) => sum + Number(o.totalOrderValue),
    0,
  )
  const totalRtoCount = orders.filter((o) => o.status === 'rto').length

  await db.customer.update({
    where: { id: customerId },
    data: { totalOrdersCount, totalOrderValue, totalRtoCount },
  })
}

// ──────────────────────────────────────────────────────────────
// flagCustomer / unflagCustomer
// ──────────────────────────────────────────────────────────────

export async function flagCustomer(
  customerId: string,
  reason: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    await db.customer.update({
      where: { id: customerId },
      data: { isFlagged: true, flaggedReason: reason },
    })

    await insertAuditLog({
      action: 'customer.flagged',
      entityType: 'customer',
      entityId: customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { reason },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'customer',
      entityId: customerId,
      metricKey: 'customer.flagged',
      numericValue: 1,
      dimensions: { reason },
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to flag customer',
    }
  }
}

export async function unflagCustomer(customerId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    await db.customer.update({
      where: { id: customerId },
      data: { isFlagged: false, flaggedReason: null },
    })

    await insertAuditLog({
      action: 'customer.unflagged',
      entityType: 'customer',
      entityId: customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to unflag customer',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// listCustomers
// ──────────────────────────────────────────────────────────────

export async function listCustomers(
  filters: CustomerFilters = {},
): Promise<ActionResult<{
  customers: Array<{
    id: string
    name: string
    phone: string
    email: string | null
    totalOrdersCount: number
    totalOrderValue: number
    totalRtoCount: number
    isFlagged: boolean
    flaggedReason: string | null
    createdAt: Date
  }>
  total: number
}>> {
  try {
    const ctx = await getWorkspace()
    const limit = Math.min(filters.limit ?? 50, 100)
    const offset = filters.offset ?? 0

    const where: Prisma.CustomerWhereInput = {
      organizationId: ctx.company.organizationId,
    }
    if (filters.isFlagged !== undefined) {
      where.isFlagged = filters.isFlagged
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search } },
        { email: { contains: filters.search, mode: 'insensitive' } },
      ]
    }

    const [customers, total] = await Promise.all([
      db.customer.findMany({
        where,
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          totalOrdersCount: true,
          totalOrderValue: true,
          totalRtoCount: true,
          isFlagged: true,
          flaggedReason: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.customer.count({ where }),
    ])

    return {
      success: true,
      data: {
        customers: customers.map((c) => ({
          ...c,
          totalOrderValue: Number(c.totalOrderValue),
        })),
        total,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list customers',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// getCustomerDetail (includes recent order history)
// ──────────────────────────────────────────────────────────────

export async function getCustomerDetail(
  customerId: string,
): Promise<ActionResult<{
  customer: {
    id: string
    name: string
    phone: string
    alternatePhone: string | null
    email: string | null
    shippingAddress: { address: string; city: string }
    billingAddress: { address: string; city: string }
    totalOrdersCount: number
    totalOrderValue: number
    totalRtoCount: number
    isFlagged: boolean
    flaggedReason: string | null
    createdAt: Date
  }
  recentOrders: Array<{
    id: string
    flowopsOrderNumber: string
    status: string
    totalOrderValue: number
    createdAt: Date
  }>
  crmStats: {
    totalOrders: number
    totalDelivered: number
    totalReturned: number
    deliveryRatio: number
    returnRatio: number
    addressHistory: Array<{ address: string; city: string; orderCount: number }>
  }
}>> {
  try {
    const ctx = await getWorkspace()

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    const recentOrders = await db.order.findMany({
      where: { customerId },
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
      take: 20,
    })

    // CRM Stats
    const allOrders = await db.order.findMany({
      where: { customerId },
      select: { status: true, deliveryAddress: true, deliveryCity: true },
    })
    const totalOrders = allOrders.length
    const totalDelivered = allOrders.filter((o) => o.status === 'delivered').length
    const totalReturned = allOrders.filter((o) => o.status === 'rto').length
    const deliveryRatio = totalOrders > 0 ? (totalDelivered / totalOrders) * 100 : 0
    const returnRatio = totalOrders > 0 ? (totalReturned / totalOrders) * 100 : 0

    // Address history: group by delivery address
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

    return {
      success: true,
      data: {
        customer: {
          ...customer,
          totalOrderValue: Number(customer.totalOrderValue),
          shippingAddress: JSON.parse(customer.shippingAddress || '{}'),
          billingAddress: JSON.parse(customer.billingAddress || '{}'),
        },
        recentOrders: recentOrders.map((o) => ({
          ...o,
          totalOrderValue: Number(o.totalOrderValue),
        })),
        crmStats: {
          totalOrders,
          totalDelivered,
          totalReturned,
          deliveryRatio: Math.round(deliveryRatio * 100) / 100,
          returnRatio: Math.round(returnRatio * 100) / 100,
          addressHistory: Array.from(addressMap.values()).sort((a, b) => b.orderCount - a.orderCount),
        },
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get customer detail',
    }
  }
}
