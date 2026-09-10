// ORDERS-CORE-LIFECYCLE-AUDIT — read-only DB query script.
// Runs the 10 audit queries from Part D against the live Supabase DB.

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('\n=== ORDERS-CORE-LIFECYCLE-AUDIT — DB queries ===\n')

  // Q1 — status distribution
  const q1 = await prisma.$queryRaw`
    SELECT status, count(*)::int AS n FROM "Order" GROUP BY status ORDER BY count(*) DESC
  `
  console.log('Q1. SELECT status, count(*) FROM "Order" GROUP BY status ORDER BY count DESC;')
  console.table(q1)

  // Q2 — courierBookingStatus distribution
  const q2 = await prisma.$queryRaw`
    SELECT "courierBookingStatus", count(*)::int AS n FROM "Order" GROUP BY "courierBookingStatus"
  `
  console.log('\nQ2. SELECT "courierBookingStatus", count(*) FROM "Order" GROUP BY "courierBookingStatus";')
  console.table(q2)

  // Q3 — orders with trackingNumber
  const q3 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "Order" WHERE "trackingNumber" IS NOT NULL
  `
  console.log('\nQ3. count(*) orders with trackingNumber IS NOT NULL:')
  console.table(q3)

  // Q4 — courier_status_history count
  const q4 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM courier_status_history
  `
  console.log('\nQ4. count(*) FROM courier_status_history:')
  console.table(q4)

  // Q5 — dispatched orders with NULL trackingNumber
  const q5 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "Order" WHERE status='dispatched' AND "trackingNumber" IS NULL
  `
  console.log('\nQ5. orders status=dispatched AND trackingNumber IS NULL:')
  console.table(q5)

  // Q6 — delivered orders with NULL deliveredAt
  const q6 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "Order" WHERE status='delivered' AND "deliveredAt" IS NULL
  `
  console.log('\nQ6. orders status=delivered AND deliveredAt IS NULL:')
  console.table(q6)

  // Q7 — cancelled orders with NULL cancelledAt
  const q7 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "Order" WHERE status='cancelled' AND "cancelledAt" IS NULL
  `
  console.log('\nQ7. orders status=cancelled AND cancelledAt IS NULL:')
  console.table(q7)

  // Q8 — OrderItems fulfillmentStatus='dispatched' but parent order NOT IN (dispatched, delivered, rto)
  const q8 = await prisma.$queryRaw`
    SELECT oi."orderId", o."flowopsOrderNumber", o.status AS order_status, oi."fulfillmentStatus"
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE oi."fulfillmentStatus"='dispatched'
      AND o.status NOT IN ('dispatched','delivered','rto')
    LIMIT 50
  `
  console.log('\nQ8. OrderItems fulfillmentStatus=dispatched but parent order NOT IN (dispatched, delivered, rto):')
  console.table(q8)
  const q8Count = await prisma.$queryRaw`
    SELECT count(*)::int AS n
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE oi."fulfillmentStatus"='dispatched'
      AND o.status NOT IN ('dispatched','delivered','rto')
  `
  console.log('Q8 count:', q8Count)

  // Q9 — sale_dispatched InventoryTransactions with NULL referenceId
  const q9 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "InventoryTransaction"
    WHERE "transactionType"='sale_dispatched' AND "referenceId" IS NULL
  `
  console.log('\nQ9. sale_dispatched txns with NULL referenceId:')
  console.table(q9)

  const q9b = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "InventoryTransaction"
    WHERE "transactionType"='sale_dispatched' AND "orderId" IS NULL
  `
  console.log('Q9b. sale_dispatched txns with NULL orderId:')
  console.table(q9b)

  // Q10 — avg gap between Order.createdAt and first OrderItem.createdAt
  const q10 = await prisma.$queryRaw`
    SELECT
      count(*)::int AS n_orders_with_items,
      AVG(EXTRACT(EPOCH FROM (oi_first."createdAt" - o."createdAt")) * 1000)::float AS avg_ms,
      MAX(EXTRACT(EPOCH FROM (oi_first."createdAt" - o."createdAt")) * 1000)::float AS max_ms
    FROM "Order" o
    JOIN LATERAL (
      SELECT MIN("createdAt") AS "createdAt" FROM "OrderItem" WHERE "orderId" = o.id
    ) oi_first ON true
  `
  console.log('\nQ10. avg gap between order.createdAt and first order_item.createdAt (ms):')
  console.table(q10)

  // Additional diagnostic — OrderItems where fulfillmentStatus is invalid (not in known set)
  const qExtra1 = await prisma.$queryRaw`
    SELECT "fulfillmentStatus", count(*)::int AS n
    FROM "OrderItem"
    GROUP BY "fulfillmentStatus"
    ORDER BY count(*) DESC
  `
  console.log('\nExtra1. OrderItem fulfillmentStatus distribution (looking for invalid values):')
  console.table(qExtra1)

  // Additional — orders with status=rto but returnedAt IS NULL
  const qExtra2 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "Order" WHERE status='rto' AND "returnedAt" IS NULL
  `
  console.log('\nExtra2. orders status=rto AND returnedAt IS NULL:')
  console.table(qExtra2)

  // Additional — orders with status=delivered but no courier_status_history
  const qExtra3 = await prisma.$queryRaw`
    SELECT count(*)::int AS n
    FROM "Order" o
    WHERE o.status='delivered'
      AND NOT EXISTS (SELECT 1 FROM courier_status_history c WHERE c."orderId" = o.id)
  `
  console.log('\nExtra3. delivered orders with NO CourierStatusHistory entries:')
  console.table(qExtra3)

  // Additional — orders with status='processing' but processingAt missing (schema doesn't have it)
  const qExtra4 = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "Order" WHERE status='processing'
  `
  console.log('\nExtra4. count of processing orders (no processingAt field in schema):')
  console.table(qExtra4)

  // Additional — orders with deliveryCity that looks like a numeric ID (Leopard bug check)
  const qExtra5 = await prisma.$queryRaw`
    SELECT
      o.id,
      o."flowopsOrderNumber",
      o."deliveryCity",
      o."courierName",
      o."courierBookingStatus"
    FROM "Order" o
    WHERE o."deliveryCity" ~ '^\d+$'
    LIMIT 50
  `
  console.log('\nExtra5. orders where deliveryCity looks like a numeric ID (Leopard bug check):')
  console.table(qExtra5)

  const qExtra5Count = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "Order" WHERE "deliveryCity" ~ '^\d+$'
  `
  console.log('Extra5 count:', qExtra5Count)

  // Additional — AuditLog action distribution for orders
  const qExtra6 = await prisma.$queryRaw`
    SELECT action, count(*)::int AS n
    FROM "AuditLog"
    WHERE "entityType"='order'
    GROUP BY action
    ORDER BY count(*) DESC
  `
  console.log('\nExtra6. AuditLog action distribution for orders:')
  console.table(qExtra6)

  // Additional — orders with courierBookingStatus=booked but NULL trackingNumber
  const qExtra7 = await prisma.$queryRaw`
    SELECT count(*)::int AS n
    FROM "Order"
    WHERE "courierBookingStatus"='booked' AND "trackingNumber" IS NULL
  `
  console.log('\nExtra7. orders courierBookingStatus=booked AND trackingNumber IS NULL:')
  console.table(qExtra7)

  // Additional — RTO orders that have any OrderItem still at fulfillmentStatus='dispatched' (gap)
  const qExtra8 = await prisma.$queryRaw`
    SELECT count(DISTINCT o.id)::int AS n
    FROM "Order" o
    JOIN "OrderItem" oi ON oi."orderId" = o.id
    WHERE o.status='rto' AND oi."fulfillmentStatus"='dispatched'
  `
  console.log('\nExtra8. RTO orders with at least one OrderItem still fulfillmentStatus=dispatched (manual RTO path bug):')
  console.table(qExtra8)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
