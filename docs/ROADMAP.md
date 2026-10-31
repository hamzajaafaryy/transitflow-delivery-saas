# Plan de livraison — de MVP local à SaaS vendable

## État actuel — implémenté et testé

- French responsive web UI; same URL for drivers and admins
- Company registration, scoped accounts, user roles
- Orders, partner assignment manual, multi-carrier same city
- Generic external partner API for status changes + replay prevention
- CSV/XLSX import and XLSX export + manifest
- Public tracking and merchant-filtered view
- Basic inventory fulfillment FIFO
- Initial COD collection journal and SaaS usage counters

## P0 — avant toutes données réelles / mise en production

1. **PostgreSQL + migrations**: replace experimental SQLite, introduce row-level tenant security, foreign key tenant constraints (composite tenant-aware FKs), and load tests.
2. **Professional auth**: MFA for admins, reset password, invite/accept workflow, session revoke, device management, proper rate limiting on every API, access control audits.
3. **Logistics workflow**: signed physical handover manifest, parcel-level barcode scanning in our warehouse, scan discrepancy reconciliation, complete return/re-attempt workflows, conflict resolution and independent customer claims.
4. **Real partner connectors**: official API contracts for each partner (e.g. Oscario), inbound push vs outbound polling, token rotation, secure outbound secrets store, asynchronous retry / dead-letter queue, delivery status normalization and backfill, dedicated integration tests.
5. **Excel partner templates**: editable per-carrier Excel column mapping, required fields, validated import preview, error download and versioned templates.
6. **COD-grade finance**: double-entry immutable ledger, driver/branch/courier custody, bank payouts, intercompany netting, partner commission contracts, reverse entries, accounting audit and reconciliation.
7. **Security & operations**: independent penetration test, backups and restore drills, alerting, access logs, secrets vault, security headers, safe file handling, privacy retention & deletion workflow.

## P1 — complete Morocco SaaS operations

- Warehouse locations, bin tracking, product per merchant, returns to stock, picking lists, lot/batch controls and fulfillment billing.
- Route planning, pickup lists, inter-agency transfers, parcel barcodes/labels, proof of delivery, vehicle assignments.
- Merchant API + Shopify/WooCommerce integration with webhooks/idempotency.
- Arabic/English internationalization possible later; French first.
- Notifications via licensed SMS/WhatsApp API service; no unapproved WhatsApp automation.
- Support ticketing and merchant financial statements.
- Platform owner (separate) console for tenant lifecycle, subscriptions and administrative consent controls.

## P2 — hybrid SaaS billing

- Paid plans: monthly base fee + per-order charges after included quota, configured prices (not hardcoded assumptions), recurring invoices and taxes per jurisdiction, usage adjustments, refunds and cancellation policies.
- Billing provider integration, subscription webhook verification, graceful suspension, customer support, billing history, invoice export.
- External partner rate cards and shared transportation network financial netting.

## Explicit limits of this version

The system is a **functional foundation** to test and iterate, not a completely built SaaS product. The production authorization/finance threat model is still incomplete; there is no production Vercel deployment, no live connection with Oscario, no complete route/agency workflows or reliable production-grade intercompany settlements. All choices and tests should be reviewed before exposing the site to the Internet.
