import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, handleError, getWorkspace } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/booking-workbench/activity?date_from=&date_to=
 *
 * Returns a merged list of all booked orders + exchange shipments for the
 * Booking Activity report. Read-only.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getWorkspace()
    const companyId = ctx.company.id

    const { searchParams } = new URL(req.url)
    const dateFrom = searchParams.get('date_from')
    const dateTo = searchParams.get('date_to')

    const dateFilter: { gte?: Date; lte?: Date } = {}
    if (dateFrom) dateFilter.gte = new Date(dateFrom)
    if (dateTo) {
      const end = new Date(dateTo)
      end.setHours(23, 59, 59, 999)
      dateFilter.lte = end
    }

    // ── Booked Orders ──
    const bookedOrders = await db.order.findMany({
      where: {
        companyId,
        courierBookingStatus: 'booked',
        ...(Object.keys(dateFilter).length > 0
          ? { dispatchedAt: dateFilter }
          : {}),
      },
      select: {
        id: true,
        flowopsOrderNumber: true,
        trackingNumber: true,
        courierName: true,
        courierCompanyIntegrationId: true,
        courierSubStatus: true,
        dispatchedAt: true,
        createdBy: true,
      },
      orderBy: { dispatchedAt: 'desc' },
    })

    // ── Booked Exchange Shipments ──
    const bookedShipments = await db.exchangeShipment.findMany({
      where: {
        companyId,
        courierBookingStatus: 'booked',
        ...(Object.keys(dateFilter).length > 0
          ? { dispatchedAt: dateFilter }
          : {}),
      },
      select: {
        id: true,
        exchangeShipmentNumber: true,
        trackingNumber: true,
        courierCompanyIntegrationId: true,
        courierSubStatus: true,
        dispatchedAt: true,
        createdBy: true,
      },
      orderBy: { dispatchedAt: 'desc' },
    })

    // ── Fetch courier integration names ──
    const allIntegrationIds = new Set<string>()
    bookedOrders.forEach((o) => { if (o.courierCompanyIntegrationId) allIntegrationIds.add(o.courierCompanyIntegrationId) })
    bookedShipments.forEach((s) => { if (s.courierCompanyIntegrationId) allIntegrationIds.add(s.courierCompanyIntegrationId) })

    const integrations = await db.companyIntegration.findMany({
      where: { id: { in: Array.from(allIntegrationIds) } },
      include: { provider: { select: { providerName: true } } },
    })
    const integrationMap = new Map(integrations.map((i) => [i.id, i.provider.providerName]))

    // ── Fetch employee names for booked-by ──
    const allEmployeeIds = new Set<string>()
    bookedOrders.forEach((o) => { if (o.createdBy) allEmployeeIds.add(o.createdBy) })
    bookedShipments.forEach((s) => { if (s.createdBy) allEmployeeIds.add(s.createdBy) })

    const employees = await db.employee.findMany({
      where: { id: { in: Array.from(allEmployeeIds) } },
      include: { user: { select: { fullName: true } } },
    })
    const employeeMap = new Map(employees.map((e) => [e.id, e.user.fullName]))

    // ── Merge into combined activity list ──
    const activity = [
      ...bookedOrders.map((o) => ({
        id: o.id,
        type: 'order' as const,
        referenceNumber: o.flowopsOrderNumber,
        courierName: integrationMap.get(o.courierCompanyIntegrationId ?? '') ?? o.courierName ?? 'Unknown',
        trackingNumber: o.trackingNumber ?? '',
        bookedAt: o.dispatchedAt?.toISOString() ?? '',
        bookedBy: employeeMap.get(o.createdBy ?? '') ?? 'Unknown',
        courierSubStatus: o.courierSubStatus,
      })),
      ...bookedShipments.map((s) => ({
        id: s.id,
        type: 'exchange_shipment' as const,
        referenceNumber: s.exchangeShipmentNumber,
        courierName: integrationMap.get(s.courierCompanyIntegrationId ?? '') ?? 'Unknown',
        trackingNumber: s.trackingNumber ?? '',
        bookedAt: s.dispatchedAt?.toISOString() ?? '',
        bookedBy: employeeMap.get(s.createdBy ?? '') ?? 'Unknown',
        courierSubStatus: s.courierSubStatus,
      })),
    ].sort((a, b) => new Date(b.bookedAt).getTime() - new Date(a.bookedAt).getTime())

    // ── Summary by courier ──
    const summary: Record<string, number> = {}
    for (const a of activity) {
      summary[a.courierName] = (summary[a.courierName] ?? 0) + 1
    }

    return Response.json({ activity, summary })
  } catch (err) {
    return handleError(err)
  }
}
