/**
 * Server-side access decisions. Authentication must supply a verified Principal;
 * never construct it from client-provided IDs or roles.
 */
export type Role = 'DEVELOPER' | 'ADMIN' | 'RESPONSABLE' | 'EMPLOYEE' | 'MERCHANT' | 'PARTNER_AGENCY';
export type Permission =
  | 'orders.read' | 'orders.status_override'
  | 'returns.read' | 'returns.scan' | 'returns.manage'
  | 'agency_payments.create' | 'agency_payments.read'
  | 'agency_payments.confirm_paid' | 'users.manage';

export interface Principal {
  id: string;
  role: Role;
  active: boolean;
  agencyId?: string;
  merchantId?: string;
  permissions: readonly Permission[];
}
export type ResourceScope = { agencyId?: string; merchantId?: string };
export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

const denied = (reason: string): AccessDecision => ({ allowed: false, reason });
const allowed: AccessDecision = { allowed: true };

/** Deny by default. Admin and developer are privileged only after verified authentication. */
export function authorize(
  principal: Principal | null | undefined,
  permission: Permission,
  scope: ResourceScope = {},
): AccessDecision {
  if (!principal?.active || !principal.id) return denied('UNAUTHENTICATED');
  if (principal.role === 'DEVELOPER' || principal.role === 'ADMIN') return allowed;
  if (!principal.permissions.includes(permission)) return denied('MISSING_PERMISSION');

  if (principal.role === 'PARTNER_AGENCY') {
    if (!principal.agencyId || scope.agencyId !== principal.agencyId) return denied('AGENCY_SCOPE');
    if (scope.merchantId) return denied('AGENCY_CANNOT_ACCESS_MERCHANT');
    if (!['orders.read', 'returns.read', 'returns.manage'].includes(permission)) {
      return denied('AGENCY_PERMISSION_RESTRICTED');
    }
    return allowed;
  }
  if (principal.role === 'MERCHANT') {
    if (!principal.merchantId || scope.merchantId !== principal.merchantId) return denied('MERCHANT_SCOPE');
    if (scope.agencyId) return denied('MERCHANT_CANNOT_ACCESS_AGENCY');
    if (!['orders.read', 'returns.read'].includes(permission)) return denied('MERCHANT_PERMISSION_RESTRICTED');
    return allowed;
  }
  if (permission === 'agency_payments.confirm_paid' && principal.role !== 'RESPONSABLE') {
    return denied('FINANCE_APPROVAL_RESTRICTED');
  }
  return allowed;
}

/** Return Bon creator rule: after first receipt no human can modify membership. */
export function canEditReturnBonMembership(
  principal: Principal | null | undefined,
  bon: { agencyId: string; creatorKind: 'AGENCY' | 'STAFF'; firstReceivedAt: string | null; deletedAt: string | null; status: string },
): AccessDecision {
  if (!principal?.active) return denied('UNAUTHENTICATED');
  if (bon.firstReceivedAt || bon.deletedAt || bon.status === 'RECU') return denied('BON_LOCKED');
  const decision = authorize(principal, 'returns.manage',
    principal.role === 'PARTNER_AGENCY' ? { agencyId: bon.agencyId } : {});
  if (!decision.allowed) return decision;
  if (bon.creatorKind === 'AGENCY' && principal.role !== 'PARTNER_AGENCY') return denied('AGENCY_OWNED_BON');
  if (bon.creatorKind === 'STAFF' && principal.role === 'PARTNER_AGENCY') return denied('STAFF_OWNED_BON');
  return allowed;
}
