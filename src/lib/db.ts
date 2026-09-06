import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Prisma Client setup for Supabase.
 *
 * Uses the DATABASE_URL from .env directly (session pooler, port 5432).
 * The session pooler supports prepared statements natively — no pgbouncer
 * override needed. Connection limit of 15 is sufficient for development.
 *
 * The `datasources.db.url` override is explicitly passed to ensure the
 * runtime URL is used (the generated Prisma Client may have a stale URL
 * baked in from a previous `prisma generate` run with a different .env).
 *
 * Guard: rejects non-postgresql URLs early with a clear error message
 * (prevents the cryptic Prisma "URL must start with postgresql://" crash
 * that happens when the sandbox reverts .env to SQLite).
 *
 * LAZY CREATION: The PrismaClient is created lazily (only when first
 * accessed via the Proxy) so that module load never throws — the guard
 * error surfaces at runtime when a query is actually executed. This
 * keeps the server alive even if DATABASE_URL is temporarily wrong.
 */

let _client: PrismaClient | null = null

function getPrismaClient(): PrismaClient {
  // Return cached client if available (fast path — no new connection)
  if (_client) return _client

  // Dev hot-reload: check globalThis cache
  if (process.env.NODE_ENV !== 'production' && globalForPrisma.prisma) {
    _client = globalForPrisma.prisma
    return _client
  }

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl || (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://'))) {
    throw new Error(
      `[db.ts] DATABASE_URL must be a PostgreSQL URL (got: ${dbUrl ?? 'undefined'}). ` +
      `The .env file likely reverted to SQLite. Fix .env and restart the dev server.`
    )
  }

  _client = new PrismaClient({
    log: ['error', 'warn'],
    datasources: {
      db: {
        url: dbUrl,
      },
    },
  })

  // Cache on globalThis for dev hot-reload survival
  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = _client

  return _client
}

// Lazy proxy — PrismaClient is only created when first property is accessed.
// This prevents module-load crashes when DATABASE_URL is temporarily wrong.
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop: string) {
    const client = getPrismaClient()
    const value = (client as unknown as Record<string, unknown>)[prop]
    // Bind methods so they keep the correct `this` context
    return typeof value === 'function' ? value.bind(client) : value
  },
})
