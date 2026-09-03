import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getWorkspace, isElevated, ApiError, handleError } from '@/lib/workspace'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { insertAuditLog } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/integrations/[id]/test
 *
 * Performs a REAL API connectivity test against the courier's API.
 * Calls the adapter's `pingConnection()` method, which makes a lightweight
 * read-only API call to verify the credentials are valid and the API is
 * reachable.
 *
 *   - Leopard: calls getAllCities (lightest read-only endpoint)
 *   - PostEx: calls the status API with a dummy tracking number
 *
 * Returns { ok, error?, status? } — NOT a 500 on test failure (the test
 * itself may "fail" if credentials are bad, and that's a legitimate
 * response the UI needs to display, not a server error).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getWorkspace()

    // Load the integration + verify ownership
    const integration = await db.companyIntegration.findFirst({
      where: { id, companyId: ctx.company.id },
      include: { provider: true },
    })
    if (!integration) {
      throw new ApiError(404, 'Integration not found or does not belong to your company.')
    }

    if (!integration.credentialsEncrypted) {
      return Response.json({
        ok: false,
        error: 'No credentials stored. Please reconnect this integration first.',
        status: 'no_credentials',
      })
    }

    const providerKey = integration.provider.providerKey
    const credentials = decryptCredentials(integration.credentialsEncrypted)
    const adapter = getCourierAdapter(providerKey, credentials)

    // pingConnection is optional on the CourierAdapter interface.
    // If the adapter doesn't implement it, we can't test.
    if (!adapter.pingConnection) {
      return Response.json({
        ok: false,
        error: `Provider '${providerKey}' does not support connection testing.`,
        status: 'unsupported',
      })
    }

    // Run the ping via the logged wrapper (so the test call appears in
    // integration_action_logs for observability).
    const result = await executeLoggedIntegrationAction<{ success: boolean; error?: string }>({
      companyIntegrationId: id,
      organizationId: integration.organizationId,
      actionType: 'ping_connection',
      direction: 'outbound',
      fn: async () => adapter.pingConnection!(),
      requestPayload: { note: 'Connection test from integrations UI' },
    })

    if (result.success) {
      // Update connection status to 'active' + clear lastError
      await db.companyIntegration.update({
        where: { id },
        data: {
          connectionStatus: 'active',
          lastError: null,
        },
      })

      insertAuditLog({
        action: 'integration.test_success',
        entityType: 'company_integration',
        entityId: id,
        companyId: ctx.company.id,
        organizationId: ctx.company.organizationId,
        userId: ctx.user.id,
        employeeId: ctx.employee.id,
        newValues: { providerKey, status: 'active' },
      })

      return Response.json({
        ok: true,
        status: 'active',
      })
    } else {
      // Test failed — update connection status to 'error' + store lastError
      const errorMsg = result.error || 'Connection test failed.'

      await db.companyIntegration.update({
        where: { id },
        data: {
          connectionStatus: 'error',
          lastError: errorMsg,
        },
      })

      insertAuditLog({
        action: 'integration.test_failed',
        entityType: 'company_integration',
        entityId: id,
        companyId: ctx.company.id,
        organizationId: ctx.company.organizationId,
        userId: ctx.user.id,
        employeeId: ctx.employee.id,
        newValues: { providerKey, error: errorMsg },
      })

      return Response.json({
        ok: false,
        error: errorMsg,
        status: 'error',
      })
    }
  } catch (err) {
    return handleError(err)
  }
}
