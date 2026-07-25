import { Client } from 'pg'
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  
  // Check the dispatched order
  const order = await client.query(`
    SELECT "flowopsOrderNumber", status, "confirmedAt", "dispatchedAt", "trackingNumber", "courierName"
    FROM "Order" WHERE "flowopsOrderNumber" = 'ORD-2026-00004'
  `)
  console.log('=== Dispatched Order ===')
  console.log(order.rows[0])
  
  // Check the order item
  const item = await client.query(`
    SELECT "fulfillmentStatus", "fulfilledAt", "reservedLocationId"
    FROM "OrderItem" WHERE orderId = (SELECT id FROM "Order" WHERE "flowopsOrderNumber" = 'ORD-2026-00004')
  `)
  console.log('\n=== Order Item ===')
  console.log(item.rows[0])
  
  // Check inventory transactions for this order
  const txns = await client.query(`
    SELECT "transactionType", quantity, "costPerUnit", "referenceType"
    FROM "InventoryTransaction" 
    WHERE "orderId" = (SELECT id FROM "Order" WHERE "flowopsOrderNumber" = 'ORD-2026-00004')
    ORDER BY "recordedAt"
  `)
  console.log('\n=== Inventory Transactions (should show order_reserved + sale_dispatched) ===')
  txns.rows.forEach(t => console.log(`  ${t.transactionType}: qty=${t.quantity}, cost=${t.costPerUnit}, ref=${t.referenceType}`))
  
  // Check the variant's inventory pool
  const pool = await client.query(`
    SELECT p."onHand", p.reserved, p."avgCost", l.name as location
    FROM "InventoryPool" p
    JOIN "InventoryLocation" l ON p."locationId" = l.id
    WHERE p."orgVariantId" = 'cms0e9cdn0003i71nxmjstwux'
  `)
  console.log('\n=== Inventory Pool (after dispatch — onHand should be 8, reserved 0) ===')
  pool.rows.forEach(p => console.log(`  ${p.location}: onHand=${p.onHand}, reserved=${p.reserved}, avgCost=${p.avgCost}`))
  
  await client.end()
}
main().catch(console.error)
