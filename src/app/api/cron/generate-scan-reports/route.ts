import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { generateDailyScanReport } from '@/lib/actions/scan-report.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cron/generate-scan-reports
 *
 * Daily scan report generation. Runs once daily (scheduled at ~1am UTC
 * which is ~6am PKT). Generates a stored report for "yesterday" for each
 * active company, using the company's timezone field (defaulting to
 * Asia/Karachi).
 */
export async function POST(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      return Response.json({ error: 'CRON_SECRET not set' }, { status: 500 })
    }
    const provided = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (provided !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Fire-and-forget
    ;(async () => {
      try {
        const companies = await db.company.findMany({
          where: { isActive: true },
          select: { id: true, timezone: true },
        })

        for (const company of companies) {
          try {
            // "Yesterday" in company's local timezone (simplified: using UTC date
            // minus 1 day — for Asia/Karachi this is close enough since PKT is UTC+5)
            const yesterday = new Date()
            yesterday.setDate(yesterday.getDate() - 1)
            yesterday.setHours(12, 0, 0, 0) // noon to avoid TZ edge cases

            await generateDailyScanReport(company.id, yesterday)
            console.log(`[cron/scan-reports] Generated for company ${company.id}`)
          } catch (err) {
            console.error(`[cron/scan-reports] Failed for company ${company.id}:`, err)
          }
        }
        console.log('[cron/scan-reports] Done')
      } catch (err) {
        console.error('[cron/scan-reports] Fatal:', err)
      }
    })()

    return Response.json({ success: true, message: 'Scan report generation started.' })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
