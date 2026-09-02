/**
 * Phase 1.3 Diagnostic — Polling auto-dispatch inventory corruption.
 *
 * Queries the DB for orders (and exchange_shipments) that were auto-dispatched
 * by the PostEx status-polling cron WITHOUT a corresponding 'sale_dispatched'
 * inventory_transaction row — the silent corruption set.
 *
 * Run: bun run scripts/diagnose-dispatch-bug.ts
 *
 * NOTE: Prisma default table names (no @@map) are PascalCase: "Order",
 * "OrderItem", "InventoryTransaction", "InventoryPool", "Company",
 * "OrgProductVariant". exchange_shipments has @@map("exchange_shipments").
 * Column names are camelCase (no @map) so they must be double-quoted.
 */
import { config } from 'dotenv'
config()
import { PrismaClient, Prisma } from '@prisma/client'
const p = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

interface AffectedOrder {
  id: string
  flowops_order_number: string
  status: string
  dispatched_at: Date | null
  delivered_at: Date | null
  returned_at: Date | null
  courier_name: string | null
  tracking_number: string | null
  company_name: string | null
  item_count: bigint
  total_qty: bigint
}

console.log('═'.repeat(80))
console.log('PHASE 1.3 DIAGNOSTIC — Polling auto-dispatch inventory corruption')
console.log('═'.repeat(80))

// ── Query 1: Orders with status='dispatched' AND no sale_dispatched txn ──
const dispatchedAffected = await p.$queryRaw<AffectedOrder[]>`
  SELECT
    o.id,
    o."flowopsOrderNumber" AS flowops_order_number,
    o.status,
    o."dispatchedAt" AS dispatched_at,
    o."deliveredAt" AS delivered_at,
    o."returnedAt" AS returned_at,
    o."courierName" AS courier_name,
    o."trackingNumber" AS tracking_number,
    c.name AS company_name,
    (SELECT COUNT(*) FROM "OrderItem" oi WHERE oi."orderId" = o.id) AS item_count,
    (SELECT COALESCE(SUM(oi.quantity), 0) FROM "OrderItem" oi WHERE oi."orderId" = o.id) AS total_qty
  FROM "Order" o
  LEFT JOIN "Company" c ON c.id = o."companyId"
  WHERE o.status = 'dispatched'
    AND NOT EXISTS(
      SELECT 1 FROM "InventoryTransaction" it
      WHERE it."referenceType" = 'order'
        AND it."referenceId" = o.id
        AND it."transactionType" = 'sale_dispatched'
    )
  ORDER BY o."dispatchedAt" DESC NULLS LAST;
`

console.log('\n── PRIMARY AFFECTED SET: status=\'dispatched\' (no sale_dispatched txn) ──')
console.log(`COUNT: ${dispatchedAffected.length}`)
for (const o of dispatchedAffected) {
  console.log(
    `  • ${o.flowops_order_number} | status=${o.status} | dispatched=${o.dispatched_at?.toISOString() ?? 'NULL'} | ` +
    `courier=${o.courier_name ?? 'NULL'} | tracking=${o.tracking_number ?? 'NULL'} | ` +
    `company=${o.company_name ?? 'NULL'} | items=${o.item_count} | qty=${o.total_qty} | id=${o.id}`,
  )
}

// ── Query 2: Orders with status='delivered' AND no sale_dispatched txn ──
const deliveredAffected = await p.$queryRaw<AffectedOrder[]>`
  SELECT
    o.id,
    o."flowopsOrderNumber" AS flowops_order_number,
    o.status,
    o."dispatchedAt" AS dispatched_at,
    o."deliveredAt" AS delivered_at,
    o."returnedAt" AS returned_at,
    o."courierName" AS courier_name,
    o."trackingNumber" AS tracking_number,
    c.name AS company_name,
    (SELECT COUNT(*) FROM "OrderItem" oi WHERE oi."orderId" = o.id) AS item_count,
    (SELECT COALESCE(SUM(oi.quantity), 0) FROM "OrderItem" oi WHERE oi."orderId" = o.id) AS total_qty
  FROM "Order" o
  LEFT JOIN "Company" c ON c.id = o."companyId"
  WHERE o.status = 'delivered'
    AND NOT EXISTS(
      SELECT 1 FROM "InventoryTransaction" it
      WHERE it."referenceType" = 'order'
        AND it."referenceId" = o.id
        AND it."transactionType" = 'sale_dispatched'
    )
  ORDER BY o."dispatchedAt" DESC NULLS LAST;
`

