import { NextRequest } from 'next/server'
import { handleError } from '@/lib/workspace'
import { getScanReport, generateDailyScanReport } from '@/lib/actions/scan-report.actions'
import { generateScanReportPdf } from '@/lib/utils/scan-pdf'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/scan/reports?dateFrom=&dateTo=&employeeId=&customerId= */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const dateFrom = searchParams.get('dateFrom') ?? new Date().toISOString().slice(0, 10)
    const dateTo = searchParams.get('dateTo') ?? dateFrom
    const employeeId = searchParams.get('employeeId') ?? undefined
    const customerId = searchParams.get('customerId') ?? undefined

    const result = await getScanReport(dateFrom, dateTo, { employeeId, customerId })
    if (!result.success) return Response.json({ error: result.error }, { status: 400 })
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/scan/reports — download PDF for a custom range */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { dateFrom, dateTo, employeeId, customerId } = body

    const result = await getScanReport(dateFrom, dateTo, { employeeId, customerId })
    if (!result.success || !result.data) return Response.json({ error: result.error }, { status: 400 })

    // Get company name — BUG FIX: was findFirst({}) with NO where clause
    // (returned ANY user's settings, not the authenticated user's).
    // Now uses getWorkspace() (cached, 0ms) for the correct company.
    const { getWorkspace } = await import('@/lib/workspace')
    const ctx = await getWorkspace()
    const company = await db.company.findUnique({
      where: { id: ctx.company.id },
      select: { name: true, id: true },
    })

    const pdfPath = await generateScanReportPdf({
      companyName: company?.name ?? 'Company',
      ...result.data,
    }, company?.id ?? 'unknown')

    return Response.json({ pdfUrl: pdfPath })
  } catch (err) {
    return handleError(err)
  }
}
