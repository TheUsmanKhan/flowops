// Read-only audit queries — no writes.
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

  // Q1 — products with zero variants
  await section(
    'Q1 — OrgProducts with NO OrgProductVariant rows',
    `SELECT p.id, p.title FROM "OrgProduct" p
     LEFT JOIN "OrgProductVariant" v ON v."productId" = p.id
     WHERE v.id IS NULL;`,
  )

  // Q2 — @@unique on OrgProductVariant
  await section(
    'Q2 — Prisma @@unique indexes on OrgProductVariant (information_schema)',
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'OrgProductVariant'
     ORDER BY indexname;`,
  )

  // Q3 — variants with > 3 attributeValues keys (DB jsonb_object_keys)
  await section(
    'Q3 — OrgProductVariant.attributeValues max 3 keys',
    `SELECT id, count(*) AS key_count
     FROM (
       SELECT id, jsonb_object_keys(("attributeValues"::jsonb)) AS key
       FROM "OrgProductVariant"
     ) s
     GROUP BY id
     HAVING count(*) > 3
     LIMIT 50;`,
  )

  // Q5 — sync flag consistency: pick 3 variants with sync=true
  await section(
    'Q5a — costPriceSyncedWithParent=true sample (3 rows)',
    `SELECT id, sku, "costPrice", "costPriceSyncedWithParent", "weightSyncedWithParent"
     FROM "OrgProductVariant"
     WHERE "costPriceSyncedWithParent" = true
     LIMIT 3;`,
  )
  await section(
    'Q5b — weightSyncedWithParent=true sample (3 rows)',
    `SELECT id, sku, "weightKg", "weightSyncedWithParent", "costPriceSyncedWithParent"
     FROM "OrgProductVariant"
     WHERE "weightSyncedWithParent" = true
     LIMIT 3;`,
  )
  await section(
    'Q5c — CompanyVariantPricing sync=true sample (3 rows)',
    `SELECT id, "companyId", "orgVariantId", "salePrice", "salePriceSyncedWithParent", "comparePriceSyncedWithParent"
     FROM "CompanyVariantPricing"
     WHERE "salePriceSyncedWithParent" = true
     LIMIT 3;`,
  )

  // Q6 — CompanyVariantPricing: exactly one active row per (companyId, orgVariantId)
  await section(
    'Q6 — CompanyVariantPricing duplicate (companyId, orgVariantId) check',
    `SELECT "companyId", "orgVariantId", count(*) AS row_count
     FROM "CompanyVariantPricing"
     GROUP BY "companyId", "orgVariantId"
     HAVING count(*) > 1
     LIMIT 50;`,
  )
  await section(
    'Q6b — CompanyVariantPricing active vs inactive split',
    `SELECT "isActive", count(*) FROM "CompanyVariantPricing" GROUP BY "isActive";`,
  )

  // Q7 — ReturnedStitchedInventory with invalid inventoryTxnId link
  await section(
    'Q7 — ReturnedStitchedInventory: total rows + NULL inventoryTxnId count',
    `SELECT count(*) AS total_rows,
            count(*) FILTER (WHERE "inventoryTxnId" IS NULL) AS null_txn,
            count(*) FILTER (WHERE "inventoryTxnId" IS NOT NULL) AS linked_txn
     FROM "ReturnedStitchedInventory";`,
  )
  await section(
    'Q7b — ReturnedStitchedInventory rows where inventoryTxnId has no matching InventoryTransaction',
    `SELECT r.id, r."inventoryTxnId"
     FROM "ReturnedStitchedInventory" r
     LEFT JOIN "InventoryTransaction" t ON t.id = r."inventoryTxnId"
     WHERE r."inventoryTxnId" IS NOT NULL AND t.id IS NULL
     LIMIT 20;`,
  )
  await section(
    'Q7c — ReturnedStitchedInventory schema columns (verify locationId presence)',
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'ReturnedStitchedInventory'
     ORDER BY ordinal_position;`,
  )

  // Bonus — trackInventory false→true back to false audit
  await section(
    'Q4 — count of variants where trackInventory=false (made_to_order should still be FALSE until first return)',
    `SELECT "fulfillmentType", trackInventory, count(*)
     FROM "OrgProductVariant"
     GROUP BY "fulfillmentType", trackInventory
     ORDER BY 1,2;`,
  )

  // Bonus — promote visibility sanity
  await section(
    'B1 — Products promoted to organization scope count',
    `SELECT "productScope", count(*) FROM "OrgProduct" GROUP BY "productScope" ORDER BY 1;`,
  )
  await section(
    'B2 — SelectiveProductAccess for products NOT currently selective (stale rows)',
    `SELECT p.id, p.title, p."productScope", count(s.id) AS access_rows
     FROM "OrgProduct" p
     LEFT JOIN "SelectiveProductAccess" s ON s."orgProductId" = p.id
     WHERE p."productScope" NOT IN ('selective')
     GROUP BY p.id, p.title, p."productScope"
     HAVING count(s.id) > 0
     LIMIT 20;`,
  )

  // Bonus — CompanyProductSetting rows in revoked state still pointing at active scope
  await section(
    'B3 — Subscriptions revoked but product scope still organization/selective',
    `SELECT cps."subscriptionStatus", cps."isActive", p."productScope", count(*) AS n
     FROM "CompanyProductSetting" cps
     JOIN "OrgProduct" p ON p.id = cps."orgProductId"
     GROUP BY cps."subscriptionStatus", cps."isActive", p."productScope"
     ORDER BY 1,2,3;`,
  )

  // Bonus — InventoryPool rows for made_to_order variants that were never opened
  await section(
    'B4 — InventoryPool rows for made_to_order variants (trackInventory=false)',
    `SELECT v."fulfillmentType", v."trackInventory", count(ip.id) AS pool_rows
     FROM "OrgProductVariant" v
     LEFT JOIN "InventoryPool" ip ON ip."orgVariantId" = v.id
     GROUP BY v."fulfillmentType", v."trackInventory"
     ORDER BY 1,2;`,
  )

  await client.end()
}

run().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
