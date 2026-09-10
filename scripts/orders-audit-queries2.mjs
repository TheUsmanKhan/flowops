// Verify courier_status_history table schema
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const cols = await prisma.$queryRaw`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'courier_status_history'
    ORDER BY ordinal_position
  `
  console.log('courier_status_history columns:')
  console.table(cols)

  // Also check OrderItem constraint for fulfillmentStatus
  const constraints = await prisma.$queryRaw`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'OrderItem'
  `
  console.log('\nOrderItem constraints:')
  console.table(constraints)

  // Check Order status check constraint
  const orderConstraints = await prisma.$queryRaw`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'Order'
  `
  console.log('\nOrder constraints:')
  console.table(orderConstraints)

  // Count trackingNumber null check for booked orders
  const nullTracking = await prisma.$queryRaw`
    SELECT id, "flowopsOrderNumber", "courierBookingStatus", "trackingNumber", "courierName"
    FROM "Order"
    WHERE "courierBookingStatus"='booked' AND "trackingNumber" IS NULL
  `
  console.log('\nOrders with courierBookingStatus=booked AND NULL trackingNumber:')
  console.table(nullTracking)

  // Count dispatched orders with NULL trackingNumber — get details
  const dispatchedNoTracking = await prisma.$queryRaw`
    SELECT id, "flowopsOrderNumber", "fulfillmentChannel", "selfFulfilledReferenceNumber", "courierName", "courierBookingStatus"
    FROM "Order"
    WHERE status='dispatched' AND "trackingNumber" IS NULL
  `
  console.log('\nDispatched orders with NULL trackingNumber (check self-fulfilled):')
  console.table(dispatchedNoTracking)

  // Sample some sale_dispatched txns with NULL orderId to see what they look like
  const sampleTxns = await prisma.$queryRaw`
    SELECT id, "orgVariantId", "locationId", "transactionType", "referenceType", "referenceId", "orderId", "recordedAt"
    FROM "InventoryTransaction"
    WHERE "transactionType"='sale_dispatched' AND "orderId" IS NULL
    LIMIT 10
  `
  console.log('\nSample sale_dispatched txns with NULL orderId:')
  console.table(sampleTxns)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
