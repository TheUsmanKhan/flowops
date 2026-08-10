import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter, getEcommerceAdapter, getAdapterCategory } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { markOrderDelivered } from '@/lib/actions/order.actions'
import { processOrderReturn } from '@/lib/actions/order-return.actions'
import { matchOrCreateExternalCustomer } from '@/lib/actions/customer.actions'
import { processLeopardWebhookUpdates } from '@/lib/actions/leopard-webhook.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Generic webhook receiver route.
 *
 * URL format: /api/webhooks/[provider_key]/[webhook_endpoint_id]
 *
 * Flow:
 *   1. Extract provider_key + webhook_endpoint_id from URL
 *   2. Look up company_integrations by webhook_endpoint_id (joined with
 *      provider to confirm provider_key matches) — 404 if no match
 *      (don't leak whether an endpoint ID is valid)
 *   3. Verify webhook authenticity (adapter-specific — stubs skip for now)
 *   4. Route by category:
 *      - courier: parse status webhook → update order status
 *      - ecommerce: parse order webhook → create order
 *   5. Wrap in executeLoggedIntegrationAction (direction='inbound')
 *   6. Always return 200 for processing errors (prevent external retries);
 *      return 404 only for auth/routing failures
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider_key: string; webhook_endpoint_id: string }> },
) {
  const { provider_key: providerKey, webhook_endpoint_id: webhookEndpointId } = await params

  // 1. Look up the company_integration by webhook_endpoint_id
  const integration = await db.companyIntegration.findFirst({
    where: {
      webhookEndpointId,
      isActive: true,
      provider: { providerKey },
    },
    include: { provider: true },
  })

  // 2. If no match, return 404 — don't leak whether the endpoint ID exists
  if (!integration) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // 3. Read the raw body + signature header
  const rawBody = await req.text()
  const signatureHeader = req.headers.get('x-webhook-signature') || req.headers.get('x-shopify-hmac-sha256') || null

  // 4. Decrypt credentials + get adapter
  let credentials: Record<string, string> = {}
  try {
    if (integration.credentialsEncrypted) {
      credentials = decryptCredentials(integration.credentialsEncrypted)
    }
  } catch {
    // Can't decrypt — log + return 200 (don't retry)
    await logWebhookFailure(integration.id, integration.organizationId, 'Failed to decrypt credentials')
    return NextResponse.json({ received: true })
  }

  const category = getAdapterCategory(providerKey)

  // 5. Parse the payload (route by category) — wrap in logging
  try {
    await executeLoggedIntegrationAction({
      companyIntegrationId: integration.id,
      organizationId: integration.organizationId,
      actionType: category === 'courier' ? 'receive_status_webhook' : 'receive_order_webhook',
      direction: 'inbound',
      fn: async () => {
        let rawPayload: unknown
        try {
          rawPayload = JSON.parse(rawBody)
        } catch {
          rawPayload = rawBody
        }

        if (category === 'courier') {
          // Courier status webhook — parse + update order
          const adapter = getCourierAdapter(providerKey, credentials)

          // Verify signature (stub adapters return true)
          const isValid = await adapter.verifyWebhookSignature(rawBody, signatureHeader, integration.webhookSecret || '')
          if (!isValid) {
            throw new Error('Webhook signature verification failed')
          }

          // ── Leopard-specific: process the FULL array of status updates ──
          // Leopard pushes: { "data": [{ cn_number, status, ... }, ...] }
          // The adapter's parseStatusWebhook() returns only the first update
          // (for interface compatibility). processLeopardWebhookUpdates()
          // handles ALL updates in the array, reusing the shared dispatch/
          // delivery/RTO functions.
          if (providerKey === 'leopard') {
            const payload = rawPayload as { data?: Array<{ cn_number: string; status: string; receiver_name?: string; reason?: string; activity_date?: string }> }
            if (payload?.data && Array.isArray(payload.data) && payload.data.length > 0) {
              const result = await processLeopardWebhookUpdates(integration.id, payload.data)
              return { processed: result.data?.processed ?? 0, errors: result.data?.errors ?? [] }
            }
            // Fall through to single-update handling if no data array
          }

          // ── Standard single-update handling (PostEx and other couriers) ──
          const statusUpdate = await adapter.parseStatusWebhook(rawPayload)

          // Find the order by tracking number
          const order = await db.order.findFirst({
            where: { trackingNumber: statusUpdate.trackingNumber },
            select: { id: true, status: true },
          })
          if (!order) {
            throw new Error(`No order found for tracking number ${statusUpdate.trackingNumber}`)
          }

          // Update order status based on the webhook — reuse existing OMS functions
          if (statusUpdate.status === 'delivered' && order.status === 'dispatched') {
            await markOrderDelivered(order.id)
          } else if (statusUpdate.status === 'returned' && order.status !== 'rto') {
            await processOrderReturn(order.id, 'Courier returned (RTO)')
          }

          return { statusUpdate, orderId: order.id }
        } else if (category === 'ecommerce') {
          // Ecommerce order webhook — parse + create order
          const adapter = getEcommerceAdapter(providerKey, credentials)

          // Verify signature
          const isValid = await adapter.verifyWebhookSignature(rawBody, signatureHeader, integration.webhookSecret || '')
          if (!isValid) {
            throw new Error('Webhook signature verification failed')
          }

          const parsed = await adapter.parseWebhookOrder(rawPayload)
          if (!parsed.success || !parsed.parsedOrder) {
            throw new Error(parsed.error || 'Failed to parse order webhook')
          }

          const order = parsed.parsedOrder

          // Match or create the customer via the Customer Management System
          const customerId = await matchOrCreateExternalCustomer({
            platform: providerKey as 'shopify' | 'daraz' | 'instagram',
            external_customer_id: order.externalOrderId,
            phone: order.customerPhone,
            email: order.customerEmail,
            name: order.customerName,
            organizationId: integration.organizationId,
          })

          if (!customerId.success || !customerId.data) {
            throw new Error('Failed to match/create customer from webhook')
          }

          // For now, just log — the actual order creation (createOrderFromShopifyWebhook-style)
          // will be wired when real ecommerce adapters are implemented. The stubs
          // throw "not implemented" before reaching here anyway.
          return { parsedOrder: order, customerId: customerId.data.customerId }
        } else {
          throw new Error(`Unknown provider category for '${providerKey}'`)
        }
      },
    })

    return NextResponse.json({ received: true })
  } catch (err) {
    // Processing error — log it but return 200 to prevent external retries
    console.error(`[webhook] ${providerKey} processing failed:`, err)
    return NextResponse.json({ received: true })
  }
}

/** Helper: log a webhook failure when we can't use the full adapter pipeline */
async function logWebhookFailure(
  companyIntegrationId: string,
  organizationId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await db.integrationActionLog.create({
      data: {
        companyIntegrationId,
        organizationId,
        actionType: 'receive_webhook',
        direction: 'inbound',
        status: 'failed',
        errorMessage,
      },
    })
  } catch (logErr) {
    console.error('[webhook] failed to log failure:', logErr)
  }
}
