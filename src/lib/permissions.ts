/**
 * Central registry of all permission keys used across FlowOps.
 * Keys use dot-notation `module.action`. Every permission check in the
 * app MUST import from here — never hardcode permission strings.
 *
 * Elevated roles (Owner, Founder, Co-Founder, Investor) bypass these
 * checks entirely via isElevatedEmployee().
 */

export const PERMISSIONS = {
  // Inventory
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_CREATE: 'inventory.create',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_DELETE: 'inventory.delete',

  // Orders
  ORDERS_VIEW: 'orders.view',
  ORDERS_CREATE: 'orders.create',
  ORDERS_FULFILL: 'orders.fulfill',
  ORDERS_CANCEL: 'orders.cancel',

  // Employees
  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_INVITE: 'employees.invite',
  EMPLOYEES_TERMINATE: 'employees.terminate',
  EMPLOYEES_MANAGE: 'employees.manage',

  // Finance
  FINANCE_VIEW: 'finance.view',
  FINANCE_MANAGE: 'finance.manage',

  // Reports
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  // Settings
  SETTINGS_COMPANY_VIEW: 'settings.company.view',
  SETTINGS_COMPANY_EDIT: 'settings.company.edit',
  SETTINGS_ROLES_MANAGE: 'settings.roles.manage',

  // Integrations
  INTEGRATIONS_VIEW: 'integrations.view',
  INTEGRATIONS_MANAGE: 'integrations.manage',

  // KPI
  KPI_VIEW: 'kpi.view',
  KPI_MANAGE: 'kpi.manage',

  // Audit
  AUDIT_VIEW: 'audit.view',
} as const

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

/** Grouped permission catalog for the role editor UI. */
export const PERMISSION_GROUPS: {
  group: string
  icon: string
  permissions: { key: PermissionKey; label: string; description: string }[]
}[] = [
  {
    group: 'Inventory',
    icon: 'Package',
    permissions: [
      { key: PERMISSIONS.INVENTORY_VIEW, label: 'View inventory', description: 'See products, stock levels and warehouses' },
      { key: PERMISSIONS.INVENTORY_CREATE, label: 'Create products', description: 'Add new products and SKUs' },
      { key: PERMISSIONS.INVENTORY_ADJUST, label: 'Adjust stock', description: 'Perform stock adjustments and transfers' },
      { key: PERMISSIONS.INVENTORY_DELETE, label: 'Delete products', description: 'Remove products from catalog' },
    ],
  },
  {
    group: 'Orders',
    icon: 'ShoppingCart',
    permissions: [
      { key: PERMISSIONS.ORDERS_VIEW, label: 'View orders', description: 'See all orders in the company' },
      { key: PERMISSIONS.ORDERS_CREATE, label: 'Create orders', description: 'Manually create orders' },
      { key: PERMISSIONS.ORDERS_FULFILL, label: 'Fulfill orders', description: 'Mark orders as dispatched / delivered' },
      { key: PERMISSIONS.ORDERS_CANCEL, label: 'Cancel orders', description: 'Cancel and refund orders' },
    ],
  },
  {
    group: 'Employees',
    icon: 'Users',
    permissions: [
      { key: PERMISSIONS.EMPLOYEES_VIEW, label: 'View employees', description: 'See the company directory' },
      { key: PERMISSIONS.EMPLOYEES_INVITE, label: 'Invite employees', description: 'Send invitation emails to new hires' },
      { key: PERMISSIONS.EMPLOYEES_TERMINATE, label: 'Terminate employees', description: 'Set employee status to terminated' },
      { key: PERMISSIONS.EMPLOYEES_MANAGE, label: 'Manage employees', description: 'Change roles, suspend, and edit employees' },
    ],
  },
  {
    group: 'Finance',
    icon: 'Wallet',
    permissions: [
      { key: PERMISSIONS.FINANCE_VIEW, label: 'View finance', description: 'See transactions and balances' },
      { key: PERMISSIONS.FINANCE_MANAGE, label: 'Manage finance', description: 'Record payments and expenses' },
    ],
  },
  {
    group: 'Reports',
    icon: 'BarChart3',
    permissions: [
      { key: PERMISSIONS.REPORTS_VIEW, label: 'View reports', description: 'Access reporting dashboards' },
      { key: PERMISSIONS.REPORTS_EXPORT, label: 'Export reports', description: 'Download reports as CSV / PDF' },
    ],
  },
  {
    group: 'Settings',
    icon: 'Settings',
    permissions: [
      { key: PERMISSIONS.SETTINGS_COMPANY_VIEW, label: 'View company settings', description: 'See company configuration' },
      { key: PERMISSIONS.SETTINGS_COMPANY_EDIT, label: 'Edit company settings', description: 'Update company profile and tax info' },
      { key: PERMISSIONS.SETTINGS_ROLES_MANAGE, label: 'Manage roles', description: 'Create and edit custom roles & permissions' },
    ],
  },
  {
    group: 'Integrations',
    icon: 'Plug',
    permissions: [
      { key: PERMISSIONS.INTEGRATIONS_VIEW, label: 'View integrations', description: 'See connected integrations' },
      { key: PERMISSIONS.INTEGRATIONS_MANAGE, label: 'Manage integrations', description: 'Connect / disconnect Shopify, TCS, Meta Ads, etc.' },
    ],
  },
  {
    group: 'KPI & Audit',
    icon: 'Gauge',
    permissions: [
      { key: PERMISSIONS.KPI_VIEW, label: 'View KPIs', description: 'Access KPI dashboards' },
      { key: PERMISSIONS.KPI_MANAGE, label: 'Manage KPIs', description: 'Configure KPI targets and tags' },
      { key: PERMISSIONS.AUDIT_VIEW, label: 'View audit log', description: 'See the immutable event log' },
    ],
  },
]

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_GROUPS.flatMap(
  (g) => g.permissions.map((p) => p.key),
)

export function permissionLabel(key: string): string {
  for (const g of PERMISSION_GROUPS) {
    const found = g.permissions.find((p) => p.key === key)
    if (found) return found.label
  }
  return key
}
