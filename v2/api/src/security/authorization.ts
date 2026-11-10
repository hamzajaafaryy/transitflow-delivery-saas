/** A Principal comes only from a verified, revocable server session. */
export const roles = ['DEVELOPER','ADMIN','RESPONSABLE','EMPLOYEE','MERCHANT','PARTNER_AGENCY'] as const;
export type Role = typeof roles[number];
export const permissions = [
  'orders.read','orders.create','orders.export','orders.status_override','returns.read','returns.scan','returns.manage',
  'agency_payments.create','agency_payments.read','agency_payments.confirm_paid','users.manage',
  'stock.read','stock.manage','pickups.create','pickups.manage','pickups.collect','dispatch.manage',
  'merchant_returns.read','merchant_returns.manage','merchant_returns.confirm','merchant_finance.read',
  'claims.create','claims.read','claims.manage','claims.supervise','settings.manage',
] as const;
export type Permission = typeof permissions[number];

export interface Principal {
  id: string;
  role: Role;
  active: boolean;
  displayName?: string;
  agencyId?: string;
  merchantId?: string;
  permissions: readonly Permission[];
}
export type ResourceScope = { agencyId?: string; merchantId?: string; returnClaim?: boolean };
type Decision = { allowed: true } | { allowed: false; reason: string };

const deny = (reason: string): Decision => ({ allowed:false,reason });
const allow: Decision = { allowed:true };
export const agencyPermissions: readonly Permission[] = ['orders.read','returns.read','returns.manage'];
export const merchantPermissions: readonly Permission[] = [
  'orders.read','orders.create','orders.export','stock.read','pickups.create','merchant_returns.read','merchant_returns.confirm',
  'merchant_finance.read','claims.create','claims.read',
];
const returnPermissions: readonly Permission[] = [
  'returns.read','returns.scan','merchant_returns.read','merchant_returns.manage',
];

export function authorize(principal: Principal | null | undefined, permission: Permission, scope: ResourceScope = {}): Decision {
  if (!principal?.active || !principal.id || !roles.includes(principal.role)) return deny('UNAUTHENTICATED');
  if (permission === 'agency_payments.confirm_paid') {
    if (principal.role === 'ADMIN') return allow;
    return principal.role === 'RESPONSABLE' && principal.permissions.includes(permission)
      ? allow : deny('FINANCE_APPROVAL_RESTRICTED');
  }
  if (principal.role === 'ADMIN' || principal.role === 'DEVELOPER') return allow;
  if (principal.role === 'PARTNER_AGENCY' &&
    (!principal.agencyId || scope.agencyId !== principal.agencyId || scope.merchantId || !agencyPermissions.includes(permission))) {
    return deny('AGENCY_SCOPE');
  }
  if (principal.role === 'MERCHANT' &&
    (!principal.merchantId || scope.merchantId !== principal.merchantId || scope.agencyId || !merchantPermissions.includes(permission))) {
    return deny('MERCHANT_SCOPE');
  }
  if (principal.permissions.includes(permission)) return allow;
  if (principal.permissions.includes('returns.manage') &&
    (returnPermissions.includes(permission) || scope.returnClaim && ['claims.manage','claims.read'].includes(permission))) return allow;
  return deny('MISSING_PERMISSION');
}

export function canEditReturnBonMembership(
  principal: Principal | null | undefined,
  bon: { agencyId: string; creatorKind: 'AGENCY' | 'STAFF'; firstReceivedAt: string | Date | null; deletedAt: string | Date | null; status: string },
): Decision {
  if (!principal?.active) return deny('UNAUTHENTICATED');
  if (bon.firstReceivedAt || bon.deletedAt || bon.status === 'RECU') return deny('BON_LOCKED');
  const decision = authorize(principal,'returns.manage',{ agencyId:bon.agencyId });
  if (!decision.allowed) return decision;
  if (bon.creatorKind === 'AGENCY' && principal.role !== 'PARTNER_AGENCY') return deny('AGENCY_OWNED_BON');
  if (bon.creatorKind === 'STAFF' && principal.role === 'PARTNER_AGENCY') return deny('STAFF_OWNED_BON');
  return allow;
}
