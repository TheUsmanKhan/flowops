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
      })

      if (!createResult.success || !createResult.providerAddressCode) {
        return {
          success: false,
          error: createResult.error || 'Courier API did not return an address code.',
        }
      }
      providerAddressCode = createResult.providerAddressCode
    } else if (adapter.fetchExistingPickupAddresses) {
      // Adapter requires addresses to pre-exist (fetch-only model).
      // In this flow, the user should have selected from fetched addresses
      // via a separate UI — but if they reach here, return a clear error.
      return {
        success: false,
        error: `Provider '${providerKey}' requires addresses to pre-exist. Use the fetch-and-select flow instead of direct creation.`,
      }
    } else {
      // Adapter supports neither — store locally without a courier-side address.
      // This allows the address book to work even for stub adapters.
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

    await insertAuditLog({
      action: 'courier_pickup_address_added',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { label: input.label, cityName: input.cityName, providerAddressCode, isDefault: shouldBeDefault },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      metricKey: 'courier_pickup_address_added',
      numericValue: 1,
      dimensions: { provider_key: providerKey },
    }).catch(() => {})

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

    await insertAuditLog({
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

    await insertAuditLog({
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
