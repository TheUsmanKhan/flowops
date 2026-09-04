/**
 * Courier Pickup/Return Address Book — Server Actions.
 *
 * Manages the per-company-integration address book. PostEx's API returns
 * addressType="Pickup/Return Address" (one address serves both), so we do
 * NOT build separate pickup vs return concepts — one address book serves
 * both purposes for a given companyIntegration.
 *
 * Pattern mirrors integration.actions.ts:
 *   - getWorkspace() for auth + company scoping
 *   - isElevated() for credential-affecting operations
 *   - executeLoggedIntegrationAction() for all adapter calls
 *   - insertAuditLog + insertMetricEvent for observability
 */

import { db } from '@/lib/db'
import { getWorkspace, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import type { PickupAddressInput, PickupAddressResult } from '@/lib/integrations/types'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// Helper: verify integration belongs to caller's company
// ──────────────────────────────────────────────────────────────

async function verifyIntegrationOwnership(companyIntegrationId: string, companyId: string) {
  const integration = await db.companyIntegration.findFirst({
    where: { id: companyIntegrationId, companyId },
    include: { provider: true },
  })
  if (!integration) {
    throw new ApiError(404, 'Integration not found or does not belong to your company.')
  }
  return integration
}

// ──────────────────────────────────────────────────────────────
// listPickupAddresses
// ──────────────────────────────────────────────────────────────

export async function listPickupAddresses(companyIntegrationId: string): Promise<ActionResult<{
  addresses: Array<{
    id: string
    providerAddressCode: string
    label: string
    address: string
    cityName: string
    contactPersonName: string
    phone1: string
    phone2: string | null
    isDefault: boolean
    createdAt: string
  }>
}>> {
  try {
    const ctx = await getWorkspace()
    await verifyIntegrationOwnership(companyIntegrationId, ctx.company.id)

    const addresses = await db.courierPickupAddress.findMany({
      where: { companyIntegrationId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })

    return {
      success: true,
      data: {
        addresses: addresses.map((a) => ({
          id: a.id,
          providerAddressCode: a.providerAddressCode,
          label: a.label,
          address: a.address,
          cityName: a.cityName,
          contactPersonName: a.contactPersonName,
          phone1: a.phone1,
          phone2: a.phone2,
          isDefault: a.isDefault,
          createdAt: a.createdAt.toISOString(),
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list pickup addresses',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// addPickupAddress
// ──────────────────────────────────────────────────────────────

export async function addPickupAddress(
  companyIntegrationId: string,
  input: PickupAddressInput,
): Promise<ActionResult<{ addressId: string }>> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can manage pickup addresses.' }
    }

    const integration = await verifyIntegrationOwnership(companyIntegrationId, ctx.company.id)
    const providerKey = integration.provider.providerKey

    // Check if this is the first address (auto-default)
    const existingCount = await db.courierPickupAddress.count({
      where: { companyIntegrationId },
    })
    const shouldBeDefault = existingCount === 0

    let providerAddressCode: string

    // Try to create the address on the courier's side via the adapter
    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    if (adapter.createPickupAddress) {
      // Adapter supports address creation — call it via the logged wrapper
      const createResult = await executeLoggedIntegrationAction<PickupAddressResult>({
        companyIntegrationId,
        organizationId: integration.organizationId,
        actionType: 'create_pickup_address',
        direction: 'outbound',
        fn: async () => adapter.createPickupAddress!(input),
        // Log the pickup address data being sent (no credentials — just business data)
        requestPayload: input,
      })

      if (!createResult.success) {
        return {
          success: false,
          error: createResult.error || 'Courier API address creation failed.',
        }
      }

      if (createResult.providerAddressCode) {
        // Courier returned an address code directly — use it
        providerAddressCode = createResult.providerAddressCode
      } else if (adapter.fetchExistingPickupAddresses) {
        // PostEx quirk: create-merchant-address returns success but NO
        // addressCode. We need to fetch the full list and find the newly-
        // created address by matching address + city. This is the only
        // way to get the code PostEx assigned.
        const existingAddresses = await executeLoggedIntegrationAction<Array<{
          providerAddressCode: string
          address: string
          cityName: string
        }>>({
          companyIntegrationId,
          organizationId: integration.organizationId,
          actionType: 'fetch_existing_pickup_addresses',
          direction: 'outbound',
          fn: async () => adapter.fetchExistingPickupAddresses!(),
        })

        // Find the matching address by address text + city (case-insensitive)
        const matched = existingAddresses.find(
          (a) =>
            a.address.trim().toLowerCase() === input.address.trim().toLowerCase() &&
            a.cityName.trim().toLowerCase() === input.cityName.trim().toLowerCase(),
        )

        if (!matched) {
          return {
            success: false,
            error: 'Address was created on the courier side, but we could not find it in the address list to get its code. Try syncing addresses instead.',
          }
        }
        providerAddressCode = matched.providerAddressCode
      } else {
        // No way to get the code — store with a local prefix
        providerAddressCode = `local-${Date.now()}`
      }
    } else if (adapter.fetchExistingPickupAddresses) {
      return {
        success: false,
        error: `Provider '${providerKey}' requires addresses to pre-exist. Use the "Sync from Courier" button to import addresses.`,
      }
    } else {
      providerAddressCode = `local-${Date.now()}`
    }

    // Store locally
    const address = await db.courierPickupAddress.create({
      data: {
        companyIntegrationId,
        providerAddressCode,
        label: input.label,
        address: input.address,
        cityName: input.cityName,
        contactPersonName: input.contactPersonName,
        phone1: input.phone1,
        phone2: input.phone2 ?? null,
        isDefault: shouldBeDefault,
      },
    })

    insertAuditLog({
      action: 'courier_pickup_address_added',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { label: input.label, cityName: input.cityName, providerAddressCode, isDefault: shouldBeDefault },
    })

    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      metricKey: 'courier_pickup_address_added',
      numericValue: 1,
      dimensions: { provider_key: providerKey },
    })

    return { success: true, data: { addressId: address.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to add pickup address',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// fetchExistingPickupAddresses (for fetch-only adapters)
// ──────────────────────────────────────────────────────────────

export async function fetchExistingPickupAddresses(
  companyIntegrationId: string,
): Promise<ActionResult<{
  addresses: Array<{
    providerAddressCode: string
    label?: string
    address: string
    cityName: string
    contactPersonName: string
    phone1: string
    phone2?: string
  }>
}>> {
  try {
    const ctx = await getWorkspace()
    const integration = await verifyIntegrationOwnership(companyIntegrationId, ctx.company.id)
    const providerKey = integration.provider.providerKey

    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    if (!adapter.fetchExistingPickupAddresses) {
      return {
        success: false,
        error: `Provider '${providerKey}' does not support fetching existing addresses.`,
      }
    }

    const addresses = await executeLoggedIntegrationAction<Array<{
      providerAddressCode: string
      label?: string
      address: string
      cityName: string
      contactPersonName: string
      phone1: string
      phone2?: string
    }>>({
      companyIntegrationId,
      organizationId: integration.organizationId,
      actionType: 'fetch_existing_pickup_addresses',
      direction: 'outbound',
      fn: async () => adapter.fetchExistingPickupAddresses!(),
    })

    return { success: true, data: { addresses } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to fetch existing pickup addresses',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// importPickupAddressById — import a single shipper by shipment_id
// (Leopard-specific: calls getShipperDetails with request_param=shipment_id
// & request_value={id} to fetch a SINGLE shipper — NOT fetch-all-filter)
// ──────────────────────────────────────────────────────────────

export async function importPickupAddressById(
  companyIntegrationId: string,
  shipmentId: string,
): Promise<ActionResult<{
  addressId: string
  providerAddressCode: string
  label: string
}>> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can import addresses.' }
    }
    const integration = await verifyIntegrationOwnership(companyIntegrationId, ctx.company.id)
    const providerKey = integration.provider.providerKey

    if (providerKey !== 'leopard') {
      return { success: false, error: 'Import by ID is only supported for Leopard Courier.' }
    }

    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    // Use the Leopard-specific fetchShipperById method which calls
    // getShipperDetails?request_param=shipment_id&request_value={id}
    // — this fetches a SINGLE shipper directly (per PDF page 73-78),
    // NOT fetch-all-then-filter.
    // fetchShipperById is NOT on the CourierAdapter interface (it's
    // Leopard-specific), so we cast to access it.
    const leopardAdapter = adapter as unknown as {
      fetchShipperById?: (shipmentId: string) => Promise<{
        providerAddressCode: string
        label: string
        address: string
        cityName: string
        contactPersonName: string
        phone1: string
        phone2?: string
      } | null>
    }
    if (!leopardAdapter.fetchShipperById) {
      return { success: false, error: 'Provider does not support importing by ID.' }
    }

    const found = await executeLoggedIntegrationAction<{
      providerAddressCode: string
      label: string
      address: string
      cityName: string
      contactPersonName: string
      phone1: string
      phone2?: string
    } | null>({
      companyIntegrationId,
      organizationId: integration.organizationId,
      actionType: 'fetch_shipper_by_id',
      direction: 'outbound',
      fn: async () => leopardAdapter.fetchShipperById!(shipmentId),
      requestPayload: { shipment_id: shipmentId },
    })

    if (!found) {
      return { success: false, error: `No shipper found with shipment_id "${shipmentId}".` }
    }

    // Check if this address already exists
    const existing = await db.courierPickupAddress.findFirst({
      where: { companyIntegrationId, providerAddressCode: found.providerAddressCode },
    })
    if (existing) {
      return {
        success: false,
        error: `A shipper with shipment_id "${shipmentId}" already exists in your address book.`,
      }
    }

    // Resolve city name from courier_operational_cities (Leopard returns city_id, not name)
    let cityName = found.cityName
    const cityRecord = await db.courierOperationalCity.findFirst({
      where: { providerKey, cityId: found.cityName },
      select: { cityName: true },
    })
    if (cityRecord) {
      cityName = cityRecord.cityName
    }

    // Create the pickup address
    const address = await db.courierPickupAddress.create({
      data: {
        companyIntegrationId,
        providerAddressCode: found.providerAddressCode,
        label: found.label || `Shipper ${found.providerAddressCode}`,
        address: found.address,
        cityName,
        contactPersonName: found.contactPersonName,
        phone1: found.phone1,
        phone2: found.phone2 ?? null,
        isDefault: false,
      },
    })

    insertAuditLog({
      action: 'pickup_address.imported',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { shipmentId, label: address.label },
    })

    return {
      success: true,
      data: {
        addressId: address.id,
        providerAddressCode: address.providerAddressCode,
        label: address.label,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to import address',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// setDefaultPickupAddress
// ──────────────────────────────────────────────────────────────

export async function setDefaultPickupAddress(
  companyIntegrationId: string,
  addressId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can set default addresses.' }
    }
    await verifyIntegrationOwnership(companyIntegrationId, ctx.company.id)

    // Verify the address belongs to this integration
    const address = await db.courierPickupAddress.findFirst({
      where: { id: addressId, companyIntegrationId },
    })
    if (!address) {
      return { success: false, error: 'Address not found or does not belong to this integration.' }
    }

    // Transaction: unset isDefault on all other addresses, set on this one
    // (same pattern as setDefaultIntegration)
    await db.$transaction([
      db.courierPickupAddress.updateMany({
        where: { companyIntegrationId, id: { not: addressId } },
        data: { isDefault: false },
      }),
      db.courierPickupAddress.update({
        where: { id: addressId },
        data: { isDefault: true },
      }),
    ])

    insertAuditLog({
      action: 'courier_pickup_address_set_default',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { addressId, label: address.label },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to set default pickup address',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// deletePickupAddress
// ──────────────────────────────────────────────────────────────

export async function deletePickupAddress(addressId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can delete pickup addresses.' }
    }

    // Find the address and verify ownership through the integration
    const address = await db.courierPickupAddress.findUnique({
      where: { id: addressId },
      include: { companyIntegration: { select: { companyId: true } } },
    })
    if (!address) {
      return { success: false, error: 'Address not found.' }
    }
    if (address.companyIntegration.companyId !== ctx.company.id) {
      return { success: false, error: 'Address does not belong to your company.' }
    }

    const wasDefault = address.isDefault

    await db.courierPickupAddress.delete({
      where: { id: addressId },
    })

    // If the deleted address was the default, promote the first remaining one
    if (wasDefault) {
      const nextAddress = await db.courierPickupAddress.findFirst({
        where: { companyIntegrationId: address.companyIntegrationId },
        orderBy: { createdAt: 'asc' },
      })
      if (nextAddress) {
        await db.courierPickupAddress.update({
          where: { id: nextAddress.id },
          data: { isDefault: true },
        })
      }
    }

    insertAuditLog({
      action: 'courier_pickup_address_deleted',
      entityType: 'company_integration',
      entityId: address.companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { label: address.label, wasDefault },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to delete pickup address',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// syncPickupAddresses — fetch all from courier + upsert locally
// ──────────────────────────────────────────────────────────────

export async function syncPickupAddresses(
  companyIntegrationId: string,
): Promise<ActionResult<{
  fetched: number
  upserted: number
}>> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can sync pickup addresses.' }
    }

    const integration = await verifyIntegrationOwnership(companyIntegrationId, ctx.company.id)
    const providerKey = integration.provider.providerKey

    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    if (!adapter.fetchExistingPickupAddresses) {
      return {
        success: false,
        error: `Provider '${providerKey}' does not support fetching existing addresses.`,
      }
    }

    // Fetch all addresses from the courier
    const remoteAddresses = await executeLoggedIntegrationAction<Array<{
      providerAddressCode: string
      label?: string
      address: string
      cityName: string
      contactPersonName: string
      phone1: string
      phone2?: string
    }>>({
      companyIntegrationId,
      organizationId: integration.organizationId,
      actionType: 'fetch_existing_pickup_addresses',
      direction: 'outbound',
      fn: async () => adapter.fetchExistingPickupAddresses!(),
    })

    // Fetch existing local addresses for this integration (to detect new vs existing)
    const existingLocal = await db.courierPickupAddress.findMany({
      where: { companyIntegrationId },
      select: { id: true, providerAddressCode: true, isDefault: true },
    })
    const existingCodes = new Set(existingLocal.map((a) => a.providerAddressCode))
    const isFirstSync = existingLocal.length === 0

    // Upsert each remote address locally
    let upserted = 0
    for (const remote of remoteAddresses) {
      if (existingCodes.has(remote.providerAddressCode)) {
        // Update existing address (keep isDefault as-is)
        await db.courierPickupAddress.updateMany({
          where: { companyIntegrationId, providerAddressCode: remote.providerAddressCode },
          data: {
            label: remote.label || remote.address.substring(0, 50),
            address: remote.address,
            cityName: remote.cityName,
            contactPersonName: remote.contactPersonName,
            phone1: remote.phone1,
            phone2: remote.phone2 ?? null,
          },
        })
      } else {
        // Create new address
        await db.courierPickupAddress.create({
          data: {
            companyIntegrationId,
            providerAddressCode: remote.providerAddressCode,
            label: remote.label || remote.address.substring(0, 50),
            address: remote.address,
            cityName: remote.cityName,
            contactPersonName: remote.contactPersonName,
            phone1: remote.phone1,
            phone2: remote.phone2 ?? null,
            // Auto-default the first address on initial sync
            isDefault: isFirstSync && upserted === 0,
          },
        })
      }
      upserted++
    }

    insertAuditLog({
      action: 'courier_pickup_addresses_synced',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { fetched: remoteAddresses.length, upserted },
    })

    return {
      success: true,
      data: { fetched: remoteAddresses.length, upserted },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to sync pickup addresses',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// refreshAllPickupAddresses — re-fetch each EXISTING local shipper's
// details from Leopard by their stored shipment_id, and update the
// local record if anything changed (name, address, phone, city).
//
// This is DIFFERENT from sync (which fetches ALL remote shippers and
// imports new ones). Refresh only updates shippers that are ALREADY
// in the local address book — it does NOT add new ones. Use Import
// by ID to add new shippers.
// ──────────────────────────────────────────────────────────────

export async function refreshAllPickupAddresses(
  companyIntegrationId: string,
): Promise<ActionResult<{
  refreshed: number
  updated: number
  errors: string[]
}>> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can refresh addresses.' }
    }

    const integration = await verifyIntegrationOwnership(companyIntegrationId, ctx.company.id)
    const providerKey = integration.provider.providerKey

    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    // fetchShipperById is Leopard-specific (not on the CourierAdapter interface)
    const leopardAdapter = adapter as unknown as {
      fetchShipperById?: (shipmentId: string) => Promise<{
        providerAddressCode: string
        label: string
        address: string
        cityName: string
        contactPersonName: string
        phone1: string
        phone2?: string
      } | null>
    }

    if (providerKey === 'leopard' && !leopardAdapter.fetchShipperById) {
      return { success: false, error: 'Leopard adapter does not support fetchShipperById.' }
    }

    // Load all locally-stored shippers for this integration
    const localAddresses = await db.courierPickupAddress.findMany({
      where: { companyIntegrationId },
    })

    if (localAddresses.length === 0) {
      return {
        success: true,
        data: { refreshed: 0, updated: 0, errors: [] },
      }
    }

    let updated = 0
    const errors: string[] = []

    for (const local of localAddresses) {
      try {
        // Use fetchShipperById (Leopard) or fall back to fetchExistingPickupAddresses
        // for other providers (none currently, but future-proof)
        let remote: {
          label: string
          address: string
          cityName: string
          contactPersonName: string
          phone1: string
          phone2?: string
        } | null = null

        if (providerKey === 'leopard' && leopardAdapter.fetchShipperById) {
          remote = await executeLoggedIntegrationAction<{
            providerAddressCode: string
            label: string
            address: string
            cityName: string
            contactPersonName: string
            phone1: string
            phone2?: string
          } | null>({
            companyIntegrationId,
            organizationId: integration.organizationId,
            actionType: 'refresh_shipper_by_id',
            direction: 'outbound',
            fn: async () => leopardAdapter.fetchShipperById!(local.providerAddressCode),
            requestPayload: { shipment_id: local.providerAddressCode },
          })
        }

        if (!remote) {
          errors.push(`Shipper ${local.providerAddressCode} (${local.label}): not found on Leopard.`)
          continue
        }

        // Resolve city name from courier_operational_cities
        let cityName = remote.cityName
        const cityRecord = await db.courierOperationalCity.findFirst({
          where: { providerKey, cityId: remote.cityName },
          select: { cityName: true },
        })
        if (cityRecord) {
          cityName = cityRecord.cityName
        }

        // Check if anything actually changed (avoid unnecessary writes)
        const changed =
          local.label !== (remote.label || local.label) ||
          local.address !== remote.address ||
          local.cityName !== cityName ||
          local.contactPersonName !== remote.contactPersonName ||
          local.phone1 !== remote.phone1 ||
          (local.phone2 ?? null) !== (remote.phone2 ?? null)

        if (changed) {
          await db.courierPickupAddress.update({
            where: { id: local.id },
            data: {
              label: remote.label || local.label,
              address: remote.address,
              cityName,
              contactPersonName: remote.contactPersonName,
              phone1: remote.phone1,
              phone2: remote.phone2 ?? null,
            },
          })
          updated++
        }
      } catch (e) {
        errors.push(
          `Shipper ${local.providerAddressCode} (${local.label}): ${e instanceof Error ? e.message : 'fetch failed'}`,
        )
      }
    }

    const refreshed = localAddresses.length

    insertAuditLog({
      action: 'courier_pickup_addresses_refreshed',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { refreshed, updated, errors: errors.length },
    })

    return {
      success: true,
      data: { refreshed, updated, errors },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to refresh pickup addresses',
    }
  }
}
