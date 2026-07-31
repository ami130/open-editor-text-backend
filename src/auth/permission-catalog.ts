/**
 * permission-catalog.ts — the fixed set of granular ADMIN capabilities. Roles
 * are composed from these. Seeded into the `permissions` table on boot. Adding
 * a capability = add a key here (and guard the route with it).
 *
 * Naming: `<resource>.<action>`. `*.manage` is a convenience super-permission
 * some deployments prefer; here we keep explicit per-action keys for least
 * privilege, plus one wildcard the seeded admin gets.
 */
export interface PermissionDef { key: string; description: string; }

export const PERMISSION_CATALOG: PermissionDef[] = [
  // Packages
  { key: 'package.read', description: 'View packages' },
  { key: 'package.create', description: 'Create packages' },
  { key: 'package.update', description: 'Edit packages' },
  { key: 'package.delete', description: 'Delete packages' },
  // Customers
  { key: 'customer.read', description: 'View customers' },
  { key: 'customer.create', description: 'Create customers' },
  { key: 'customer.update', description: 'Edit customers' },
  { key: 'customer.delete', description: 'Delete customers' },
  // Licenses
  { key: 'license.read', description: 'View licenses' },
  { key: 'license.issue', description: 'Issue licenses' },
  { key: 'license.renew', description: 'Renew licenses' },
  { key: 'license.revoke', description: 'Revoke licenses' },
  // Features catalog (read-only surface)
  { key: 'feature.read', description: 'View the feature catalog' },
  // Orders (billing purchases — read-only admin surface)
  { key: 'order.read', description: 'View purchase orders' },
  // Admin user/role management
  { key: 'user.read', description: 'View admin users' },
  { key: 'user.manage', description: 'Create/edit/deactivate admin users' },
  { key: 'role.read', description: 'View roles' },
  { key: 'role.manage', description: 'Create/edit roles and assign permissions' },
];

/** The wildcard permission — grants everything. Held by the seeded admin role. */
export const SUPER_PERMISSION = '*';

export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);
