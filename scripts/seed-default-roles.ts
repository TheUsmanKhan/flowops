/**
 * One-time backfill script: seeds the 5 default HR roles (Sales, Sales
 * Manager, Inventory Manager, Warehouse Staff, Manager) for EVERY existing
 * company in the database.
 *
 * Run with: `bun scripts/seed-default-roles.ts`
 *
 * Idempotent — safe to re-run. Uses seedDefaultRolesForCompany() which
 * skips roles that already exist (by companyId + name).
 */
import { seedDefaultRolesForCompany } from '../src/lib/seed-default-roles'
import { db } from '../src/lib/db'

async function main() {
  console.log('=== Seeding default HR roles for all existing companies ===\n')

  const companies = await db.company.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  console.log(`Found ${companies.length} active companies.\n`)

  let totalCreated = 0
  let companiesUpdated = 0

  for (const company of companies) {
    const created = await seedDefaultRolesForCompany(company.id, null)
    if (created > 0) {
      console.log(`  ✅ ${company.name}: created ${created} new role(s)`)
      totalCreated += created
      companiesUpdated++
    } else {
      console.log(`  ⏭️  ${company.name}: all 5 default roles already exist (skipped)`)
    }
  }

  console.log(`\n=== DONE ===`)
  console.log(`Companies processed: ${companies.length}`)
  console.log(`Companies updated:    ${companiesUpdated}`)
  console.log(`Total roles created:  ${totalCreated}`)

  await db.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
