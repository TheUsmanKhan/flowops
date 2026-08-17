/**
 * Integration Framework — server actions.
 *
 * Credential management for company integrations: list available providers,
 * list/ connect/ update/ disconnect/ set-default/ test-connection.
 *
 * CRITICAL RULES:
 *   1. Never return credentials_encrypted (even encrypted) to the client.
 *   2. All adapter calls go through executeLoggedIntegrationAction().
 *   3. Connecting/configuring integrations is elevated-only (involves credentials).
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import {
  encryptCredentials,
  decryptCredentials,
  generateWebhookEndpointId,
  generateWebhookSecret,
} from '@/lib/utils/encryption'
import { getCourierAdapter, getEcommerceAdapter, getAdapterCategory, getAdapterStatus } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// listAvailableProviders
// ──────────────────────────────────────────────────────────────

export async function listAvailableProviders(category?: 'courier' | 'ecommerce'): Promise<ActionResult<{
  providers: Array<{
    id: string
    providerKey: string
    providerName: string
    category: string
    logoUrl: string | null
    authType: string
    supportsWebhook: boolean
    configSchema: string
    capabilities: string
    adapterStatus: string // 'live' | 'framework_ready' | 'stub' — from registry
  }>
}>> {
  try {
    const ctx = await getWorkspace()
    const where: { category?: string; isActive: boolean } = { isActive: true }
    if (category) where.category = category

    const providers = await db.integrationProvider.findMany({
      where,
      orderBy: { category: 'asc' },
    })

    return {
      success: true,
      data: {
        providers: providers.map((p) => ({
          id: p.id,
          providerKey: p.providerKey,
          providerName: p.providerName,
          category: p.category,
          logoUrl: p.logoUrl,
          authType: p.authType,
          supportsWebhook: p.supportsWebhook,
          configSchema: p.configSchema,
          capabilities: p.capabilities,
          adapterStatus: getAdapterStatus(p.providerKey),
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list providers',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// listCompanyIntegrations
// ──────────────────────────────────────────────────────────────

export async function listCompanyIntegrations(category?: 'courier' | 'ecommerce'): Promise<ActionResult<{
  integrations: Array<{
    id: string
    connectionName: string
    isActive: boolean
    isDefault: boolean
    connectionStatus: string
    lastSyncAt: Date | null
    lastError: string | null
    webhookEndpointId: string | null
    webhookUrl: string | null
    createdAt: Date
    provider: {
      id: string
      providerKey: string
      providerName: string
      category: string
      logoUrl: string | null
      authType: string
      supportsWebhook: boolean
    }
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const integrations = await db.companyIntegration.findMany({
      where: {
        companyId: ctx.company.id,
        ...(category ? { provider: { category } } : {}),
      },
      include: {
        provider: {
          select: {
            id: true,
            providerKey: true,
            providerName: true,
            category: true,
            logoUrl: true,
            authType: true,
            supportsWebhook: true,
            configSchema: true, // needed by ReconnectDialog to render credential fields
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    const appUrl = process.env.APP_URL || 'http://localhost:3000'

    return {
      success: true,
      data: {
        integrations: integrations.map((i) => ({
          id: i.id,
          connectionName: i.connectionName,
          isActive: i.isActive,
          isDefault: i.isDefault,
          connectionStatus: i.connectionStatus,
          lastSyncAt: i.lastSyncAt,
          lastError: i.lastError,
          webhookEndpointId: i.webhookEndpointId,
          webhookUrl: i.webhookEndpointId
            ? `${appUrl}/api/webhooks/${i.provider.providerKey}/${i.webhookEndpointId}`
            : null,
          createdAt: i.createdAt,
          provider: i.provider,
          // NOTE: credentialsEncrypted is intentionally EXCLUDED — never
          // send encrypted credentials to the client, even encrypted.
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list integrations',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// connectIntegration
// ──────────────────────────────────────────────────────────────

export async function connectIntegration(input: {
  providerId: string
  connectionName: string
  credentials: Record<string, string>
}): Promise<ActionResult<{
  companyIntegrationId: string
  webhookUrl?: string
}>> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles (Owner/Founder/Co-Founder/Investor) can configure integrations.' }
    }

    // Fetch the provider to get config_schema + supports_webhook
    const provider = await db.integrationProvider.findUnique({
      where: { id: input.providerId },
    })
    if (!provider) return { success: false, error: 'Provider not found' }

    // Validate required credential fields from config_schema
    let configFields: Array<{ key: string; label: string; type: string; required: boolean }> = []
    try {
      configFields = JSON.parse(provider.configSchema)
    } catch {
      return { success: false, error: 'Provider config_schema is invalid' }
    }

    for (const field of configFields) {
      if (field.required) {
        const value = input.credentials[field.key]
        if (!value || !value.trim()) {
          return { success: false, error: `Missing required field: ${field.label}` }
        }
      }
    }

    // Encrypt credentials
    const credentialsEncrypted = encryptCredentials(input.credentials)

    // ── Find-or-reactivate ──
    // If there's an EXISTING integration for this provider + company
    // (including disconnected ones), reactivate it with the new credentials.
    // This gives users a clean "connect from scratch" experience after
    // disconnecting — the provider appears in "Available to Connect",
    // they click Connect, enter new credentials, and the old row is
    // reactivated (preserving audit history) instead of creating a duplicate.
    const existing = await db.companyIntegration.findFirst({
      where: { companyId: ctx.company.id, providerId: input.providerId },
      select: { id: true, isActive: true },
    })

    let integration: { id: string }
    let webhookEndpointId: string | null = null
    let isNewConnection = false

    if (existing) {
      // Reactivate the existing integration with new credentials.
      // Generate new webhook endpoint ID + secret if the provider supports
      // webhooks and the old ones were wiped on disconnect.
      let webhookSecret: string | null = null
      if (provider.supportsWebhook) {
        webhookEndpointId = generateWebhookEndpointId()
        webhookSecret = generateWebhookSecret()
      }

      integration = await db.companyIntegration.update({
        where: { id: existing.id },
        data: {
          connectionName: input.connectionName,
          credentialsEncrypted,
          isActive: true,
          connectionStatus: 'pending',
          lastError: null,
          webhookEndpointId,
          webhookSecret,
        },
        select: { id: true },
      })

      insertAuditLog({
        action: existing.isActive ? 'integration.credentials_updated' : 'integration.reconnected',
        entityType: 'company_integration',
        entityId: integration.id,
        companyId: ctx.company.id,
        organizationId: ctx.company.organizationId,
        userId: ctx.user.id,
        employeeId: ctx.employee.id,
        newValues: {
          provider: provider.providerKey,
          connectionName: input.connectionName,
          supportsWebhook: provider.supportsWebhook,
        },
      })
    } else {
      // No existing integration — create a fresh one.
      let webhookSecret: string | null = null
      if (provider.supportsWebhook) {
        webhookEndpointId = generateWebhookEndpointId()
        webhookSecret = generateWebhookSecret()
      }

      try {
        integration = await db.companyIntegration.create({
          data: {
            companyId: ctx.company.id,
            organizationId: ctx.company.organizationId,
            providerId: input.providerId,
            connectionName: input.connectionName,
            credentialsEncrypted,
            webhookEndpointId,
            webhookSecret,
            connectionStatus: 'pending',
            createdBy: ctx.employee.id,
          },
          select: { id: true },
        })
        isNewConnection = true

        insertAuditLog({
          action: 'integration.connected',
          entityType: 'company_integration',
          entityId: integration.id,
          companyId: ctx.company.id,
          organizationId: ctx.company.organizationId,
          userId: ctx.user.id,
          employeeId: ctx.employee.id,
          newValues: {
            provider: provider.providerKey,
            connectionName: input.connectionName,
            supportsWebhook: provider.supportsWebhook,
          },
        })
      } catch (createErr: unknown) {
        // Catch the @@unique([companyId, providerId]) constraint violation.
        // This means another concurrent request just created this integration
        // (genuine race between two different sessions — the idempotency key
        // system only protects same-session double-clicks). Re-fetch the
        // now-existing row and run the same reactivation logic as the
        // findFirst-then-update path above.
        if (
          createErr &&
          typeof createErr === 'object' &&
          'code' in createErr &&
          (createErr as { code: string }).code === 'P2002'
        ) {
          // Re-fetch the row the winner created
          const raceExisting = await db.companyIntegration.findFirst({
            where: { companyId: ctx.company.id, providerId: input.providerId },
            select: { id: true, isActive: true },
          })
          if (!raceExisting) {
            // Extremely unlikely: the row was deleted between the constraint
            // violation and this re-fetch. Let the error propagate.
            throw createErr
          }
          // Reactivate the row (same logic as the existing-update path above)
          let raceWebhookSecret: string | null = null
          if (provider.supportsWebhook) {
            webhookEndpointId = generateWebhookEndpointId()
            raceWebhookSecret = generateWebhookSecret()
          }
          integration = await db.companyIntegration.update({
            where: { id: raceExisting.id },
            data: {
              connectionName: input.connectionName,
              credentialsEncrypted,
              isActive: true,
              connectionStatus: 'pending',
              lastError: null,
              webhookEndpointId,
              webhookSecret: raceWebhookSecret,
            },
            select: { id: true },
          })
          insertAuditLog({
            action: raceExisting.isActive ? 'integration.credentials_updated' : 'integration.reconnected',
            entityType: 'company_integration',
            entityId: integration.id,
            companyId: ctx.company.id,
            organizationId: ctx.company.organizationId,
            userId: ctx.user.id,
            employeeId: ctx.employee.id,
            newValues: {
              provider: provider.providerKey,
              connectionName: input.connectionName,
              supportsWebhook: provider.supportsWebhook,
            },
          })
        } else {
          throw createErr
        }
      }
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000'
    const webhookUrl = webhookEndpointId
      ? `${appUrl}/api/webhooks/${provider.providerKey}/${webhookEndpointId}`
      : undefined

    return {
      success: true,
      data: { companyIntegrationId: integration.id, webhookUrl },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to connect integration',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// updateIntegrationCredentials
// ──────────────────────────────────────────────────────────────

export async function updateIntegrationCredentials(
  companyIntegrationId: string,
  credentials: Record<string, string>,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can update integration credentials.' }
    }

    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id },
      include: { provider: true },
    })
    if (!integration) return { success: false, error: 'Integration not found' }

    // Validate required fields
    let configFields: Array<{ key: string; required: boolean; label: string }> = []
    try {
      configFields = JSON.parse(integration.provider.configSchema)
    } catch {
      return { success: false, error: 'Provider config_schema is invalid' }
    }
    for (const field of configFields) {
      if (field.required && (!credentials[field.key] || !credentials[field.key].trim())) {
        return { success: false, error: `Missing required field: ${field.label}` }
      }
    }

    const credentialsEncrypted = encryptCredentials(credentials)

    // Reactivate the integration if it was disconnected. This makes the
    // credentials PATCH route double as the "reconnect" endpoint — the UI's
    // Reconnect button calls this route with new credentials, and the
    // integration flips back to isActive=true + connectionStatus='pending'.
    // If the integration was already active, this is a no-op on isActive
    // (just a credential refresh).
    const wasDisconnected = !integration.isActive

    await db.companyIntegration.update({
      where: { id: companyIntegrationId },
      data: {
        credentialsEncrypted,
        isActive: true, // reactivate if disconnected
        connectionStatus: 'pending', // reset to pending — needs re-test
        lastError: null,
      },
    })

    insertAuditLog({
      action: wasDisconnected ? 'integration.reconnected' : 'integration.credentials_updated',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update credentials',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// disconnectIntegration
// ──────────────────────────────────────────────────────────────

export async function disconnectIntegration(companyIntegrationId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can disconnect integrations.' }
    }

    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id },
      select: { id: true, isActive: true, provider: { select: { category: true } } },
    })
    if (!integration) return { success: false, error: 'Integration not found' }

    // Idempotency guard — if already disconnected, return success without
    // inserting a duplicate audit log.
    if (!integration.isActive) {
      return { success: true }
    }

    // ── Full disconnect in a single transaction ──
    // 1. Deactivate the integration + update connectionStatus to 'expired'
    //    (the CHECK constraint allows 'pending' | 'connected' | 'error' | 'expired'
    //    — 'expired' is the closest semantic to "disconnected" without a migration).
    // 2. Wipe credentials + webhook info (security — no lingering API keys).
    // 3. Clear lastError + lastSyncAt (stale state from before disconnect).
    // 4. If this integration was the company's default courier, clear that FK
    //    so auto-booking doesn't silently fail on future orders.
    // 5. Audit log (in the same transaction so we never have a deactivation
    //    without an audit trail).
    await db.$transaction(async (tx) => {
      await tx.companyIntegration.update({
        where: { id: companyIntegrationId },
        data: {
          isActive: false,
          isDefault: false,
          connectionStatus: 'expired',
          credentialsEncrypted: null,
          webhookEndpointId: null,
          webhookSecret: null,
          lastError: null,
          lastSyncAt: null,
        },
      })

      // Clear the default courier FK if it points at this integration.
      // This prevents auto-booking from silently failing with "integration
      // not found or inactive" on every future manual order.
      if (integration.provider.category === 'courier') {
        await tx.companyOrderSetting.updateMany({
          where: {
            companyId: ctx.company.id,
            defaultCourierCompanyIntegrationId: companyIntegrationId,
          },
          data: {
            defaultCourierCompanyIntegrationId: null,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          action: 'integration.disconnected',
          entityType: 'company_integration',
          entityId: companyIntegrationId,
          companyId: ctx.company.id,
          organizationId: ctx.company.organizationId,
          userId: ctx.user.id,
          employeeId: ctx.employee.id,
        },
      })
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to disconnect integration',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// setDefaultIntegration
// ──────────────────────────────────────────────────────────────

export async function setDefaultIntegration(companyIntegrationId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can set default integrations.' }
    }

    // Fetch the integration + its provider's category
    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id },
      include: { provider: { select: { category: true } } },
    })
    if (!integration) return { success: false, error: 'Integration not found' }

    // Unset is_default for all other integrations in the SAME category
    // for this company (join through provider to determine category)
    const sameCategoryIntegrations = await db.companyIntegration.findMany({
      where: {
        companyId: ctx.company.id,
        id: { not: companyIntegrationId },
        provider: { category: integration.provider.category },
      },
      select: { id: true },
    })

    await db.$transaction([
      // Unset others
      db.companyIntegration.updateMany({
        where: { id: { in: sameCategoryIntegrations.map((i) => i.id) } },
        data: { isDefault: false },
      }),
      // Set this one
      db.companyIntegration.update({
        where: { id: companyIntegrationId },
        data: { isDefault: true },
      }),
    ])

    insertAuditLog({
      action: 'integration.set_default',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { category: integration.provider.category },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to set default integration',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// testIntegrationConnection
// ──────────────────────────────────────────────────────────────

export async function testIntegrationConnection(companyIntegrationId: string): Promise<ActionResult<{
  status: string
  error?: string
}>> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can test integrations.' }
    }

    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id },
      include: { provider: true },
    })
    if (!integration) return { success: false, error: 'Integration not found' }
    if (!integration.credentialsEncrypted) {
      return { success: false, error: 'No credentials stored for this integration' }
    }

    // Decrypt credentials
    const credentials = decryptCredentials(integration.credentialsEncrypted)

    // Get the appropriate adapter via the registry
    const providerKey = integration.provider.providerKey
    const category = getAdapterCategory(providerKey)
    if (!category) {
      return { success: false, error: `No adapter registered for provider '${providerKey}'` }
    }

    // Call a lightweight, read-only capability check via the logged wrapper.
    //
    // PROVIDER-DISPATCH PATTERN (not PostEx-hardcoded):
    //   1. If the adapter implements pingConnection() → use it (preferred).
    //      PostEx implements this (calls fetchOperationalCities — read-only).
    //      Leopard/TCS will automatically pick this up once their adapters
    //      implement pingConnection() — no changes needed here.
    //   2. Else if the adapter supports fetchOperationalCities() → use it
    //      (covers couriers that have a cities endpoint but no explicit ping).
    //   3. Else fall back to calculateRate() (legacy path — some couriers
    //      expose a rate endpoint that validates credentials).
    //   4. Else surface a clear "not supported" error.
    //
    // For ecommerce adapters: no standard "ping" — parseWebhookOrder with an
    // empty payload is the minimal "does the adapter work" test.
    try {
      const testResult = await executeLoggedIntegrationAction<{ success: boolean; error?: string }>({
        companyIntegrationId,
        organizationId: ctx.company.organizationId,
        actionType: 'test_connection',
        direction: 'outbound',
        fn: async () => {
          if (category === 'courier') {
            const adapter = getCourierAdapter(providerKey, credentials)

            // Preferred: adapter implements pingConnection()
            if (typeof adapter.pingConnection === 'function') {
              return adapter.pingConnection()
            }

            // Fallback 1: adapter supports fetchOperationalCities() (read-only)
            if (typeof adapter.fetchOperationalCities === 'function') {
              const cities = await adapter.fetchOperationalCities()
              if (cities.length === 0) {
                return {
                  success: false,
                  error: `${providerKey} accepted the credentials but returned 0 cities.`,
                }
              }
              return { success: true }
            }

            // Fallback 2: calculateRate() (legacy — unsupported by PostEx)
            if (typeof adapter.calculateRate === 'function') {
              try {
                const rateResult = await adapter.calculateRate({
                  fromCity: 'Karachi',
                  toCity: 'Lahore',
                  weightGrams: 500,
                })
                return {
                  success: rateResult.success,
                  error: rateResult.success ? undefined : rateResult.error,
                }
              } catch (rateErr) {
                return {
                  success: false,
                  error: rateErr instanceof Error ? rateErr.message : 'calculateRate failed',
                }
              }
            }

            // No read-only test method available
            return {
              success: false,
              error: `The ${providerKey} adapter does not implement a read-only connectivity check (pingConnection, fetchOperationalCities, or calculateRate). Test not supported.`,
            }
          } else {
            const adapter = getEcommerceAdapter(providerKey, credentials)
            // Ecommerce: no standard "ping" — use parseWebhookOrder with
            // an empty payload as a minimal "does the adapter work" test
            try {
              const parsed = await adapter.parseWebhookOrder({})
              return {
                success: parsed.success,
                error: parsed.success ? undefined : parsed.error,
              }
            } catch (parseErr) {
              return {
                success: false,
                error: parseErr instanceof Error ? parseErr.message : 'parseWebhookOrder failed',
              }
            }
          }
        },
      })

      // executeLoggedIntegrationAction throws on failure; if we reach here
      // with testResult.success=true, the connection is good.
      if (testResult.success) {
        await db.companyIntegration.update({
          where: { id: companyIntegrationId },
          data: { connectionStatus: 'connected', lastSyncAt: new Date(), lastError: null },
        })
        return { success: true, data: { status: 'connected' } }
      }

      // The ping call returned a structured failure (not an exception).
      // Surface the error but DON'T mark the integration as broken — a single
      // failed test ping may be transient (network blip, rate limit, etc.).
      // We update lastError + connectionStatus='error' for visibility, but
      // isActive stays true so the integration remains usable.
      const errorMsg = testResult.error || 'Connection test failed'
      await db.companyIntegration.update({
        where: { id: companyIntegrationId },
        data: { connectionStatus: 'error', lastError: errorMsg },
      })
      return { success: false, error: errorMsg, data: { status: 'error', error: errorMsg } }
    } catch (testErr) {
      const errorMsg = testErr instanceof Error ? testErr.message : String(testErr)
      // Same non-destructive policy: log the error, don't disable the integration.
      await db.companyIntegration.update({
        where: { id: companyIntegrationId },
        data: { connectionStatus: 'error', lastError: errorMsg },
      }).catch(() => {}) // don't let a DB failure mask the original test error
      // Return success=false but with the error message (don't throw —
      // the caller wants to display it in the UI)
      return { success: false, error: errorMsg, data: { status: 'error', error: errorMsg } }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to test connection',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Internal helper: get a decrypted-credentials + adapter combo
// for use by other server actions (courier booking, etc.)
// ──────────────────────────────────────────────────────────────

export async function getIntegrationAdapter(companyIntegrationId: string): Promise<{
  credentials: Record<string, string>
  providerKey: string
  category: 'courier' | 'ecommerce'
  organizationId: string
} | null> {
  const integration = await db.companyIntegration.findUnique({
    where: { id: companyIntegrationId },
    include: { provider: true },
  })
  if (!integration || !integration.isActive || !integration.credentialsEncrypted) return null

  const credentials = decryptCredentials(integration.credentialsEncrypted)
  const category = getAdapterCategory(integration.provider.providerKey)
  if (!category) return null

  return {
    credentials,
    providerKey: integration.provider.providerKey,
    category,
    organizationId: integration.organizationId,
  }
}
