import { db } from './db'
import { ApiError } from './workspace'

/**
 * Idempotency key system for duplicate-submission protection.
 *
 * Guarantees that only ONE successful creation happens per client-generated
 * key, even under genuine concurrent load (near-simultaneous double-clicks).
 *
 * Key semantics:
 * - A ticket is only "claimed" on SUCCESS. If the first attempt fails
 *   (e.g., validation error), the ticket is NOT permanently locked — the
 *   user may have fixed the issue and should be able to genuinely retry
 *   with the same key.
 * - On a genuine near-simultaneous double-request (both hit the DB unique
 *   constraint at almost the same time), the LOSING request polls briefly
 *   for the winner's result, then returns it — it does NOT error out.
 * - The cached response returned for a repeated ticket is the SAME shape
 *   as a fresh success response, so the frontend can't tell the difference.
 *
 * The unique constraint on IdempotencyKey.key is what enforces atomicity.
 * We do NOT do a separate "check if exists" query first — that has a race
 * window. We rely on the DB unique constraint and catch the violation.
 */

/**
 * Threshold for considering a 'processing' row stale.
 *
 * If an IdempotencyKey row has status='processing' but its createdAt is
 * older than this threshold, we treat it as abandoned (the original request
 * likely crashed or timed out) and recover by deleting it + running fn()
 * fresh — instead of polling or throwing 409.
 *
 * A real creation should never legitimately take this long. If fn() genuinely
 * needs >60s (e.g., a very slow courier API), consider increasing this.
 */
const STALE_PROCESSING_THRESHOLD_MS = 60_000

interface WithIdempotencyParams<T> {
  key: string
  companyId: string
  employeeId?: string
  actionType: string
  fn: () => Promise<T>
}

interface WithIdempotencyResult<T> {
  result: T
  wasReplay: boolean
}

/**
 * Execute a creation function with idempotency protection.
 *
 * 1. Attempt to INSERT a new IdempotencyKey row with status='processing'.
 *    The unique constraint on `key` is what enforces atomicity.
 * 2. If insert SUCCEEDS (this request won the race):
 *    - Run fn(). On success: store result, return { result, wasReplay: false }.
 *    - On failure: mark row as 'failed', re-throw the error.
 * 3. If insert FAILS due to unique constraint (another request claimed this key):
 *    - Look up the existing row.
 *    - If 'completed': return the cached result as { result, wasReplay: true }.
 *    - If 'processing': poll briefly (up to ~1.5s) for completion.
 *    - If 'failed': delete the failed row and retry fresh (allow genuine retry).
 */
export async function withIdempotency<T>({
  key,
  companyId,
  employeeId,
  actionType,
  fn,
}: WithIdempotencyParams<T>): Promise<WithIdempotencyResult<T>> {
  // ── Step 1: Attempt to claim the key ──────────────────────────────
  let claimed = false
  try {
    await db.idempotencyKey.create({
      data: {
        key,
        companyId,
        employeeId: employeeId ?? null,
        actionType,
        status: 'processing',
      },
    })
    claimed = true
  } catch (err: unknown) {
    // Prisma unique constraint violation code is P2002
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      // Key already exists — fall through to step 3 below
      claimed = false
    } else {
      // Unexpected error (not a unique constraint violation)
      throw err
    }
  }

  // ── Step 2: We won the race — run fn() ────────────────────────────
  if (claimed) {
    try {
      const result = await fn()

      // Store the result for future replays
      await db.idempotencyKey.update({
        where: { key },
        data: {
          status: 'completed',
          responseBody: result as unknown as object,
          completedAt: new Date(),
        },
      })

      return { result, wasReplay: false }
    } catch (err) {
      // Mark as failed so a future retry can proceed fresh.
      // Do NOT delete the row here — we update it to 'failed' status,
      // which allows the "failed → retry" path in step 3 to clean it up.
      await db.idempotencyKey.update({
        where: { key },
        data: { status: 'failed' },
      }).catch(() => {
        // Non-fatal: if this update fails (e.g., row was deleted by a
        // concurrent retry), the original error is still propagated.
      })
      throw err
    }
  }

  // ── Step 3: We lost the race — key already exists ─────────────────
  // Poll for the existing row to reach a terminal state.
  const MAX_POLLS = 5
  const POLL_INTERVAL_MS = 300

  for (let i = 0; i < MAX_POLLS; i++) {
    const existing = await db.idempotencyKey.findUnique({ where: { key } })
    if (!existing) {
      // Row was deleted (e.g., by a concurrent 'failed' retry that cleaned
      // it up). Attempt to claim it fresh ourselves.
      return withIdempotency({ key, companyId, employeeId, actionType, fn })
    }

    if (existing.status === 'completed') {
      // Success — return the cached result
      return {
        result: existing.responseBody as T,
        wasReplay: true,
      }
    }

    if (existing.status === 'failed') {
      // Prior attempt failed — allow a genuine fresh retry.
      // Delete the failed row so we can claim the key fresh.
      await db.idempotencyKey.delete({ where: { key } }).catch(() => {
        // If another concurrent request already deleted it, that's fine —
        // we'll attempt to create a new row below.
      })
      // Retry the whole flow fresh
      return withIdempotency({ key, companyId, employeeId, actionType, fn })
    }

    // status === 'processing' — check for staleness BEFORE polling.
    // If the row is older than STALE_PROCESSING_THRESHOLD_MS, treat it as
    // abandoned (the original request likely crashed or timed out) and
    // recover by deleting it + running fn() fresh — same as the 'failed'
    // path above. A real creation should never take this long.
    const ageMs = Date.now() - existing.createdAt.getTime()
    if (ageMs > STALE_PROCESSING_THRESHOLD_MS) {
      await db.idempotencyKey.delete({ where: { key } }).catch(() => {
        // If another concurrent request already deleted it, that's fine.
      })
      return withIdempotency({ key, companyId, employeeId, actionType, fn })
    }

    // Row is fresh and still processing — wait briefly and poll again
    await sleep(POLL_INTERVAL_MS)
  }

  // Exhausted all polls — the concurrent request is still processing.
  // This is rare (fn() took >1.5s). Return a clear error.
  throw new ApiError(
    409,
    'This request is already being processed. Please wait a moment and check if your record was created before retrying.',
  )
}

/** Sleep helper for polling. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
