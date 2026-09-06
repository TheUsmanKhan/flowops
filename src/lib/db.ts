import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Prisma Client setup for Supabase.
 *
 * IMPORTANT: The PrismaClient is created LAZILY via a Proxy. It is NOT
 * instantiated at module load time — only when a property is first accessed.
 * This is critical because Next.js evaluates ALL route modules during the
 * build's "collect page data" phase. If the PrismaClient constructor throws
 * (e.g., because DATABASE_URL is SQLite during sandbox build), the entire
 * build crashes. With lazy evaluation, the build succeeds and the error
 * only surfaces at runtime when a query is actually executed.
 *
 * The Proxy caches the client in a module-level variable (`_client`), so
 * the PrismaClient is created ONCE per process (not per query). This
 * prevents connection pool exhaustion (Supabase limits to 15 connections).
 * In development, the client is also cached on globalThis to survive
 * hot-reload (Next.js clears module cache on HMR).
 *
 * The guard rejects non-postgresql URLs with a clear error message at
 * runtime (not build time).
 */

let _client: PrismaClient | null = null

function getPrismaClient(): PrismaClient {
  // Return cached client if available (production path — fast)
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
// During build (page data collection), this never fires → no crash.
// The client is cached in _client after first creation → no connection pool exhaustion.
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop: string) {
    const client = getPrismaClient()
    const value = (client as unknown as Record<string, unknown>)[prop]
    // Bind methods so they keep the correct `this` context
    return typeof value === 'function' ? value.bind(client) : value
  },
})
