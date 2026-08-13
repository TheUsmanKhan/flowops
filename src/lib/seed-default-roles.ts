/**
 * Default role definitions for the HR / Sales / Inventory module.
 *
 * These 5 roles are seeded for EVERY company — both existing companies
 * (one-time backfill) and newly created companies (via seedDefaultRolesForCompany
 * called from the company-create API route).
 *
 * IMPORTANT: none of these roles get any Employees/Settings/Integrations/Payroll
 * permissions by default — those stay reserved for Owner/elevated roles or
 * explicit manual grants.
 *
 * All 5 roles have isSystemRole=false — they are fully editable/deletable
 * by the company's Owner (unlike Owner/Founder/Co-Founder/Investor which
 * are isSystemRole=true and cannot be deleted).
 */

import { db } from '@/lib/db'
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions'

interface DefaultRoleDef {
  name: string
  description: string
  /** "own" = sees only their own orders (salesEmployeeId === self); "all" = sees all orders */
  ordersDataScope: 'own' | 'all'
  permissions: PermissionKey[]
}

export const DEFAULT_ROLES: DefaultRoleDef[] = [
  {
    name: 'Sales',
    description: 'Frontline sales agent — creates orders for their own customers, sees only their own orders.',
    ordersDataScope: 'own',
    permissions: [
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.CUSTOMERS_VIEW,
      PERMISSIONS.CUSTOMERS_CREATE,
      PERMISSIONS.CUSTOMERS_EDIT,
      PERMISSIONS.PRODUCTS_VIEW,
    ],
  },
  {
    name: 'Sales Manager',
    description: 'Manages the sales team — sees all orders, can fulfill/cancel, views employee salary summaries.',
    ordersDataScope: 'all',
    permissions: [
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_FULFILL,
      PERMISSIONS.ORDERS_CANCEL,
      PERMISSIONS.ORDERS_MANAGE,
      PERMISSIONS.CUSTOMERS_VIEW,
      PERMISSIONS.CUSTOMERS_CREATE,
      PERMISSIONS.CUSTOMERS_EDIT,
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.FINANCE_VIEW,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.KPI_VIEW,
      PERMISSIONS.EMPLOYEES_VIEW_SALARY,
    ],
  },
  {
    name: 'Inventory Manager',
    description: 'Manages stock, warehouses, POs, supplier returns, cycle counts, and production orders.',
    ordersDataScope: 'all',
    permissions: [
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.PRODUCTS_EDIT,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.INVENTORY_CREATE,
      PERMISSIONS.INVENTORY_ADJUST,
      PERMISSIONS.INVENTORY_RECEIVE,
      PERMISSIONS.INVENTORY_TRANSFER,
      PERMISSIONS.INVENTORY_MANAGE_LOCATIONS,
      PERMISSIONS.INVENTORY_MANAGE_SUPPLIERS,
      PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS,
      PERMISSIONS.INVENTORY_MANAGE_SUPPLIER_RETURNS,
      PERMISSIONS.INVENTORY_CYCLE_COUNT,
      PERMISSIONS.INVENTORY_MANAGE_PRODUCTION,
      PERMISSIONS.INVENTORY_REPORT_LOSS,
      PERMISSIONS.INVENTORY_MANAGE_LOSS,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.KPI_VIEW,
    ],
  },
  {
    name: 'Warehouse Staff',
    description: 'Warehouse operations — receives stock, transfers, cycle counts, and operates the scan station.',
    ordersDataScope: 'own', // safe minimum — they don't typically view Orders directly
    permissions: [
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.INVENTORY_RECEIVE,
      PERMISSIONS.INVENTORY_TRANSFER,
      PERMISSIONS.INVENTORY_CYCLE_COUNT,
      PERMISSIONS.SCAN_OPERATE,
    ],
  },
  {
    name: 'Manager',
    description: 'General manager — broad operational access across orders, products, inventory, reports, and audit.',
    ordersDataScope: 'all',
    permissions: [
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_FULFILL,
      PERMISSIONS.ORDERS_CANCEL,
      PERMISSIONS.ORDERS_MANAGE,
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.PRODUCTS_EDIT,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.INVENTORY_ADJUST,
      PERMISSIONS.FINANCE_VIEW,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.REPORTS_EXPORT,
      PERMISSIONS.KPI_VIEW,
      PERMISSIONS.AUDIT_VIEW,
    ],
  },
]

/**
 * Seed the 5 default roles for a single company.
 * Idempotent — skips roles that already exist (by companyId + name).
 * Called by:
 *   1. The company-create API route (for newly created companies going forward)
 *   2. The one-time backfill script (scripts/seed-default-roles.ts)
 *
 * @param companyId  The company to seed roles for
 * @param createdById Optional Profile.id of the user creating the roles
 *                   (for audit trail; null for system/cron context)
 * @returns The number of new roles created (0 if all already existed)
 */
export async function seedDefaultRolesForCompany(
  companyId: string,
  createdById?: string | null,
): Promise<number> {
  let created = 0

  for (const roleDef of DEFAULT_ROLES) {
    // Check if a role with this name already exists for this company
    // (handles re-runs / idempotency)
    const existing = await db.role.findFirst({
      where: { companyId, name: roleDef.name },
      select: { id: true },
    })
    if (existing) continue

    // Create the role + its permissions in a transaction (atomic)
    await db.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          companyId,
          name: roleDef.name,
          description: roleDef.description,
          roleTier: 'standard',
          isSystemRole: false, // fully editable/deletable, unlike Owner/Founder/etc.
          systemRoleKey: null,
          ordersDataScope: roleDef.ordersDataScope,
          createdById: createdById ?? null,
        },
      })

      // Create all permission grants for this role
      if (roleDef.permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: roleDef.permissions.map((key) => ({
            roleId: role.id,
            companyId,
            permissionKey: key,
          })),
        })
      }
    })

    created++
  }

  return created
}
