/**
 * Next.js Instrumentation Hook — runs ONCE when the server starts.
 *
 * This is the official Next.js mechanism for server-side initialization
 * (see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation).
 *
 * We use it to start the PostEx status polling interval. The vercel.json
 * cron schedule only works on Vercel deployments — on a long-lived
 * Bun/Node.js server (which is how this app runs in production), the cron
 * never fires. This in-process interval ensures courier statuses are
 * polled every 30 minutes regardless of the hosting platform.
 *
 * The interval is guarded so it only starts in the Node.js runtime (not
 * during build/edge) and only starts ONCE per process.
 */

let pollerStarted = false

export async function register() {
  // Only run in the Node.js runtime, not during build or in edge.
  // Next.js 16: the instrumentation hook's `register` function is called
  // once per runtime initialization.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (pollerStarted) return
  pollerStarted = true

  const POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes (matches vercel.json schedule)
  const INITIAL_DELAY_MS = 60 * 1000 // 1 minute after server start (let the server warm up)

  // Dynamic import to avoid loading the polling code during build.
  const startPoller = async () => {
    try {
      const { pollPostExOrderStatuses } = await import('@/lib/actions/postex-status-poll.actions')
      console.log('[instrumentation] Starting PostEx status poller (every 30 min)')

      // Run the first poll after a short delay (let the server finish booting).
      setTimeout(async () => {
        try {
          const result = await pollPostExOrderStatuses()
          if (result.success && result.data) {
            console.log(`[poller] Initial poll: ${result.data.polledOrders} orders, ${result.data.polledShipments} shipments, ${result.data.statusChanges} changes, ${result.data.errors.length} errors`)
          }
        } catch (err) {
          console.error('[poller] Initial poll failed:', err instanceof Error ? err.message : err)
        }
      }, INITIAL_DELAY_MS)

      // Schedule recurring polls every 30 minutes.
      setInterval(async () => {
        try {
          const result = await pollPostExOrderStatuses()
          if (result.success && result.data) {
            const { polledOrders, polledShipments, statusChanges, errors } = result.data
            if (polledOrders > 0 || polledShipments > 0 || statusChanges > 0 || errors.length > 0) {
              console.log(`[poller] Poll: ${polledOrders} orders, ${polledShipments} shipments, ${statusChanges} changes, ${errors.length} errors`)
            }
          }
        } catch (err) {
          console.error('[poller] Poll failed:', err instanceof Error ? err.message : err)
        }
      }, POLL_INTERVAL_MS)
    } catch (err) {
      console.error('[instrumentation] Failed to start PostEx poller:', err instanceof Error ? err.message : err)
    }
  }

  startPoller()
}
