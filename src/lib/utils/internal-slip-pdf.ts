/**
 * Internal Slip PDF Generator — for Self-Fulfilled orders (Phase B2).
 *
 * Uses @react-pdf/renderer (existing dependency) following the EXACT pattern
 * of scan-pdf.ts: React function component via React.createElement (NOT JSX,
 * file is .ts), renderToBuffer(), fs.writeFile to
 * public/uploads/self-fulfilled-slips/<companyId>/.
 *
 * The selfFulfilledReferenceNumber is rendered as BOTH text AND a CODE128
 * barcode image. The barcode is generated via jsbarcode (→ SVG string) →
 * sharp (→ PNG buffer) → embedded as a base64 data URI in the PDF's <Image>.
 *
 * Layout: company name, order number, SF reference (text + barcode),
 * customer name, delivery address/city/country, COD/prepaid amount,
 * item summary.
 */

import { renderToBuffer, Image } from '@react-pdf/renderer'
import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { promises as fs } from 'fs'
import path from 'path'
import JsBarcode from 'jsbarcode'
import sharp from 'sharp'

export interface InternalSlipPdfData {
  companyName: string
  flowopsOrderNumber: string
  selfFulfilledReferenceNumber: string
  customerName: string
  recipientName: string | null
  deliveryAddress: string | null
  deliveryCity: string | null
  deliveryCountry: string | null
  customerPhone: string | null
  /** 'cod' (COD amount) | 'prepaid' (totalOrderValue) | 'partial' (advance + remaining COD) */
  paymentType: string
  /** The amount to collect on delivery (COD) — null for fully prepaid. */
  codAmount: number | null
  totalOrderValue: number
  items: Array<{
    sku: string
    productTitle: string
    quantity: number
    unitPrice: number
  }>
  generatedAt: string
}

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  header: {
    marginBottom: 16,
    borderBottomWidth: 2,
    borderBottomColor: '#0f172a',
    paddingBottom: 10,
  },
  companyName: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
    marginBottom: 2,
  },
  slipTitle: {
    fontSize: 11,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  section: {
    marginTop: 14,
    marginBottom: 6,
  },
  sectionTitle: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  refBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  refText: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
  },
  refLabel: {
    fontSize: 8,
    color: '#64748b',
    marginBottom: 2,
  },
  barcodeImage: {
    width: 280,
    height: 60,
    marginTop: 4,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    marginBottom: 3,
  },
  label: {
    width: 120,
    fontSize: 9,
    color: '#64748b',
  },
  value: {
    flex: 1,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
  },
  amountBox: {
    marginTop: 10,
    padding: 10,
    borderWidth: 2,
    borderColor: '#0f172a',
    borderRadius: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
  },
  amountValue: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    color: '#dc2626',
  },
  itemsTable: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
  },
  itemsHeader: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    padding: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  itemsHeaderText: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: '#475569',
  },
  itemRow: {
    flexDirection: 'row',
    padding: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
  },
  itemText: {
    fontSize: 9,
    color: '#0f172a',
  },
  footer: {
    marginTop: 20,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    fontSize: 8,
    color: '#94a3b8',
    textAlign: 'center',
  },
})

/**
 * Generate a CODE128 barcode SVG string for the given value via jsbarcode.
 * Uses a minimal fake DOM element (jsbarcode needs a DOM-like API + a global
 * `document` for its SVG renderer — neither exists in a pure Node/Bun server
 * context). The fake element captures the rendered SVG as a serializable string.
 */
