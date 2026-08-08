/**
 * Scan Report PDF Generator — uses @react-pdf/renderer.
 *
 * Chosen over puppeteer because:
 * - Lighter (no headless Chrome dependency)
 * - Works in serverless/edge environments
 * - Already used pattern: render React components to PDF buffer
 */

import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { promises as fs } from 'fs'
import path from 'path'

interface PdfReportData {
  companyName: string
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

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica' },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#666', marginBottom: 20 },
  sectionTitle: { fontSize: 12, fontWeight: 'bold', marginTop: 16, marginBottom: 8 },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { width: '48%', padding: 8, borderWidth: 1, borderColor: '#ddd', borderRadius: 4, marginBottom: 8 },
  cardLabel: { fontSize: 8, color: '#666' },
  cardValue: { fontSize: 16, fontWeight: 'bold' },
  table: { width: '100%', marginTop: 8 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f0f0f0', padding: 6, fontWeight: 'bold', fontSize: 9 },
  tableRow: { flexDirection: 'row', padding: 6, fontSize: 9, borderBottomWidth: 0.5, borderBottomColor: '#ddd' },
  col: { flex: 1 },
  colSm: { width: 60 },
})

function ScanReportPdf({ data }: { data: PdfReportData }) {
  return React.createElement(Document, null,
    React.createElement(Page, { style: styles.page },
      React.createElement(Text, { style: styles.title }, data.companyName),
      React.createElement(Text, { style: styles.subtitle }, `Scan Report — ${data.dateFrom} to ${data.dateTo}`),
      React.createElement(Text, { style: styles.sectionTitle }, 'Summary'),
      React.createElement(View, { style: styles.summaryGrid },
        ...[
          { label: 'Total Scans', value: data.totalScans },
          { label: 'Processing Marked', value: data.totalProcessingMarked },
          { label: 'Packed', value: data.totalPacked },
          { label: 'Warehouse Handover', value: data.totalWarehouseHandover },
          { label: 'Returns Received', value: data.totalReturnsReceived },
          { label: 'Cancellations via Scan', value: data.totalCancellationsViaScan },
          { label: 'Rejected Scans', value: data.totalRejectedScans },
        ].map((card, i) =>
          React.createElement(View, { key: i, style: styles.card },
            React.createElement(Text, { style: styles.cardLabel }, card.label),
            React.createElement(Text, { style: styles.cardValue }, String(card.value)),
          )
        )
      ),
      data.breakdownByEmployee.length > 0 && React.createElement(View, null,
        React.createElement(Text, { style: styles.sectionTitle }, 'Employee Breakdown'),
        React.createElement(View, { style: styles.table },
          React.createElement(View, { style: styles.tableHeader },
            React.createElement(Text, { style: styles.col }, 'Employee'),
            React.createElement(Text, { style: styles.colSm }, 'Proc'),
            React.createElement(Text, { style: styles.colSm }, 'Pack'),
            React.createElement(Text, { style: styles.colSm }, 'Hand'),
            React.createElement(Text, { style: styles.colSm }, 'Ret'),
            React.createElement(Text, { style: styles.colSm }, 'Cancel'),
            React.createElement(Text, { style: styles.colSm }, 'Reject'),
            React.createElement(Text, { style: styles.colSm }, 'Total'),
          ),
          ...data.breakdownByEmployee.map((emp, i) =>
            React.createElement(View, { key: i, style: styles.tableRow },
              React.createElement(Text, { style: styles.col }, emp.employeeName),
              React.createElement(Text, { style: styles.colSm }, String(emp.processingCount)),
              React.createElement(Text, { style: styles.colSm }, String(emp.packedCount)),
              React.createElement(Text, { style: styles.colSm }, String(emp.warehouseHandoverCount)),
              React.createElement(Text, { style: styles.colSm }, String(emp.returnsCount)),
              React.createElement(Text, { style: styles.colSm }, String(emp.cancellationsCount)),
              React.createElement(Text, { style: styles.colSm }, String(emp.rejectedCount)),
              React.createElement(Text, { style: styles.colSm }, String(emp.totalCount)),
            )
          )
        )
      )
    )
  )
}

export async function generateScanReportPdf(data: PdfReportData, companyId: string): Promise<string | null> {
  try {
    const element = React.createElement(ScanReportPdf, { data })
    const buffer = await renderToBuffer(element as any)

    // Store using the same /uploads pattern as payment proofs
    const dir = path.join(process.cwd(), 'public', 'uploads', 'scan-reports', companyId)
    await fs.mkdir(dir, { recursive: true })
    const filename = `scan-report-${data.dateFrom}-to-${data.dateTo}.pdf`
    const filepath = path.join(dir, filename)
    await fs.writeFile(filepath, buffer)

    return `/uploads/scan-reports/${companyId}/${filename}`
  } catch (err) {
    console.error('[scan-pdf] Failed to generate PDF:', err)
    return null
  }
}
