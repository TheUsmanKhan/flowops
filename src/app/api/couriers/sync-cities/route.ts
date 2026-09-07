import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getWorkspace, requirePermission, handleError, readBody } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/couriers/sync-cities
 * Body: { providerKey: string } (optional — if omitted, syncs all providers)
 *
 * Manually triggers the city sync job. Returns IMMEDIATELY with a
 * "sync started" response — the actual sync runs in the background.
 * This prevents gateway timeouts (PostEx's API can take 30-60 seconds
 * to return the full city list).
 *
 * The UI should show a "Syncing…" state and then refetch the cities
 * list after a few seconds, or invalidate the query cache when the
 * sync completes.
 *
 * Requires INTEGRATIONS_MANAGE permission.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INTEGRATIONS_MANAGE)

    const body = await readBody<{ providerKey?: string }>(req).catch(() => ({ providerKey: undefined }))

    // ── Fire-and-forget: start the sync in the background ──
    // We return immediately so the HTTP response doesn't time out.
    // The sync logs its result to the console + audit log when done.
    ;(async () => {
      try {
        const { syncCourierOperationalCities, syncAllCourierCities } = await import(
          '@/lib/actions/city-sync.actions'
        )
        if (body.providerKey) {
          const result = await syncCourierOperationalCities(body.providerKey)
          console.log(`[sync-cities] Background sync complete:`, result)
        } else {
          const results = await syncAllCourierCities()
          console.log(`[sync-cities] Background sync (all) complete:`, results)
        }
      } catch (err) {
        console.error('[sync-cities] Background sync failed:', err)
      }
    })()

    // Return immediately — the sync is running in the background
    return Response.json({
      success: true,
      message: 'City sync started in the background. This may take 30-60 seconds.',
      providerKey: body.providerKey ?? 'all',
    })
  } catch (err) {
    return handleError(err)
  }
}