function generateBarcodeSvg(value: string): string {
  function makeEl(tag: string): any {
    const children: any[] = []
    const attrs: Record<string, string> = {}
    return {
      tagName: tag,
      nodeName: tag,
      style: {} as Record<string, string>,
      attributes: attrs,
      children,
      setAttribute(n: string, v: string) { attrs[n] = String(v) },
      setAttributeNS(_ns: string, n: string, v: string) { attrs[n] = String(v) },
      hasAttribute(n: string) { return n in attrs },
      removeAttribute(n: string) { delete attrs[n] },
      appendChild(c: any) { children.push(c); return c },
      removeChild(c: any) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1) },
      getAttribute(n: string) { return attrs[n] || null },
      createElementNS(_ns: string, t: string) { return makeEl(t) },
      createElement(t: string) { return makeEl(t) },
      toSVG() {
        const a = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')
        const inner = children.map((c) => c.toSVG()).join('')
        return `<${tag}${a ? ' ' + a : ''}>${inner}</${tag}>`
      },
    }
  }

  // jsbarcode's SVG renderer references a global `document` for text-width
  // measurement (only used when displayValue=true; we set it false). Provide
  // a minimal stub so the require doesn't throw.
  const fakeDoc = {
    createElementNS(_ns: string, t: string) { return makeEl(t) },
    createElement(t: string) { return makeEl(t) },
  }
  const prevDocument = (globalThis as any).document
  ;(globalThis as any).document = fakeDoc
  try {
    const svgRoot = makeEl('svg')
    JsBarcode(svgRoot, value, {
      format: 'CODE128',
      displayValue: false,
      width: 2,
      height: 60,
      margin: 0,
    })
    return svgRoot.toSVG()
  } finally {
    // Restore the previous global document (undefined in pure Node, but restore anyway)
    ;(globalThis as any).document = prevDocument
  }
}

/**
 * Convert an SVG string to a PNG buffer via sharp (existing dependency).
 * sharp natively supports SVG input → PNG output.
 */
async function svgToPngBuffer(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer()
}

