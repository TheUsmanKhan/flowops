import { db } from '@/lib/db'
import { handleError, getWorkspace } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/exchanges/overdue?days_threshold=7 — list overdue exchanges for alerts.
 *
 * Inlined from exchange.actions.ts to avoid loading the 1350-line module
 * (which has deep transitive deps that fail on Hostinger production).
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const daysThreshold = url.searchParams.get('days_threshold')
      ? Number(url.searchParams.get('days_threshold'))
      : 7

    const ctx = await getWorkspace()
    const threshold = new Date(Date.now() - daysThreshold * 86400000)

    const exchanges = await db.orderExchange.findMany({
      where: {
        companyId: ctx.company.id,
        status: {
          in: [
            'awaiting_old_item_return',
            'awaiting_customer_to_ship_old_item',
            'customer_confirmed_shipped',
          ],
        },
        OR: [
          { status: 'awaiting_customer_to_ship_old_item', requestedAt: { lt: threshold } },
          {
            status: 'customer_confirmed_shipped',
            customerConfirmedShippedAt: { lt: threshold },
          },
          { status: 'awaiting_old_item_return', requestedAt: { lt: threshold } },
        ],
      },
      orderBy: { requestedAt: 'asc' },
      include: {
        originalOrder: {
          select: {
            flowopsOrderNumber: true,
            customer: { select: { name: true } },
          },
        },
      },
    })

    const now = Date.now()
    return Response.json({
      exchanges: exchanges.map((e) => {
        const waitingSince =
          e.status === 'customer_confirmed_shipped'
            ? e.customerConfirmedShippedAt ?? e.requestedAt
            : e.requestedAt
        const daysWaiting = Math.floor(
          (now - new Date(waitingSince).getTime()) / 86400000,
        )
        return {
          id: e.id,
          exchangeMethod: e.exchangeMethod,
          status: e.status,
          reason: e.reason,
          requestedAt: e.requestedAt,
          customerConfirmedShippedAt: e.customerConfirmedShippedAt,
          originalOrder: e.originalOrder,
          daysWaiting,
        }
      }),
    })
  } catch (err) {
    return handleError(err)
  }
}
