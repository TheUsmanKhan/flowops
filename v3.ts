import { Client } from 'pg'
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const order = await client.query(`SELECT "flowopsOrderNumber", status, "dispatchedAt", "trackingNumber" FROM "Order" WHERE "flowopsOrderNumber" = 'ORD-2026-00004'`)
  console.log('Order:', order.rows[0])
  const item = await client.query(`SELECT "fulfillmentStatus" FROM "OrderItem" WHERE orderId = (SELECT id FROM "Order" WHERE "flowopsOrderNumber" = 'ORD-2026-00004')`)
  console.log('Item:', item.rows[0])
  const txns = await client.query(`SELECT "transactionType", quantity FROM "InventoryTransaction" WHERE "orderId" = (SELECT id FROM "Order" WHERE "flowopsOrderNumber" = 'ORD-2026-00004') ORDER BY "recordedAt"`)
  console.log('Txns:', txns.rows)
  const pool = await client.query(`SELECT "onHand", reserved FROM "InventoryPool" WHERE "orgVariantId" = 'cms0e9cdn0003i71nxmjstwux' AND "locationId" = 'cmrsfhp0t002ftdoc5x5fcbxf'`)
  console.log('Pool:', pool.rows[0])
  await client.end()
}
main().catch(console.error)
