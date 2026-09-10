// Read-only audit queries — second batch
const { Client } = require('pg')

const client = new Client({
  host: 'aws-0-ap-south-1.pooler.supabase.com',
  port: 5432,
  database: 'postgres',
  user: 'postgres.gobwxqkzfulbwhzbbsdj',
  password: '123@Usman123@',
  ssl: { rejectUnauthorized: false },
})

async function section(name, sql) {
  console.log('\n==================== ' + name + ' ====================')
  try {
    const r = await client.query(sql)
    console.log(JSON.stringify(r.rows, null, 2))
    console.log(`rowCount=${r.rowCount}`)
  } catch (e) {
    console.log('ERR:', e.message)
  }
}

async function run() {
  await client.connect()

  // Q4 — trackInventory count by (fulfillmentType, trackInventory)
  await section(
    'Q4 — trackInventory one-way check (variants grouped by fulfillment+track)',
    `SELECT "fulfillmentType", "trackInventory", count(*) FROM "OrgProductVariant"
     GROUP BY "fulfillmentType", "trackInventory"
     ORDER BY 1,2;`,
  )

  // ReturnedStitchedInventory row sample to confirm locationId is NOT a column
  await section(
    'ReturnedStitchedInventory sample rows (2 most recent)',
    `SELECT id, "orgVariantId", "companyId", status, quantity, "receivedAt"
     FROM "ReturnedStitchedInventory"
     ORDER BY "receivedAt" DESC
     LIMIT 5;`,
  )

  // Cross-check: any OrgProductVariant where costPriceSyncedWithParent=false but
  // variants in same group share different costPrice — i.e., likely the override
  // happened but the cascade was never applied to synced siblings. Just a sanity check.
  await section(
    'S1 — variants with costPriceSyncedWithParent=false (overrides)',
    `SELECT "productId", sku, "costPrice", "costPriceSyncedWithParent"
     FROM "OrgProductVariant"
     WHERE "costPriceSyncedWithParent" = false
     LIMIT 20;`,
  )

  await section(
    'S2 — OrgProductBundle rows (should be 0 if model never written)',
    `SELECT count(*) AS n FROM "OrgProductBundle";`,
  )

  await section(
    'S3 — Image upload count (sanity)',
    `SELECT count(*) AS total FROM "OrgProductImage";`,
  )

  await section(
    'S4 — SelectiveProductAccess rows total',
    `SELECT count(*) AS n FROM "SelectiveProductAccess";`,
  )

  await section(
    'S5 — Audit log actions under product.*',
    `SELECT action, count(*) FROM "AuditLog"
     WHERE action LIKE 'product.%' OR action LIKE 'variant.%' OR action LIKE 'returned_stitched.%'
     GROUP BY action
     ORDER BY 2 DESC
     LIMIT 40;`,
  )

  await client.end()
}

run().catch((e) => { console.error('FATAL:', e); process.exit(1) })
