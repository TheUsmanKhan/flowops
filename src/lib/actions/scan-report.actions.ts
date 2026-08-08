/**
 * Scan Report Server Actions — on-demand and daily report queries.
 *
 * Phase 5: getScanReport() — hybrid stored+live query.
 * Phase 4: generateDailyScanReport() — called by the cron job.
 */

import { db } from '@/lib/db'
import { getWorkspace } from '@/lib/workspace'
import { generateScanReportPdf } from '@/lib/utils/scan-pdf'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface ScanReportData {
  dateFrom: string
  dateTo: string
  totalScans: number
  totalProcessingMarked: number
  totalPacked: number
  totalWarehouseHandover: number
  totalReturnsReceived: number
  totalCancellationsViaScan: number
  totalRejectedScans: number
  breakdownByEmployee: Array<{
    employeeId: string
    employeeName: string
    processingCount: number
    packedCount: number
    warehouseHandoverCount: number
    returnsCount: number
    cancellationsCount: number
    rejectedCount: number
    totalCount: number
  }>
}

/**
 * Get a scan report for a date range. Uses stored daily reports for past
 * days, live-queries today. Supports employee and customer filters.
 */
export async function getScanReport(
  dateFrom: string,
  dateTo: string,
  filters?: { employeeId?: string; customerId?: string },
): Promise<ActionResult<ScanReportData>> {
  try {
    const ctx = await getWorkspace()

    // If customer filter → always live query (stored reports don't have customer breakdown)
    if (filters?.customerId) {
      return liveScanReport(ctx.company.id, ctx.company.organizationId, dateFrom, dateTo, filters)
    }

    // Split range into past days (use stored) + today (live)
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    const from = new Date(dateFrom)
    const to = new Date(dateTo)
    to.setHours(23, 59, 59, 999)

    const pastDays: string[] = []
    let includesToday = false

    const cursor = new Date(from)
    while (cursor <= to) {
      const dayStr = cursor.toISOString().slice(0, 10)
      if (dayStr < todayStr) {
        pastDays.push(dayStr)
      } else if (dayStr === todayStr) {
        includesToday = true
      }
      cursor.setDate(cursor.getDate() + 1)
    }

    // Fetch stored reports for past days
    let merged: ScanReportData = {
      dateFrom, dateTo,
      totalScans: 0, totalProcessingMarked: 0, totalPacked: 0,
      totalWarehouseHandover: 0, totalReturnsReceived: 0,
      totalCancellationsViaScan: 0, totalRejectedScans: 0,
      breakdownByEmployee: [],
    }

    if (pastDays.length > 0) {
      const stored = await db.scanDailyReport.findMany({
        where: {
          companyId: ctx.company.id,
          reportDate: { gte: new Date(pastDays[0]), lte: new Date(pastDays[pastDays.length - 1] + 'T23:59:59') },
        },
      })

      const foundDays = new Set(stored.map((r) => r.reportDate.toISOString().slice(0, 10)))

      // Use stored reports where available
      for (const report of stored) {
        merged.totalScans += report.totalScans
        merged.totalProcessingMarked += report.totalProcessingMarked
        merged.totalPacked += report.totalPacked
        merged.totalWarehouseHandover += report.totalWarehouseHandover
        merged.totalReturnsReceived += report.totalReturnsReceived
        merged.totalCancellationsViaScan += report.totalCancellationsViaScan
        merged.totalRejectedScans += report.totalRejectedScans

        // Merge employee breakdown
        const employees = JSON.parse(report.breakdownByEmployee) as ScanReportData['breakdownByEmployee']
        for (const emp of employees) {
          if (filters?.employeeId && emp.employeeId !== filters.employeeId) continue
          const existing = merged.breakdownByEmployee.find((e) => e.employeeId === emp.employeeId)
          if (existing) {
            existing.processingCount += emp.processingCount
            existing.packedCount += emp.packedCount
            existing.warehouseHandoverCount += emp.warehouseHandoverCount
            existing.returnsCount += emp.returnsCount
            existing.cancellationsCount += emp.cancellationsCount
            existing.rejectedCount += emp.rejectedCount
            existing.totalCount += emp.totalCount
          } else {
            merged.breakdownByEmployee.push({ ...emp })
          }
        }
      }

      // Live-query any past days that don't have stored reports yet
      for (const day of pastDays) {
        if (!foundDays.has(day)) {
          const dayStart = new Date(day + 'T00:00:00')
          const dayEnd = new Date(day + 'T23:59:59.999')
          const liveData = await liveQueryDay(ctx.company.id, dayStart, dayEnd, filters?.employeeId)
          merged.totalScans += liveData.totalScans
          merged.totalProcessingMarked += liveData.totalProcessingMarked
          merged.totalPacked += liveData.totalPacked
          merged.totalWarehouseHandover += liveData.totalWarehouseHandover
          merged.totalReturnsReceived += liveData.totalReturnsReceived
          merged.totalCancellationsViaScan += liveData.totalCancellationsViaScan
          merged.totalRejectedScans += liveData.totalRejectedScans
          for (const emp of liveData.breakdownByEmployee) {
            const existing = merged.breakdownByEmployee.find((e) => e.employeeId === emp.employeeId)
            if (existing) {
              Object.assign(existing, {
                processingCount: existing.processingCount + emp.processingCount,
                packedCount: existing.packedCount + emp.packedCount,
                warehouseHandoverCount: existing.warehouseHandoverCount + emp.warehouseHandoverCount,
                returnsCount: existing.returnsCount + emp.returnsCount,
                cancellationsCount: existing.cancellationsCount + emp.cancellationsCount,
                rejectedCount: existing.rejectedCount + emp.rejectedCount,
                totalCount: existing.totalCount + emp.totalCount,
              })
            } else {
              merged.breakdownByEmployee.push({ ...emp })
            }
          }
        }
      }
    }

    // Live-query today if included
    if (includesToday) {
      const todayStart = new Date(todayStr + 'T00:00:00')
      const todayEnd = now
      const liveData = await liveQueryDay(ctx.company.id, todayStart, todayEnd, filters?.employeeId)
      merged.totalScans += liveData.totalScans
      merged.totalProcessingMarked += liveData.totalProcessingMarked
      merged.totalPacked += liveData.totalPacked
      merged.totalWarehouseHandover += liveData.totalWarehouseHandover
      merged.totalReturnsReceived += liveData.totalReturnsReceived
      merged.totalCancellationsViaScan += liveData.totalCancellationsViaScan
      merged.totalRejectedScans += liveData.totalRejectedScans
      for (const emp of liveData.breakdownByEmployee) {
        const existing = merged.breakdownByEmployee.find((e) => e.employeeId === emp.employeeId)
        if (existing) {
          Object.assign(existing, {
            processingCount: existing.processingCount + emp.processingCount,
            packedCount: existing.packedCount + emp.packedCount,
            warehouseHandoverCount: existing.warehouseHandoverCount + emp.warehouseHandoverCount,
            returnsCount: existing.returnsCount + emp.returnsCount,
            cancellationsCount: existing.cancellationsCount + emp.cancellationsCount,
            rejectedCount: existing.rejectedCount + emp.rejectedCount,
            totalCount: existing.totalCount + emp.totalCount,
          })
        } else {
          merged.breakdownByEmployee.push({ ...emp })
        }
      }
    }

    return { success: true, data: merged }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to get scan report' }
  }
}

