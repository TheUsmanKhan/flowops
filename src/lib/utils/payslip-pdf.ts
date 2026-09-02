/**
 * Payslip PDF Generator — uses @react-pdf/renderer (existing dependency).
 *
 * Follows the same pattern as scan-pdf.ts: render React component to buffer,
 * store under public/uploads/payslips/<companyId>/.
 *
 * Layout: company name, employee name/designation, pay period, full breakdown
 * table (base, commission, allowances, deductions, advance, net pay),
 * generated date.
 */

import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { promises as fs } from 'fs'
import path from 'path'

export interface PayslipPdfData {
  companyName: string
  employeeName: string
  designation: string | null
  periodMonth: number
  periodYear: number
  baseSalary: number
  commissionEarned: number
  otherAllowances: number
  advanceDeduction: number
  otherDeductions: number
  grossPay: number
  netPay: number
  paymentStatus: string
  paymentDate: string | null
  currency: string
  generatedAt: string
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  header: {
    marginBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: '#0f172a',
    paddingBottom: 10,
  },
  companyName: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
  },
  payslipTitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 4,
  },
  section: {
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: {
    color: '#64748b',
  },
  value: {
    fontFamily: 'Helvetica-Bold',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    padding: 8,
    borderRadius: 4,
    marginBottom: 2,
  },
  tableHeaderText: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#475569',
  },
  tableRow: {
    flexDirection: 'row',
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  tableCell: {
    fontSize: 9,
  },
  colDesc: { width: '50%' },
  colAmount: { width: '50%', textAlign: 'right' },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 10,
    backgroundColor: '#0f172a',
    borderRadius: 4,
    marginTop: 8,
  },
  totalLabel: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
  },
  totalValue: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
  },
  footer: {
    marginTop: 30,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    fontSize: 8,
    color: '#94a3b8',
    textAlign: 'center',
  },
})

