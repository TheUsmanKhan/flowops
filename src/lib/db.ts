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
 */

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
