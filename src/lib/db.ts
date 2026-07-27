import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Use the transaction pooler (port 6543) for DATABASE_URL at runtime
// to avoid exhausting the session pooler's connection limit (15).
// The .env file has the session pooler (port 5432) for schema validation
// (prisma db push / generate), but at runtime we override to port 6543.
const runtimeDbUrl = process.env.DATABASE_URL?.replace(':5432/', ':6543/').replace(
  /postgres$/,
  'postgres?pgbouncer=true&connection_limit=1',
) || process.env.DATABASE_URL

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    datasources: {
      db: {
        url: runtimeDbUrl,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db