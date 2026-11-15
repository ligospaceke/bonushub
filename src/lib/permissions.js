// Staff roles and what each may do. Enforced on the server for every admin request.
const ALL = ['overview', 'orders', 'payments', 'refunds', 'settlements', 'sellers.read', 'sellers.manage', 'products', 'categories', 'commission.read', 'commission.write', 'reports', 'staff', 'audit', 'disputes', 'jobs'];

export const STAFF_PERMISSIONS = {
  owner: ALL,
  finance: ['overview', 'orders', 'payments', 'refunds', 'settlements', 'sellers.read', 'commission.read', 'reports'],
  catalogue: ['overview', 'products', 'categories', 'sellers.read'],
  support: ['overview', 'orders', 'sellers.read', 'disputes', 'refunds'],
};

export const can = (user, perm) => user?.role === 'admin' && !!STAFF_PERMISSIONS[user.staff_role]?.includes(perm);

import { forbidden } from './http.js';
export const need = (user, perm) => { if (!can(user, perm)) throw forbidden('Your staff role cannot do this.'); };
export const requireRole = (user, ...roles) => { if (!user || !roles.includes(user.role)) throw forbidden('This area is not available for your account.'); };
