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
 * The guard rejects non-postgresql URLs with a clear error message at
 * runtime (not build time).
 */

function createPrismaClient(): PrismaClient {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl || (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://'))) {
    throw new Error(
      `[db.ts] DATABASE_URL must be a PostgreSQL URL (got: ${dbUrl ?? 'undefined'}). ` +
      `The .env file likely reverted to SQLite. Fix .env and restart the dev server.`
    )
  }

  return (
    globalForPrisma.prisma ??
    new PrismaClient({
      log: ['error', 'warn'],
      datasources: {
        db: {
          url: dbUrl,
        },
      },
    })
  )
}

// Lazy proxy — PrismaClient is only created when first property is accessed.
// During build (page data collection), this never fires → no crash.
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop: string) {
    const client = createPrismaClient()
    // Cache on globalThis for dev hot-reload
    if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = client
    const value = (client as unknown as Record<string, unknown>)[prop]
    // Bind methods so they keep the correct `this` context
    return typeof value === 'function' ? value.bind(client) : value
  },
})
