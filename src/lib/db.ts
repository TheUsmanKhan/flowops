import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Build the runtime database URL.
 *
 * Supabase's transaction pooler (port 6543) doesn't support prepared
 * statements. We need `pgbouncer=true` to tell Prisma to disable them.
 * We also set `connection_limit=1` to avoid exhausting the pool.
 *
 * The .env DATABASE_URL uses the session pooler (port 5432) for schema
 * validation (prisma db push / generate). At runtime we override to
 * port 6543 with pgbouncer params.
 *
 * If the URL already has query params (e.g. ?pgbouncer=true), we don't
 * duplicate them.
 */
function buildRuntimeDbUrl(originalUrl: string | undefined): string | undefined {
  if (!originalUrl) return undefined

  let url = originalUrl

  // Switch from session pooler (5432) to transaction pooler (6543)
  // The transaction pooler is PgBouncer in transaction mode — doesn't
  // support prepared statements, hence the pgbouncer=true param below.
  url = url.replace(':5432/', ':6543/')

  // Add pgbouncer=true + connection_limit=1 if not already present.
  // Use URL parsing to handle existing query params correctly.
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has('pgbouncer')) {
      parsed.searchParams.set('pgbouncer', 'true')
    }
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', '1')
    }
    return parsed.toString()
  } catch {
    // Fallback: simple string append if URL parsing fails
    if (!url.includes('pgbouncer=')) {
      const separator = url.includes('?') ? '&' : '?'
      return `${url}${separator}pgbouncer=true&connection_limit=1`
    }
    return url
  }
}

const runtimeDbUrl = buildRuntimeDbUrl(process.env.DATABASE_URL)

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
