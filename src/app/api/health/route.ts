import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/health
 *
 * Lightweight health-check endpoint for Docker HEALTHCHECK + orchestration.
 * Does a trivial `SELECT 1` against Prisma to confirm DB connectivity.
 * Returns 200 if DB is reachable, 503 if not.
 */
export async function GET() {
  try {
    // Trivial query — confirms the DB connection pool is alive
    await db.$queryRaw`SELECT 1`
    return Response.json(
      { status: 'healthy', db: 'connected', timestamp: new Date().toISOString() },
      { status: 200 },
    )
  } catch (err) {
    console.error('[health] DB check failed:', err instanceof Error ? err.message : err)
    return Response.json(
      { status: 'unhealthy', db: 'disconnected', error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 503 },
    )
  }
}
