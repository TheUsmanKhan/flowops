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
  INVENTORY_RECEIVE: 'inventory.receive',
  INVENTORY_REPORT_LOSS: 'inventory.report_loss',
  INVENTORY_MANAGE_LOSS: 'inventory.manage_loss',
  INVENTORY_MANAGE_LOCATIONS: 'inventory.manage_locations',
  INVENTORY_MANAGE_SUPPLIERS: 'inventory.manage_suppliers',
  INVENTORY_TRANSFER: 'inventory.transfer',
  INVENTORY_MANAGE_PURCHASE_ORDERS: 'inventory.manage_purchase_orders',
  INVENTORY_MANAGE_SUPPLIER_RETURNS: 'inventory.manage_supplier_returns',
  INVENTORY_CYCLE_COUNT: 'inventory.cycle_count',
  INVENTORY_MANAGE_PRODUCTION: 'inventory.manage_production',

  // Products
  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_EDIT: 'products.edit',
  PRODUCTS_MANAGE_CATALOG: 'products.manage_catalog',
  PRODUCTS_SUBSCRIBE: 'products.subscribe',
  PRODUCTS_PRICING: 'products.pricing',
  PRODUCTS_PROMOTE: 'products.promote',

  // Orders
  ORDERS_VIEW: 'orders.view',
  ORDERS_CREATE: 'orders.create',
  ORDERS_FULFILL: 'orders.fulfill',
  ORDERS_CANCEL: 'orders.cancel',
  ORDERS_MANAGE: 'orders.manage',

  // Customers
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_EDIT: 'customers.edit',

  // Scan
  SCAN_OPERATE: 'scan.operate',
  SCAN_VIEW_REPORTS: 'scan.view_reports',

  // Employees
  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_INVITE: 'employees.invite',
  EMPLOYEES_TERMINATE: 'employees.terminate',
  EMPLOYEES_MANAGE: 'employees.manage',
  EMPLOYEES_MANAGE_SALARY: 'employees.manage_salary',
  EMPLOYEES_VIEW_SALARY: 'employees.view_salary',

  // Payroll
  PAYROLL_MANAGE: 'payroll.manage',
  PAYROLL_VIEW_ALL: 'payroll.view_all',
  PAYROLL_MANAGE_ADVANCES: 'payroll.manage_advances',

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
      { key: PERMISSIONS.INVENTORY_RECEIVE, label: 'Receive stock', description: 'Receive stock into warehouses (PO receiving, opening stock, returned-stitched)' },
      { key: PERMISSIONS.INVENTORY_REPORT_LOSS, label: 'Report stock loss', description: 'Report damaged/theft/in-transit losses' },
      { key: PERMISSIONS.INVENTORY_MANAGE_LOSS, label: 'Manage stock losses', description: 'Review and resolve stock loss records' },
      { key: PERMISSIONS.INVENTORY_MANAGE_LOCATIONS, label: 'Manage locations', description: 'Create and edit inventory locations (warehouses)' },
      { key: PERMISSIONS.INVENTORY_MANAGE_SUPPLIERS, label: 'Manage suppliers', description: 'Create and edit suppliers' },
      { key: PERMISSIONS.INVENTORY_TRANSFER, label: 'Transfer stock', description: 'Move stock between inventory locations' },
      { key: PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS, label: 'Manage purchase orders', description: 'Create, confirm, and receive purchase orders' },
      { key: PERMISSIONS.INVENTORY_MANAGE_SUPPLIER_RETURNS, label: 'Manage supplier returns', description: 'Create and process returns to suppliers' },
      { key: PERMISSIONS.INVENTORY_CYCLE_COUNT, label: 'Cycle counts', description: 'Create and manage cycle count audits' },
      { key: PERMISSIONS.INVENTORY_MANAGE_PRODUCTION, label: 'Manage production', description: 'Manage production orders (made-to-order stitching)' },
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
      { key: PERMISSIONS.ORDERS_MANAGE, label: 'Manage orders', description: 'Confirm orders, convert payments, manage customers' },
    ],
  },
  {
    group: 'Customers',
    icon: 'UserCircle',
    permissions: [
      { key: PERMISSIONS.CUSTOMERS_VIEW, label: 'View customers', description: 'See the customer directory and their order history' },
      { key: PERMISSIONS.CUSTOMERS_CREATE, label: 'Create customers', description: 'Add new customers with phone + address' },
      { key: PERMISSIONS.CUSTOMERS_EDIT, label: 'Edit customers', description: 'Update customer details, phones, addresses' },
    ],
  },
  {
    group: 'Scan',
    icon: 'ScanLine',
    permissions: [
      { key: PERMISSIONS.SCAN_OPERATE, label: 'Operate scan station', description: 'Scan parcels (mark packed, dispatch, handover)' },
      { key: PERMISSIONS.SCAN_VIEW_REPORTS, label: 'View scan reports', description: 'Access daily scan reports and history' },
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
      { key: PERMISSIONS.EMPLOYEES_VIEW_SALARY, label: 'View employee salary', description: 'See salary profiles and revision history for employees (every employee can view their OWN salary without this — this key is for viewing OTHERS)' },
      { key: PERMISSIONS.EMPLOYEES_MANAGE_SALARY, label: 'Manage employee salary', description: 'Set base salary, create revisions, configure commission rules' },
    ],
  },
  {
    group: 'Payroll',
    icon: 'Receipt',
    permissions: [
      { key: PERMISSIONS.PAYROLL_MANAGE, label: 'Manage payroll', description: 'Create, generate, finalize, and mark-paid payroll runs' },
      { key: PERMISSIONS.PAYROLL_VIEW_ALL, label: 'View all payslips', description: 'See every employee payslip (every employee can view their OWN without this — this key is for viewing all)' },
      { key: PERMISSIONS.PAYROLL_MANAGE_ADVANCES, label: 'Manage salary advances', description: 'Record, edit, and settle employee salary advances' },
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
