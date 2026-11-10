import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, canEditReturnBonMembership } from '../dist/security/authorization.js';

const agency = { id: 'agency-user', role: 'PARTNER_AGENCY', active: true, agencyId: 'a1', permissions: ['orders.read','returns.read','returns.manage'] };
const merchant = { id: 'merchant-user', role: 'MERCHANT', active: true, merchantId: 'm1', permissions: ['orders.read','returns.read'] };
const staff = { id: 'staff', role: 'EMPLOYEE', active: true, permissions: ['returns.manage','returns.scan','agency_payments.confirm_paid'] };

test('deny missing principal and permissions', () => {
 assert.equal(authorize(null, 'orders.read').allowed, false);
 assert.equal(authorize({ ...staff, active: false }, 'returns.scan').allowed, false);
 assert.equal(authorize({ ...staff, permissions: [] }, 'returns.scan').allowed, false);
});
test('agency and merchant isolation', () => {
 assert.equal(authorize(agency, 'orders.read', { agencyId: 'a1' }).allowed, true);
 assert.equal(authorize(agency, 'orders.read', { agencyId: 'a2' }).allowed, false);
 assert.equal(authorize(agency, 'returns.scan', { agencyId: 'a1' }).allowed, false);
 assert.equal(authorize(merchant, 'orders.read', { merchantId: 'm1' }).allowed, true);
 assert.equal(authorize(merchant, 'orders.read', { merchantId: 'm2' }).allowed, false);
});
test('ordinary employee cannot confirm agency payment', () => {
 assert.equal(authorize(staff, 'agency_payments.confirm_paid').allowed, false);
 assert.equal(authorize({ ...staff, role: 'RESPONSABLE' }, 'agency_payments.confirm_paid').allowed, true);
});
test('Bon ownership and first-scan lock', () => {
 const b = { agencyId: 'a1', creatorKind: 'AGENCY', firstReceivedAt: null, deletedAt: null, status: 'BROUILLON' };
 assert.equal(canEditReturnBonMembership(agency, b).allowed, true);
 assert.equal(canEditReturnBonMembership(staff, b).allowed, false);
 assert.equal(canEditReturnBonMembership(staff, { ...b, creatorKind: 'STAFF' }).allowed, true);
 assert.equal(canEditReturnBonMembership(agency, { ...b, creatorKind: 'STAFF' }).allowed, false);
 assert.equal(canEditReturnBonMembership({ id: 'admin', role: 'ADMIN', active: true, permissions: [] }, { ...b, firstReceivedAt: '2026-11-10' }).allowed, false);
});
