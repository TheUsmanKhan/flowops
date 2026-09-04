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
 */
const dbUrl = process.env.DATABASE_URL
if (!dbUrl || (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://'))) {
  throw new Error(
    `[db.ts] DATABASE_URL must be a PostgreSQL URL (got: ${dbUrl ?? 'undefined'}). ` +
    `The .env file likely reverted to SQLite. Fix .env and restart the dev server.`
  )
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    datasources: {
      db: {
        url: dbUrl,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
