/**
 * City Sync Job — Provider-Agnostic.
 *
 * Syncs the global courier_operational_cities cache from any courier adapter
 * that implements the optional fetchOperationalCities() method.
 *
 * Cities are provider-level (not company-level), so one merchant's token is
 * enough to fetch the shared city list for a provider. The sync job looks up
 * ANY active company_integration for that providerKey to get credentials.
 *
 * SCHEDULING: This function is exported and ready to be triggered by a
 * scheduler every 3 hours. Infrastructure-level scheduling (cron job,
 * Vercel Cron, external scheduler) still needs to be connected — same
 * pattern as the PostEx bulk-tracking poll function in a separate prior task.
 * Until then, it can be triggered manually via POST /api/couriers/sync-cities.
 */

import { db } from '@/lib/db'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import type { OperationalCity } from '@/lib/integrations/types'

interface SyncResult {
  success: boolean
  providerKey: string
  fetchedCount: number
  upsertedCount: number
  disabledCount: number
  error?: string
}

/**
 * Sync operational cities for a given courier provider.
 *
 * Looks up ANY active company_integration for that providerKey (cities are
 * provider-level, not company-level, so one merchant's token is enough).
 *
 * Behavior:
 *   1. Gets the adapter via the registry, calls fetchOperationalCities().
 *   2. Upserts results into courier_operational_cities by (providerKey, cityName),
 *      updating lastSyncedAt.
 *   3. If a city that was previously cached is no longer in the fresh response,
 *      marks it (does NOT delete) by setting isPickupCity=false AND
 *      isDeliveryCity=false — historical references aren't broken, but it
 *      stops being offered/matched going forward.
 */