function InternalSlipPdf({ data, barcodeDataUri }: { data: InternalSlipPdfData; barcodeDataUri: string }) {
  const paymentLabel =
    data.paymentType === 'fully_prepaid' ? 'Prepaid Amount'
    : data.paymentType === 'partial_advance' ? 'COD to Collect'
    : 'COD Amount'
  const amountToShow = data.codAmount ?? data.totalOrderValue

  return React.createElement(Document, null,
    React.createElement(Page, { style: styles.page },
      // ── Header ──
      React.createElement(View, { style: styles.header },
        React.createElement(Text, { style: styles.companyName }, data.companyName),
        React.createElement(Text, { style: styles.slipTitle }, 'Self-Fulfilled Delivery Slip'),
      ),
      // ── Reference (text + barcode) ──
      React.createElement(View, { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, 'Reference Number'),
        React.createElement(Text, { style: styles.refText }, data.selfFulfilledReferenceNumber),
        // Barcode image (CODE128 encoding only the reference number)
        React.createElement(Image, { style: styles.barcodeImage, src: barcodeDataUri }),
      ),
      // ── Order + Customer ──
      React.createElement(View, { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, 'Order & Customer'),
        React.createElement(View, { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Order Number'),
          React.createElement(Text, { style: styles.value }, data.flowopsOrderNumber),
        ),
        React.createElement(View, { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Customer'),
          React.createElement(Text, { style: styles.value }, data.customerName),
        ),
        data.recipientName && data.recipientName !== data.customerName
          ? React.createElement(View, { style: styles.row },
              React.createElement(Text, { style: styles.label }, 'Recipient'),
              React.createElement(Text, { style: styles.value }, data.recipientName),
            )
          : null,
        data.customerPhone
          ? React.createElement(View, { style: styles.row },
              React.createElement(Text, { style: styles.label }, 'Phone'),
              React.createElement(Text, { style: styles.value }, data.customerPhone),
            )
          : null,
      ),
      // ── Delivery Address ──
      React.createElement(View, { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, 'Delivery Address'),
        data.deliveryAddress
          ? React.createElement(Text, { style: styles.itemText }, data.deliveryAddress)
          : null,
        React.createElement(Text, { style: styles.itemText },
          [data.deliveryCity, data.deliveryCountry].filter(Boolean).join(', ') || '—',
        ),
      ),
      // ── Amount to Collect ──
      React.createElement(View, { style: styles.amountBox },
        React.createElement(Text, { style: styles.amountLabel }, paymentLabel),
        React.createElement(Text, { style: styles.amountValue }, `Rs. ${amountToShow.toLocaleString('en-PK')}`),
      ),
      // ── Items ──
      data.items.length > 0
        ? React.createElement(View, { style: styles.section },
            React.createElement(Text, { style: styles.sectionTitle }, 'Items'),
            React.createElement(View, { style: styles.itemsTable },
              React.createElement(View, { style: styles.itemsHeader },
                React.createElement(Text, { style: { ...styles.itemsHeaderText, flex: 2 } }, 'Product'),
                React.createElement(Text, { style: { ...styles.itemsHeaderText, width: 60 } }, 'SKU'),
                React.createElement(Text, { style: { ...styles.itemsHeaderText, width: 30, textAlign: 'center' } }, 'Qty'),
                React.createElement(Text, { style: { ...styles.itemsHeaderText, width: 60, textAlign: 'right' } }, 'Price'),
              ),
              ...data.items.map((item, i) =>
                React.createElement(View, { key: i, style: styles.itemRow },
                  React.createElement(Text, { style: { ...styles.itemText, flex: 2 } }, item.productTitle),
                  React.createElement(Text, { style: { ...styles.itemText, width: 60, fontFamily: 'Helvetica' } }, item.sku),
                  React.createElement(Text, { style: { ...styles.itemText, width: 30, textAlign: 'center' } }, String(item.quantity)),
                  React.createElement(Text, { style: { ...styles.itemText, width: 60, textAlign: 'right' } }, `Rs. ${item.unitPrice}`),
                )
              ),
            ),
          )
        : null,
      // ── Footer ──
      React.createElement(Text, { style: styles.footer },
        `Generated ${data.generatedAt} · This is a self-fulfilled order — no courier booking. Keep this slip for your records.`,
      ),
    )
  )
}

/**
 * Generate the internal slip PDF for a self-fulfilled order + store it on disk.
 * Mirrors the exact storage convention of scan-pdf.ts / payslip-pdf.ts:
 *   public/uploads/self-fulfilled-slips/<companyId>/<filename>.pdf
 *
 * @returns the public URL path to the stored PDF (e.g.
 *   '/uploads/self-fulfilled-slips/<companyId>/slip-SF-2026-00001.pdf'), or
 *   null if generation failed.
 */
export async function generateInternalSlipPdf(
  data: InternalSlipPdfData,
  companyId: string,
): Promise<string | null> {
  try {
    // 1. Generate the CODE128 barcode SVG for the reference number
    const barcodeSvg = generateBarcodeSvg(data.selfFulfilledReferenceNumber)
    // 2. Convert SVG → PNG buffer via sharp
    const pngBuffer = await svgToPngBuffer(barcodeSvg)
    // 3. Embed as base64 data URI for @react-pdf/renderer's <Image>
    const barcodeDataUri = `data:image/png;base64,${pngBuffer.toString('base64')}`

    // 4. Render the PDF
    const element = React.createElement(InternalSlipPdf, { data, barcodeDataUri })
    const buffer = await renderToBuffer(element as any)

    // 5. Store on disk (same /uploads pattern as scan-reports + payslips)
    const dir = path.join(process.cwd(), 'public', 'uploads', 'self-fulfilled-slips', companyId)
    await fs.mkdir(dir, { recursive: true })
    const filename = `slip-${data.selfFulfilledReferenceNumber}.pdf`
    const filepath = path.join(dir, filename)
    await fs.writeFile(filepath, buffer)

    return `/uploads/self-fulfilled-slips/${companyId}/${filename}`
  } catch (err) {
    console.error('[internal-slip-pdf] Failed to generate PDF:', err)
    return null
  }
}
