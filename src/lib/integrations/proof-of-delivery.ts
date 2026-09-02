/**
 * Proof of Delivery — shared utility for fetching and storing EPOD data.
 *
 * When an order/exchange-shipment reaches 'delivered' status via a Leopard
 * webhook or safety-net poll, this utility is called to:
 *   1. Call the adapter's getElectronicProofOfDelivery() (Leopard-specific)
 *   2. Download the Sig_Url (signature image) and store our own copy
 *   3. Populate the entity's proofOfDeliveryData JSONB field
 *
 * NON-FATAL: if the POD fetch fails, the delivery-status transition itself
 * still succeeds. Only the POD-fetch failure is logged separately.
 */

import { db } from '@/lib/db'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import fs from 'fs/promises'
import path from 'path'

interface ProofOfDeliveryData {
  signatureUrl?: string  // Our own stored path (e.g. /uploads/pod/<companyId>/sig-<id>.png)
  photoUrl?: string      // Our own stored path (if a photo URL is also available)
  recipientName?: string
  deliveredAt?: string
  rawResponse?: unknown
}

/**
 * Fetch and store Proof of Delivery for a delivered entity.
 *
 * @param entityType - 'order' | 'exchange_shipment'
 * @param entityId - The entity ID
 * @param companyId - For file storage path
 * @param companyIntegrationId - To decrypt credentials + get the adapter
 * @param trackingNumber - The courier tracking number
 * @param providerKey - Must be 'leopard' (only provider with EPOD support)
 * @param deliveredAt - When the delivery was recorded
 *
 * NON-FATAL: if any step fails, logs the error and returns without updating
 * the entity. The delivery-status transition itself is not affected.
 */
export async function fetchAndStoreProofOfDelivery(params: {
  entityType: 'order' | 'exchange_shipment'
  entityId: string
  companyId: string
  companyIntegrationId: string
  trackingNumber: string
  providerKey: string
  deliveredAt: Date
}): Promise<void> {
  const { entityType, entityId, companyId, companyIntegrationId, trackingNumber, providerKey, deliveredAt } = params

  try {
    // Only Leopard supports EPOD
    if (providerKey !== 'leopard') return

    // Fetch the integration + decrypt credentials
    const integration = await db.companyIntegration.findUnique({
      where: { id: companyIntegrationId },
      select: { credentialsEncrypted: true, organizationId: true },
    })
    if (!integration?.credentialsEncrypted) return

    const credentials = decryptCredentials(integration.credentialsEncrypted)
    const adapter = getCourierAdapter(providerKey, credentials)

    // Check if the adapter supports EPOD
    const epodAdapter = adapter as unknown as {
      getElectronicProofOfDelivery?: (tn: string) => Promise<{
        success: boolean
        data?: {
          signatureUrl?: string
          receiverName?: string
          relation?: string
          city?: string
          arrivalDate?: string
          activity?: string
          latitude?: string
          longitude?: string
          rawResponse?: unknown
        }
        error?: string
      }>
    }
    if (typeof epodAdapter.getElectronicProofOfDelivery !== 'function') return

    // Call the EPOD API
    const epodResult = await epodAdapter.getElectronicProofOfDelivery(trackingNumber)
    if (!epodResult.success || !epodResult.data) {
      console.log(`[pod] EPOD not available for ${trackingNumber}: ${epodResult.error ?? 'no data'}`)
      return
    }

    const podData: ProofOfDeliveryData = {
      recipientName: epodResult.data.receiverName,
      deliveredAt: deliveredAt.toISOString(),
      rawResponse: epodResult.data.rawResponse,
    }

    // Download the signature image if available
    if (epodResult.data.signatureUrl) {
      try {
        const sigPath = await downloadAndStoreFile(
          epodResult.data.signatureUrl,
          companyId,
          `pod-sig-${entityId}-${Date.now()}`,
        )
        if (sigPath) {
          podData.signatureUrl = sigPath
        }
      } catch (e) {
        console.error(`[pod] Failed to download signature for ${trackingNumber}:`, e)
      }
    }

    // Store the POD data on the entity
    const podJson = JSON.stringify(podData)
    if (entityType === 'order') {
      await db.order.update({
        where: { id: entityId },
        data: { proofOfDeliveryData: podJson },
      })
    } else {
      await db.exchangeShipment.update({
        where: { id: entityId },
        data: { proofOfDeliveryData: podJson },
      })
    }

    console.log(`[pod] EPOD stored for ${entityType} ${entityId} (${trackingNumber})`)
  } catch (err) {
    // NON-FATAL — log and return. The delivery status transition is not affected.
    console.error(`[pod] Failed to fetch/store EPOD for ${trackingNumber}:`, err)
  }
}

/**
 * Download a file from a URL and store it in our /uploads/pod/ directory.
 * Returns the relative path (e.g. /uploads/pod/<companyId>/<filename>.png)
 * or null if the download failed.
 */
async function downloadAndStoreFile(
  url: string,
  companyId: string,
  filenameBase: string,
): Promise<string | null> {
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`[pod] File download failed: HTTP ${response.status}`)
    return null
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Determine file extension from content-type
  const contentType = response.headers.get('content-type') ?? ''
  let ext = '.png'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg'
  else if (contentType.includes('png')) ext = '.png'
  else if (contentType.includes('gif')) ext = '.gif'
  else if (contentType.includes('pdf')) ext = '.pdf'

  const dir = path.join(process.cwd(), 'public', 'uploads', 'pod', companyId)
  await fs.mkdir(dir, { recursive: true })
  const filename = `${filenameBase}${ext}`
  const filepath = path.join(dir, filename)
  await fs.writeFile(filepath, buffer)

  return `/uploads/pod/${companyId}/${filename}`
}