export async function syncCourierOperationalCities(providerKey: string): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    providerKey,
    fetchedCount: 0,
    upsertedCount: 0,
    disabledCount: 0,
  }

  try {
    // Find ANY active company_integration for this provider
    const integration = await db.companyIntegration.findFirst({
      where: {
        isActive: true,
        provider: { providerKey },
        credentialsEncrypted: { not: null },
      },
      include: { provider: true },
    })

    if (!integration) {
      result.error = `No active company integration found for provider '${providerKey}'. Connect at least one ${providerKey} integration to sync cities.`
      return result
    }

    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    // Check if the adapter supports fetchOperationalCities (optional capability)
    if (!adapter.fetchOperationalCities) {
      result.error = `Adapter for '${providerKey}' does not support fetchOperationalCities().`
      return result
    }

    // Fetch cities via the logged wrapper (so the API call is logged)
    // For Leopard, also fetch the raw city list with shipment_type arrays
    // (the standard OperationalCity type doesn't include shipmentTypes).
    const isLeopard = providerKey === 'leopard'

    let leopardRawCities: Array<{ id: number; name: string; shipment_type: string[]; allow_as_origin: boolean; allow_as_destination: boolean }> | null = null

    if (isLeopard && typeof (adapter as { fetchOperationalCitiesRaw?: () => Promise<unknown> }).fetchOperationalCitiesRaw === 'function') {
      // Fetch raw cities with shipment_type arrays (Leopard-specific)
      leopardRawCities = await executeLoggedIntegrationAction<typeof leopardRawCities>({
        companyIntegrationId: integration.id,
        organizationId: integration.organizationId,
        actionType: 'fetch_operational_cities',
        direction: 'outbound',
        fn: async () => (adapter as { fetchOperationalCitiesRaw: () => Promise<typeof leopardRawCities> }).fetchOperationalCitiesRaw(),
      })
    }

    const cities = await executeLoggedIntegrationAction<OperationalCity[]>({
      companyIntegrationId: integration.id,
      organizationId: integration.organizationId,
      actionType: 'fetch_operational_cities',
      direction: 'outbound',
      fn: async () => adapter.fetchOperationalCities!(),
    })

    result.fetchedCount = cities.length

    // Build a map of cityName → shipmentTypes JSON string (Leopard only)
    const shipmentTypesMap = new Map<string, string>()
    if (leopardRawCities) {
      for (const rc of leopardRawCities) {
        if (rc.shipment_type && Array.isArray(rc.shipment_type)) {
          shipmentTypesMap.set(rc.name, JSON.stringify(rc.shipment_type))
        }
      }
    }

    // Fetch currently-cached cities for this provider (to detect disabled ones)
    const existingCities = await db.courierOperationalCity.findMany({
      where: { providerKey },
      select: { id: true, cityName: true, isPickupCity: true, isDeliveryCity: true },
    })
    const existingMap = new Map(existingCities.map((c) => [c.cityName, c]))
    const freshCityNames = new Set(cities.map((c) => c.cityName))

    // Upsert each fresh city — batched in a single transaction for performance
    const now = new Date()
    await db.$transaction(
      cities.map((city) =>
        db.courierOperationalCity.upsert({
          where: {
            providerKey_cityName: { providerKey, cityName: city.cityName },
          },
          update: {
            cityId: city.cityId ?? null,
            isPickupCity: city.isPickupCity,
            isDeliveryCity: city.isDeliveryCity,
            // Leopard-specific: persist shipmentTypes if available
            ...(shipmentTypesMap.has(city.cityName) ? { shipmentTypes: shipmentTypesMap.get(city.cityName) } : {}),
            lastSyncedAt: now,
          },
          create: {
            providerKey,
            cityName: city.cityName,
            cityId: city.cityId ?? null,
            isPickupCity: city.isPickupCity,
            isDeliveryCity: city.isDeliveryCity,
            // Leopard-specific: persist shipmentTypes if available
            ...(shipmentTypesMap.has(city.cityName) ? { shipmentTypes: shipmentTypesMap.get(city.cityName) } : {}),
            lastSyncedAt: now,
          },
        }),
      ),
    )
    result.upsertedCount = cities.length

    // Disable cities that were cached but are no longer in the fresh response
    // — also batched in a transaction
    const toDisable = existingCities.filter(
      (e) => !freshCityNames.has(e.cityName) && (e.isPickupCity || e.isDeliveryCity),
    )
    if (toDisable.length > 0) {
      await db.$transaction(
        toDisable.map((e) =>
          db.courierOperationalCity.update({
            where: { id: e.id },
            data: {
              isPickupCity: false,
              isDeliveryCity: false,
              lastSyncedAt: now,
            },
          }),
        ),
      )
    }
    result.disabledCount = toDisable.length

    // Audit + metric (non-fatal)
    insertAuditLog({
      action: 'courier_cities_synced',
      entityType: 'company_integration',
      entityId: integration.id,
      companyId: integration.companyId,
      organizationId: integration.organizationId,
      newValues: {
        providerKey,
        fetchedCount: result.fetchedCount,
        upsertedCount: result.upsertedCount,
        disabledCount: result.disabledCount,
      },
    })

    insertMetricEvent({
      companyId: integration.companyId,
      entityType: 'company_integration',
      entityId: integration.id,
      metricKey: 'courier_cities_synced',
      numericValue: result.upsertedCount,
      dimensions: { provider_key: providerKey, disabled: result.disabledCount },
    })

    result.success = true
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Failed to sync courier cities'
    console.error(`[city-sync] Failed for ${providerKey}:`, err)
    return result
  }
}

/**
 * Sync cities for ALL providers that have at least one active integration.
 * Intended to be called by the scheduled job every 3 hours.
 *
 * SCHEDULING NOTE: Infrastructure-level scheduling (cron, Vercel Cron, etc.)
 * still needs to be connected. This function is the entry point — wire it
 * to whatever scheduler this project ends up using. Same pattern as the
 * PostEx bulk-tracking poll function.
 */
export async function syncAllCourierCities(): Promise<SyncResult[]> {
  // Get all distinct providerKeys that have active courier integrations
  const integrations = await db.companyIntegration.findMany({
    where: {
      isActive: true,
      credentialsEncrypted: { not: null },
      provider: { category: 'courier' },
    },
    select: { provider: { select: { providerKey: true } } },
    distinct: ['providerId'],
  })

  const providerKeys = [...new Set(integrations.map((i) => i.provider.providerKey))]
  const results: SyncResult[] = []

  for (const providerKey of providerKeys) {
    const res = await syncCourierOperationalCities(providerKey)
    results.push(res)
  }

  return results
}