function PayslipPdf({ data }: { data: PayslipPdfData }) {
  const periodLabel = `${MONTHS[data.periodMonth - 1]} ${data.periodYear}`
  const currency = data.currency || 'PKR'
  const fmt = (n: number) => `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: 'A4', style: styles.page },
      // Header
      React.createElement(
        View,
        { style: styles.header },
        React.createElement(Text, { style: styles.companyName }, data.companyName),
        React.createElement(Text, { style: styles.payslipTitle }, `Payslip — ${periodLabel}`),
      ),
      // Employee info
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Employee'),
          React.createElement(Text, { style: styles.value }, data.employeeName),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Designation'),
          React.createElement(Text, { style: styles.value }, data.designation || '—'),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Pay Period'),
          React.createElement(Text, { style: styles.value }, periodLabel),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Payment Status'),
          React.createElement(Text, { style: styles.value }, data.paymentStatus.toUpperCase()),
        ),
        data.paymentDate &&
          React.createElement(
            View,
            { style: styles.row },
            React.createElement(Text, { style: styles.label }, 'Payment Date'),
            React.createElement(Text, { style: styles.value }, new Date(data.paymentDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })),
          ),
      ),
      // Earnings
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 6, color: '#16a34a' } }, 'EARNINGS'),
        React.createElement(
          View,
          { style: styles.tableHeader },
          React.createElement(Text, { style: [styles.tableHeaderText, styles.colDesc] }, 'Description'),
          React.createElement(Text, { style: [styles.tableHeaderText, styles.colAmount] }, 'Amount'),
        ),
        React.createElement(
          View,
          { style: styles.tableRow },
          React.createElement(Text, { style: [styles.tableCell, styles.colDesc] }, 'Base Salary'),
          React.createElement(Text, { style: [styles.tableCell, styles.colAmount] }, fmt(data.baseSalary)),
        ),
        data.commissionEarned > 0 &&
          React.createElement(
            View,
            { style: styles.tableRow },
            React.createElement(Text, { style: [styles.tableCell, styles.colDesc] }, 'Commission Earned'),
            React.createElement(Text, { style: [styles.tableCell, styles.colAmount] }, fmt(data.commissionEarned)),
          ),
        data.otherAllowances > 0 &&
          React.createElement(
            View,
            { style: styles.tableRow },
            React.createElement(Text, { style: [styles.tableCell, styles.colDesc] }, 'Other Allowances / Bonus'),
            React.createElement(Text, { style: [styles.tableCell, styles.colAmount] }, fmt(data.otherAllowances)),
          ),
        React.createElement(
          View,
          { style: [styles.tableRow, { borderBottomWidth: 0 }] },
          React.createElement(Text, { style: [styles.tableCell, styles.colDesc, { fontFamily: 'Helvetica-Bold' }] }, 'Gross Pay'),
          React.createElement(Text, { style: [styles.tableCell, styles.colAmount, { fontFamily: 'Helvetica-Bold' }] }, fmt(data.grossPay)),
        ),
      ),
      // Deductions
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 6, color: '#dc2626' } }, 'DEDUCTIONS'),
        React.createElement(
          View,
          { style: styles.tableHeader },
          React.createElement(Text, { style: [styles.tableHeaderText, styles.colDesc] }, 'Description'),
          React.createElement(Text, { style: [styles.tableHeaderText, styles.colAmount] }, 'Amount'),
        ),
        data.advanceDeduction > 0 &&
          React.createElement(
            View,
            { style: styles.tableRow },
            React.createElement(Text, { style: [styles.tableCell, styles.colDesc] }, 'Salary Advance Deduction'),
            React.createElement(Text, { style: [styles.tableCell, styles.colAmount] }, fmt(data.advanceDeduction)),
          ),
        data.otherDeductions > 0 &&
          React.createElement(
            View,
            { style: styles.tableRow },
            React.createElement(Text, { style: [styles.tableCell, styles.colDesc] }, 'Other Deductions'),
            React.createElement(Text, { style: [styles.tableCell, styles.colAmount] }, fmt(data.otherDeductions)),
          ),
        (data.advanceDeduction === 0 && data.otherDeductions === 0) &&
          React.createElement(
            View,
            { style: styles.tableRow },
            React.createElement(Text, { style: [styles.tableCell, styles.colDesc, { color: '#94a3b8' }] }, 'No deductions this period'),
            React.createElement(Text, { style: [styles.tableCell, styles.colAmount, { color: '#94a3b8' }] }, fmt(0)),
          ),
      ),
      // Net Pay total
      React.createElement(
        View,
        { style: styles.totalRow },
        React.createElement(Text, { style: styles.totalLabel }, 'NET PAY'),
        React.createElement(Text, { style: styles.totalValue }, fmt(data.netPay)),
      ),
      // Footer
      React.createElement(
        View,
        { style: styles.footer },
        React.createElement(Text, null, `This is a computer-generated payslip from ${data.companyName}. Generated on ${new Date(data.generatedAt).toLocaleString('en-US')}.`),
        React.createElement(Text, { style: { marginTop: 4 } }, 'FlowOps ERP — Employee Payslip'),
      ),
    ),
  )
}

/**
 * Generate a payslip PDF and return the buffer (for streaming to the client).
 */
export async function generatePayslipPdfBuffer(data: PayslipPdfData): Promise<Buffer> {
  const element = React.createElement(PayslipPdf, { data })
  const buffer = await renderToBuffer(element as any)
  return buffer
}

/**
 * Generate a payslip PDF and store it under public/uploads/payslips/<companyId>/.
 * Returns the public path (for pre-generation) or null on failure.
 */
export async function generateAndStorePayslipPdf(
  data: PayslipPdfData,
  companyId: string,
): Promise<string | null> {
  try {
    const buffer = await generatePayslipPdfBuffer(data)
    const dir = path.join(process.cwd(), 'public', 'uploads', 'payslips', companyId)
    await fs.mkdir(dir, { recursive: true })
    const filename = `payslip-${data.periodYear}-${String(data.periodMonth).padStart(2, '0')}-${data.employeeName.replace(/\s+/g, '-')}.pdf`
    const filepath = path.join(dir, filename)
    await fs.writeFile(filepath, buffer)
    return `/uploads/payslips/${companyId}/${filename}`
  } catch (err) {
    console.error('[payslip-pdf] Failed to generate PDF:', err)
    return null
  }
}
