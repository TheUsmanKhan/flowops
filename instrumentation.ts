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
 *
 * ─── HORIZONTAL SCALING TOGGLE (Phase 3) ─────────────────────────────
 * When FlowOps eventually runs multiple app replicas (e.g. behind a load
 * balancer), the in-process poller would run on EVERY replica, causing
 * duplicate PostEx API calls and duplicate dispatch/RTO triggers.
 *
 * The ENABLE_IN_PROCESS_POLLER env var controls whether this instance
 * starts the poller. Default: 'true' (preserves current single-instance
 * behavior). Set to 'false' on all but one replica, OR set to 'false' on
 * all replicas and run the poller as a separate mini-service (see
 * mini-services/postex-poller/).
 *
 * This toggle does NOT change polling logic — it only gates whether the
 * setInterval starts. The actual extraction of pollPostExOrderStatuses()
 * into a standalone service is a SEPARATE, FUTURE task.
 */

let pollerStarted = false

export async function register() {
  // Only run in the Node.js runtime, not during build or in edge.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (pollerStarted) return
  pollerStarted = true

  // ─── Phase 3: Horizontal scaling toggle ───────────────────────────
  // Default: 'true' (poller runs in-process, current behavior).
  // Set ENABLE_IN_PROCESS_POLLER=false to disable (for multi-replica
  // setups where only one instance or a dedicated worker should poll).
  const enablePoller = process.env.ENABLE_IN_PROCESS_POLLER !== 'false'
  if (!enablePoller) {
    console.log('[instrumentation] PostEx poller DISABLED (ENABLE_IN_PROCESS_POLLER=false)')
    return
  }

  const POSTEX_POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
  const LEOPARD_POLL_INTERVAL_MS = 60 * 60 * 1000 // 60 minutes
  const INITIAL_DELAY_MS = 60 * 1000 // 1 minute after server start

  // Dynamic import to avoid loading the polling code during build.
  const startPollers = async () => {
    // ── PostEx poller (every 30 min) ──
    try {
      const { pollPostExOrderStatuses } = await import('@/lib/actions/postex-status-poll.actions')
      console.log('[instrumentation] Starting PostEx status poller (every 30 min)')

      setTimeout(async () => {
        try {
          const result = await pollPostExOrderStatuses()
          if (result.success && result.data) {
            console.log(`[poller:postex] Initial poll: ${result.data.polledOrders} orders, ${result.data.polledShipments} shipments, ${result.data.statusChanges} changes, ${result.data.errors.length} errors`)
          }
        } catch (err) {
          console.error('[poller:postex] Initial poll failed:', err instanceof Error ? err.message : err)
        }
      }, INITIAL_DELAY_MS)

      setInterval(async () => {
        try {
          const result = await pollPostExOrderStatuses()
          if (result.success && result.data) {
            const { polledOrders, polledShipments, statusChanges, errors } = result.data
            if (polledOrders > 0 || polledShipments > 0 || statusChanges > 0 || errors.length > 0) {
              console.log(`[poller:postex] Poll: ${polledOrders} orders, ${polledShipments} shipments, ${statusChanges} changes, ${errors.length} errors`)
            }
          }
        } catch (err) {
          console.error('[poller:postex] Poll failed:', err instanceof Error ? err.message : err)
        }
      }, POSTEX_POLL_INTERVAL_MS)
    } catch (err) {
      console.error('[instrumentation] Failed to start PostEx poller:', err instanceof Error ? err.message : err)
    }

    // ── Leopard safety-net poller (every 60 min) ──
    try {
      const { pollLeopardOrderStatuses } = await import('@/lib/actions/leopard-webhook.actions')
      console.log('[instrumentation] Starting Leopard safety-net poller (every 60 min)')

      setTimeout(async () => {
        try {
          const result = await pollLeopardOrderStatuses()
          if (result.success && result.data) {
            console.log(`[poller:leopard] Initial poll: ${result.data.polledOrders} orders, ${result.data.polledShipments} shipments, ${result.data.statusChanges} changes, ${result.data.errors.length} errors`)
          }
        } catch (err) {
          console.error('[poller:leopard] Initial poll failed:', err instanceof Error ? err.message : err)
        }
      }, INITIAL_DELAY_MS + 30 * 1000)

      setInterval(async () => {
        try {
          const result = await pollLeopardOrderStatuses()
          if (result.success && result.data) {
            const { polledOrders, polledShipments, statusChanges, errors } = result.data
            if (polledOrders > 0 || polledShipments > 0 || statusChanges > 0 || errors.length > 0) {
              console.log(`[poller:leopard] Poll: ${polledOrders} orders, ${polledShipments} shipments, ${statusChanges} changes, ${errors.length} errors`)
            }
          }
        } catch (err) {
          console.error('[poller:leopard] Poll failed:', err instanceof Error ? err.message : err)
        }
      }, LEOPARD_POLL_INTERVAL_MS)
    } catch (err) {
      console.error('[instrumentation] Failed to start Leopard poller:', err instanceof Error ? err.message : err)
    }
  }

  startPollers()

  // ── Phase F1: in-process exchange rate refresh (daily) ──
  // Same pattern as the PostEx poller above: env flag + setInterval + dynamic
  // import. Gated by ENABLE_IN_PROCESS_FX_REFRESH (default 'true').
  const enableFxRefresh = process.env.ENABLE_IN_PROCESS_FX_REFRESH !== 'false'
  if (enableFxRefresh) {
    const FX_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours (matches vercel.json schedule)
    const FX_INITIAL_DELAY_MS = 5 * 60 * 1000   // 5 min (let server warm up)

    const startFxRefresh = async () => {
      try {
        console.log('[instrumentation] Starting exchange rate refresh (every 24h)')
        setTimeout(async () => {
          try {
            const { syncExchangeRates, getActiveCurrencies } = await import('@/lib/exchange-rates')
            const { db } = await import('@/lib/db')
            const allMarkets = await db.market.findMany({ where: { isActive: true }, select: { currency: true }, distinct: ['currency'] })
            const currencies = allMarkets.map((m: { currency: string }) => m.currency)
            if (currencies.length > 0) {
              const result = await syncExchangeRates(currencies)
              console.log(`[fx-refresh] Stored ${result.stored} rate snapshots. Errors: ${result.errors.length}`)
            }
          } catch (err) {
            console.error('[fx-refresh] Refresh failed:', err instanceof Error ? err.message : err)
          }
        }, FX_INITIAL_DELAY_MS)

        setInterval(async () => {
          try {
            const { syncExchangeRates, getActiveCurrencies } = await import('@/lib/exchange-rates')
            const { db } = await import('@/lib/db')
            const allMarkets = await db.market.findMany({ where: { isActive: true }, select: { currency: true }, distinct: ['currency'] })
            const currencies = allMarkets.map((m: { currency: string }) => m.currency)
            if (currencies.length > 0) {
              const result = await syncExchangeRates(currencies)
              console.log(`[fx-refresh] Stored ${result.stored} rate snapshots. Errors: ${result.errors.length}`)
            }
          } catch (err) {
            console.error('[fx-refresh] Refresh failed:', err instanceof Error ? err.message : err)
          }
        }, FX_INTERVAL_MS)
      } catch (err) {
        console.error('[instrumentation] Failed to start FX refresh:', err instanceof Error ? err.message : err)
      }
    }

    startFxRefresh()
  } else {
    console.log('[instrumentation] FX refresh DISABLED (ENABLE_IN_PROCESS_FX_REFRESH=false)')
  }
}