/**
 * Generate the daily scan report for a company for a specific date.
 * Used by the cron job (Phase 4).
 */
export async function generateDailyScanReport(companyId: string, reportDate: Date): Promise<ActionResult> {
  try {
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { id: true, organizationId: true, name: true, timezone: true },
    })
    if (!company) return { success: false, error: 'Company not found' }

    const dayStart = new Date(reportDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(reportDate)
    dayEnd.setHours(23, 59, 59, 999)

    const liveData = await liveQueryDay(companyId, dayStart, dayEnd)

    const breakdownJson = JSON.stringify(liveData.breakdownByEmployee)

    // Generate PDF
    const pdfPath = await generateScanReportPdf({
      companyName: company.name,
      dateFrom: dayStart.toISOString().slice(0, 10),
      dateTo: dayStart.toISOString().slice(0, 10),
      totalScans: liveData.totalScans,
      totalProcessingMarked: liveData.totalProcessingMarked,
      totalPacked: liveData.totalPacked,
      totalWarehouseHandover: liveData.totalWarehouseHandover,
      totalReturnsReceived: liveData.totalReturnsReceived,
      totalCancellationsViaScan: liveData.totalCancellationsViaScan,
      totalRejectedScans: liveData.totalRejectedScans,
      breakdownByEmployee: liveData.breakdownByEmployee,
    }, company.id)

    // Upsert into scan_daily_reports
    await db.scanDailyReport.upsert({
      where: { companyId_reportDate: { companyId, reportDate: dayStart } },
      update: {
        totalScans: liveData.totalScans,
        totalProcessingMarked: liveData.totalProcessingMarked,
        totalPacked: liveData.totalPacked,
        totalWarehouseHandover: liveData.totalWarehouseHandover,
        totalReturnsReceived: liveData.totalReturnsReceived,
        totalCancellationsViaScan: liveData.totalCancellationsViaScan,
        totalRejectedScans: liveData.totalRejectedScans,
        breakdownByEmployee: breakdownJson,
        generatedAt: new Date(),
        pdfStoragePath: pdfPath,
      },
      create: {
        organizationId: company.organizationId,
        companyId,
        reportDate: dayStart,
        totalScans: liveData.totalScans,
        totalProcessingMarked: liveData.totalProcessingMarked,
        totalPacked: liveData.totalPacked,
        totalWarehouseHandover: liveData.totalWarehouseHandover,
        totalReturnsReceived: liveData.totalReturnsReceived,
        totalCancellationsViaScan: liveData.totalCancellationsViaScan,
        totalRejectedScans: liveData.totalRejectedScans,
        breakdownByEmployee: breakdownJson,
        pdfStoragePath: pdfPath,
      },
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to generate daily report' }
  }
}

// ─── Helper: live-query a single day ───
async function liveQueryDay(
  companyId: string,
  start: Date,
  end: Date,
  employeeFilter?: string,
): Promise<ScanReportData> {
  const where: any = {
    companyId,
    createdAt: { gte: start, lte: end },
  }
  if (employeeFilter) where.scannedBy = employeeFilter

  const events = await db.scanEvent.findMany({
    where,
    select: {
      scanMode: true,
      scanResult: true,
      scannedBy: true,
      scannedByEmployee: { select: { id: true, user: { select: { fullName: true } } } },
    },
  })

  const result: ScanReportData = {
    dateFrom: start.toISOString().slice(0, 10),
    dateTo: start.toISOString().slice(0, 10),
    totalScans: events.length,
    totalProcessingMarked: 0,
    totalPacked: 0,
    totalWarehouseHandover: 0,
    totalReturnsReceived: 0,
    totalCancellationsViaScan: 0,
    totalRejectedScans: 0,
    breakdownByEmployee: [],
  }

  const employeeMap = new Map<string, ScanReportData['breakdownByEmployee'][0]>()

  for (const ev of events) {
    // Count by mode
    if (ev.scanResult === 'rejected' || ev.scanResult === 'not_found') {
      result.totalRejectedScans++
    } else {
      switch (ev.scanMode) {
        case 'mark_processing': result.totalProcessingMarked++; break
        case 'mark_packed': result.totalPacked++; break
        case 'warehouse_handover': result.totalWarehouseHandover++; break
        case 'receive_return': result.totalReturnsReceived++; break
        case 'cancel_via_scan': result.totalCancellationsViaScan++; break
      }
    }

    // Employee breakdown
    const empId = ev.scannedBy ?? 'unknown'
    const empName = ev.scannedByEmployee?.user?.fullName ?? 'Unknown'
    if (!employeeMap.has(empId)) {
      employeeMap.set(empId, {
        employeeId: empId,
        employeeName: empName,
        processingCount: 0,
        packedCount: 0,
        warehouseHandoverCount: 0,
        returnsCount: 0,
        cancellationsCount: 0,
        rejectedCount: 0,
        totalCount: 0,
      })
    }
    const emp = employeeMap.get(empId)!
    emp.totalCount++
    if (ev.scanResult === 'rejected' || ev.scanResult === 'not_found') {
      emp.rejectedCount++
    } else {
      switch (ev.scanMode) {
        case 'mark_processing': emp.processingCount++; break
        case 'mark_packed': emp.packedCount++; break
        case 'warehouse_handover': emp.warehouseHandoverCount++; break
        case 'receive_return': emp.returnsCount++; break
        case 'cancel_via_scan': emp.cancellationsCount++; break
      }
    }
  }

  result.breakdownByEmployee = Array.from(employeeMap.values()).sort((a, b) => b.totalCount - a.totalCount)
  return result
}

// ─── Helper: live query with customer filter ───
async function liveScanReport(
  companyId: string,
  orgId: string,
  dateFrom: string,
  dateTo: string,
  filters: { employeeId?: string; customerId?: string },
): Promise<ActionResult<ScanReportData>> {
  // Join scan_events → Order/ExchangeShipment → Customer
  const from = new Date(dateFrom)
  from.setHours(0, 0, 0, 0)
  const to = new Date(dateTo)
  to.setHours(23, 59, 59, 999)

  // Find order IDs for this customer
  const orderIds = await db.order.findMany({
    where: { companyId, customerId: filters.customerId },
    select: { id: true },
  })
  const shipmentIds = await db.exchangeShipment.findMany({
    where: { companyId, customerId: filters.customerId },
    select: { id: true },
  })

  const entityIdSet = new Set<string>([
    ...orderIds.map((o) => o.id),
    ...shipmentIds.map((s) => s.id),
  ])

  const where: any = {
    companyId,
    createdAt: { gte: from, lte: to },
    entityId: { in: Array.from(entityIdSet) },
  }
  if (filters.employeeId) where.scannedBy = filters.employeeId

  const events = await db.scanEvent.findMany({
    where,
    select: {
      scanMode: true, scanResult: true,
      scannedBy: true,
      scannedByEmployee: { select: { id: true, user: { select: { fullName: true } } } },
    },
  })

  // Same aggregation logic as liveQueryDay
  const result: ScanReportData = {
    dateFrom, dateTo,
    totalScans: events.length,
    totalProcessingMarked: 0, totalPacked: 0, totalWarehouseHandover: 0,
    totalReturnsReceived: 0, totalCancellationsViaScan: 0, totalRejectedScans: 0,
    breakdownByEmployee: [],
  }
  const empMap = new Map<string, ScanReportData['breakdownByEmployee'][0]>()
  for (const ev of events) {
    if (ev.scanResult === 'rejected' || ev.scanResult === 'not_found') result.totalRejectedScans++
    else switch (ev.scanMode) {
      case 'mark_processing': result.totalProcessingMarked++; break
      case 'mark_packed': result.totalPacked++; break
      case 'warehouse_handover': result.totalWarehouseHandover++; break
      case 'receive_return': result.totalReturnsReceived++; break
      case 'cancel_via_scan': result.totalCancellationsViaScan++; break
    }
    const empId = ev.scannedBy ?? 'unknown'
    const empName = ev.scannedByEmployee?.user?.fullName ?? 'Unknown'
    if (!empMap.has(empId)) empMap.set(empId, { employeeId: empId, employeeName: empName, processingCount: 0, packedCount: 0, warehouseHandoverCount: 0, returnsCount: 0, cancellationsCount: 0, rejectedCount: 0, totalCount: 0 })
    const emp = empMap.get(empId)!
    emp.totalCount++
    if (ev.scanResult === 'rejected' || ev.scanResult === 'not_found') emp.rejectedCount++
    else switch (ev.scanMode) {
      case 'mark_processing': emp.processingCount++; break
      case 'mark_packed': emp.packedCount++; break
      case 'warehouse_handover': emp.warehouseHandoverCount++; break
      case 'receive_return': emp.returnsCount++; break
      case 'cancel_via_scan': emp.cancellationsCount++; break
    }
  }
  result.breakdownByEmployee = Array.from(empMap.values()).sort((a, b) => b.totalCount - a.totalCount)
  return { success: true, data: result }
}