console.log('\n── SECONDARY: status=\'delivered\' (auto-dispatched then auto-delivered, no sale_dispatched txn) ──')
console.log(`COUNT: ${deliveredAffected.length}`)
for (const o of deliveredAffected) {
  console.log(
    `  • ${o.flowops_order_number} | status=${o.status} | dispatched=${o.dispatched_at?.toISOString() ?? 'NULL'} | ` +
    `delivered=${o.delivered_at?.toISOString() ?? 'NULL'} | courier=${o.courier_name ?? 'NULL'} | ` +
    `tracking=${o.tracking_number ?? 'NULL'} | company=${o.company_name ?? 'NULL'} | items=${o.item_count} | qty=${o.total_qty} | id=${o.id}`,
  )
}

// ── Query 3: Orders with status='rto' AND no sale_dispatched txn ──
const rtoAffected = await p.$queryRaw<AffectedOrder[]>`
  SELECT
    o.id,
    o."flowopsOrderNumber" AS flowops_order_number,
    o.status,
    o."dispatchedAt" AS dispatched_at,
    o."deliveredAt" AS delivered_at,
    o."returnedAt" AS returned_at,
    o."courierName" AS courier_name,
    o."trackingNumber" AS tracking_number,
    c.name AS company_name,
    (SELECT COUNT(*) FROM "OrderItem" oi WHERE oi."orderId" = o.id) AS item_count,
    (SELECT COALESCE(SUM(oi.quantity), 0) FROM "OrderItem" oi WHERE oi."orderId" = o.id) AS total_qty
  FROM "Order" o
  LEFT JOIN "Company" c ON c.id = o."companyId"
  WHERE o.status = 'rto'
    AND NOT EXISTS(
      SELECT 1 FROM "InventoryTransaction" it
      WHERE it."referenceType" = 'order'
        AND it."referenceId" = o.id
        AND it."transactionType" = 'sale_dispatched'
    )
  ORDER BY o."dispatchedAt" DESC NULLS LAST;
`

console.log('\n── SECONDARY: status=\'rto\' (auto-dispatched then auto-RTO, no sale_dispatched txn) ──')
console.log(`COUNT: ${rtoAffected.length}`)
for (const o of rtoAffected) {
  console.log(
    `  • ${o.flowops_order_number} | status=${o.status} | dispatched=${o.dispatched_at?.toISOString() ?? 'NULL'} | ` +
    `returned=${o.returned_at?.toISOString() ?? 'NULL'} | courier=${o.courier_name ?? 'NULL'} | ` +
    `tracking=${o.tracking_number ?? 'NULL'} | company=${o.company_name ?? 'NULL'} | items=${o.item_count} | qty=${o.total_qty} | id=${o.id}`,
  )
}

// ── Query 4: Item-level detail for the primary affected set (dispatched) ──
const primaryIds = dispatchedAffected.map((o) => o.id)
let itemDetails: Array<{
  order_number: string
  order_id: string
  order_status: string
  order_item_id: string
  sku: string | null
  org_variant_id: string
  quantity: number
  fulfillment_status: string
  reserved_location_id: string | null
  pool_on_hand: number | null
  pool_reserved: number | null
  pool_available: number | null
  pool_avg_cost: number | null
}> = []

if (primaryIds.length > 0) {
  itemDetails = await p.$queryRaw`
    SELECT
      o."flowopsOrderNumber" AS order_number,
      o.id AS order_id,
      o.status AS order_status,
      oi.id AS order_item_id,
      v.sku,
      oi."orgVariantId" AS org_variant_id,
      oi.quantity,
      oi."fulfillmentStatus" AS fulfillment_status,
      oi."reservedLocationId" AS reserved_location_id,
      ip."onHand" AS pool_on_hand,
      ip.reserved AS pool_reserved,
      (ip."onHand" - ip.reserved) AS pool_available,
      ip."avgCost" AS pool_avg_cost
    FROM "Order" o
    JOIN "OrderItem" oi ON oi."orderId" = o.id
    LEFT JOIN "OrgProductVariant" v ON v.id = oi."orgVariantId"
    LEFT JOIN "InventoryPool" ip ON ip."orgVariantId" = oi."orgVariantId"
      AND ip."locationId" = COALESCE(oi."reservedLocationId", o."dispatchLocationId")
    WHERE o.id IN (${Prisma.join(primaryIds)})
    ORDER BY o."flowopsOrderNumber", oi.id;
  `
}

