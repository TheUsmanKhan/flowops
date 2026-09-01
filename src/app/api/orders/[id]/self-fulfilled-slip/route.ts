import { db } from '@/lib/db'
import { getWorkspace, ApiError, handleError } from '@/lib/workspace'
import { generateInternalSlipPdf, type InternalSlipPdfData } from '@/lib/utils/internal-slip-pdf'
import { promises as fs } from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/orders/[id]/self-fulfilled-slip
 *
 * Generates an internal slip PDF for a self-fulfilled order and returns
 * the PDF as a binary response (not a URL). This avoids 404 issues with
 * static file serving through the Caddy gateway.
 *
 * GUARD: the order must belong to the active company AND have
 * fulfillmentChannel='self_fulfilled'. Returns 400 for courier orders.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { id: orderId } = await params

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phones: { where: { isPrimary: true }, take: 1, select: { phoneRaw: true } },
          },
        },
        items: {
          include: {
            orgVariant: {
              select: { sku: true, product: { select: { title: true } } },
            },
          },
        },
      },
    })
    if (!order) throw new ApiError(404, 'Order not found')

    if (order.fulfillmentChannel !== 'self_fulfilled') {
      throw new ApiError(400, 'Internal slips are only available for self-fulfilled orders.')
    }
    if (!order.selfFulfilledReferenceNumber) {
      throw new ApiError(400, 'Order has no self-fulfilled reference number.')
    }

    // Fetch the company name for the slip header
    const company = await db.company.findUnique({
      where: { id: ctx.company.id },
      select: { name: true },
    })

    const data: InternalSlipPdfData = {
      companyName: company?.name ?? 'Unknown Company',
      flowopsOrderNumber: order.flowopsOrderNumber,
      selfFulfilledReferenceNumber: order.selfFulfilledReferenceNumber,
      customerName: order.customer.name,
      recipientName: order.recipientName,
      deliveryAddress: order.deliveryAddress,
      deliveryCity: order.deliveryCity,
      deliveryCountry: order.deliveryCountry,
      customerPhone: order.customer.phones[0]?.phoneRaw ?? null,
      paymentType: order.paymentType,
      codAmount: order.remainingCodAmount ? Number(order.remainingCodAmount) : (order.paymentType === 'full_cod' ? Number(order.totalOrderValue) : null),
      totalOrderValue: Number(order.totalOrderValue),
      items: order.items.map((item) => ({
        sku: item.orgVariant.sku,
        productTitle: item.orgVariant.product.title,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
      })),
      generatedAt: new Date().toLocaleString('en-PK', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }),
    }

    const urlPath = await generateInternalSlipPdf(data, ctx.company.id)
    if (!urlPath) {
      throw new ApiError(500, 'Failed to generate PDF.')
    }

    // Read the generated PDF file and return it as a binary response
    // (avoids 404 issues with static file serving through the gateway)
    const fullPath = path.join(process.cwd(), 'public', urlPath)
    const pdfBuffer = await fs.readFile(fullPath)

    return new Response(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="slip-${order.selfFulfilledReferenceNumber}.pdf"`,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
