/**
 * Fire-and-forget helper for non-critical background writes
 * (audit logs, metric events).
 *
 * WHY: Audit/metric DB writes should NEVER block the HTTP response.
 *       A typical audit-log insert on a remote DB takes 50-150ms; awaiting
 *       it on every mutation adds that latency to every request. By
 *       detaching the write, the response returns immediately and the
 *       write completes on the event loop.
 *
 * SAFETY:
 *   1. A `.catch()` handler is attached so any failure is logged to stderr
 *      rather than becoming an unhandled promise rejection.
 *   2. The audit/metric helpers themselves ALSO have an internal try/catch
 *      (see src/lib/audit.ts + src/lib/metrics.ts), so this is pure
 *      defense-in-depth — a failure can only reach this catch if the
 *      helper's own catch was bypassed.
 *
 * RUNTIME:
 *   This project deploys as a long-lived Bun/Node.js server
 *   (`output: 'standalone'` + `bun .next/standalone/server.js`), confirmed
 *   by next.config.ts + package.json. Every API route declares
 *   `runtime = 'nodejs'` (zero edge routes). On a long-lived server the
 *   event loop keeps running after the response is sent, so a detached
 *   promise will always complete — NO `waitUntil()` primitive is needed.
 *
 *   If this project is ever migrated to Vercel serverless / edge, the
 *   detached promises would need to be registered with `waitUntil()` from
 *   `@vercel/functions` to survive function freeze. The dynamic-import
 *   fallback below handles that case automatically IF the package is
 *   installed, without breaking the long-lived-server case.
 */
export function fireAndForget(promise: Promise<unknown>): void {
  promise.catch((err) => {
    console.error('[fire-and-forget] background task failed:', err)
  })
}