console.log('\n── ITEM-LEVEL DETAIL (primary affected set, status=\'dispatched\') ──')
if (itemDetails.length === 0) {
  console.log('(none — primary affected set is empty)')
} else {
  console.log(`Total affected items: ${itemDetails.length}`)
  for (const it of itemDetails) {
    console.log(
      `  • ${it.order_number} [${it.order_status}] | item=${it.order_item_id.slice(-8)} | ` +
      `sku=${it.sku ?? 'NULL'} | qty=${it.quantity} | fulfillment=${it.fulfillment_status} | ` +
      `loc=${it.reserved_location_id?.slice(-8) ?? 'NULL'} | ` +
      `pool(onHand=${it.pool_on_hand ?? 'NULL'}, reserved=${it.pool_reserved ?? 'NULL'}, ` +
      `available=${it.pool_available ?? 'NULL'}, avgCost=${it.pool_avg_cost ?? 'NULL'})`,
    )
  }
}

// ── EXCHANGE SHIPMENTS ────────────────────────────────────────────────────
const affectedShipments = await p.$queryRaw<Array<{
  id: string
  shipment_number: string
  status: string
  dispatched_at: Date | null
  delivered_at: Date | null
  new_org_variant_id: string
  quantity: number
  company_name: string | null
}>>`
  SELECT
    es.id,
    es."exchangeShipmentNumber" AS shipment_number,
    es.status,
    es."dispatchedAt" AS dispatched_at,
    es."deliveredAt" AS delivered_at,
    es."newOrgVariantId" AS new_org_variant_id,
    es.quantity,
    c.name AS company_name
  FROM exchange_shipments es
  LEFT JOIN "Company" c ON c.id = es."companyId"
  WHERE es.status IN ('dispatched', 'delivered')
    AND es."dispatchedAt" IS NOT NULL
  ORDER BY es."dispatchedAt" DESC;
`

console.log('\n── EXCHANGE SHIPMENTS (status IN dispatched/delivered) ──')
console.log(`Total dispatched/delivered exchange shipments: ${affectedShipments.length}`)
console.log('(NOTE: cannot reliably link to sale_dispatched txns because dispatchExchangeShipment()')
console.log(' does not pass orderId/referenceId to dispatchOrder(). The polling auto-dispatch bug')
console.log(' ALSO bypasses dispatchOrder() for these shipments. Manual audit needed.)')
for (const s of affectedShipments) {
  console.log(
    `  • ${s.shipment_number} | status=${s.status} | dispatched=${s.dispatched_at?.toISOString() ?? 'NULL'} | ` +
    `qty=${s.quantity} | company=${s.company_name ?? 'NULL'} | id=${s.id}`,
  )
}

// ── SUMMARY ───────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(80))
console.log('SUMMARY')
console.log('═'.repeat(80))
console.log(`Orders status='dispatched'  with NO sale_dispatched txn: ${dispatchedAffected.length}  ← PRIMARY AFFECTED SET`)
console.log(`Orders status='delivered'   with NO sale_dispatched txn: ${deliveredAffected.length}  ← (auto-dispatched then auto-delivered)`)
console.log(`Orders status='rto'         with NO sale_dispatched txn: ${rtoAffected.length}  ← (auto-dispatched then auto-RTO; needs different fix)`)
console.log(`Exchange shipments dispatched/delivered (linkage imperfect): ${affectedShipments.length}`)
console.log('')
console.log('RECOMMENDATION:')
console.log('  • Phase 3.2 fix scope (per task): PRIMARY set = status=\'dispatched\' only.')
console.log('    Create missing sale_dispatched txn per item → decrements onHand, releases reserved, locks WAC.')
console.log('  • Delivered orders with missing txn: also create sale_dispatched (item was genuinely sold).')
console.log('  • RTO orders with missing txn: do NOT create sale_dispatched (item came back).')
console.log('    Correct fix = order_unreserved (release the inflated reservation). Report separately.')
console.log('  • Exchange shipments: audit manually; apply performExchangeShipmentDispatch() extraction.')

await p.$disconnect()
