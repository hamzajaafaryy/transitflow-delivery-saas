# TransitFlow V2 foundation

V1 remains on main. This branch starts a clean V2 specification and implementation track.

## Stack
- Next.js / TypeScript UI, responsive merchant, staff and agency portals.
- NestJS with Fastify REST API and strict DTO validation.
- PostgreSQL with transactional business rules and integer-centime monetary ledger.
- Redis and BullMQ for API sync, Excel/PDF generation and notifications.
- Private file storage, encrypted backups, monitoring and structured audit.

## Core domain
A single company serves merchants via warehouses, hubs and partner agencies.
Order delivery status and current physical holder are separate fields. Importing an Excel does not transfer physical possession; a validated receipt scan does.

## Return-agency Bon
- One uploaded Excel creates one Bon automatically. Deduplicate tracking codes within the file. Preserve anomalies visibly.
- Identical active file re-import is rejected; deleting an entirely unscanned Bon permits reimport.
- Codes may appear on multiple open Bons. First successful receipt moves possession and removes outstanding expectations from other open Bons, with audit.
- Agency-created Bons can be edited only by their agency until first successful scan. Employee-created Bons are always read-only for the agency.
- Once first scan succeeds, NO actor, including Admin and Developer, can add or remove Bon codes.
- Scan checks the live database; stale/removed codes are rejected.
- All accepted codes must be scanned before final closure.
- Barcode input confirms automatically. Typed or pasted codes require explicit responsibility warning and must be marked as manually asserted, not verified physical possession.
- Stock-origin returns restock once; external returns enter merchant return queue.

## Finance
Delivered events credit merchant available COD immediately, idempotently, independently of agency remittance. Agency payment Bons are manually assembled. Partial remittance stays En cours de traitement; only Admin or Finance Responsable can mark Paid. Paid ledger records are immutable; corrections are adjustments.

## Security baseline
- Deny-by-default authorization, server-side merchant and agency scoping, negative access tests.
- MFA for Admin, Finance Responsable and Developer; revocable secure cookie sessions.
- Encrypt partner API credentials; rate limit and validate all inbound calls and uploads.
- Atomic scan transitions with row locking and idempotency keys; immutable scan and audit trails.
- Encryption in transit and at rest, encrypted backups (30 daily, 12 monthly), restore drills.
- No PII or credentials in application logs.

## Delivery sequence
1. Auth, permissions, database schema, audit and concurrency tests.
2. Merchant orders, tickets, stock FIFO, pickup, scan and dispatch.
3. Agency portal, partner sync, returns and merchant returns.
4. COD, agency payments, merchant invoicing and complaints.
5. Operational dashboards, PWA, notifications, load/security tests.

## Initial performance targets (not yet measured)
p95 scan confirmation <=300ms; p95 simple API <=200ms; representative dashboard load <=2s; test at least 100 concurrent users.

## Critical acceptance tests
- Simultaneous receipt scans of same tracking code: exactly one succeeds.
- Agency cannot read another agency even when guessing a record ID.
- First scan atomically locks Bon code membership against concurrent edits.
- Duplicate delivered webhooks never double-credit COD.
- Return to warehouse never restocks twice.
- Non-finance users cannot mark agency payments Paid.

## Branch implementation notes

The runtime now uses the existing Nest/Fastify API and a separate Next.js app in `v2/web`. Apply the ordered V2 migrations with a migration owner and connect the API using a restricted login. The API rechecks current account membership and permissions for every authenticated request. For development and review, the isolated preview runner uses local PostgreSQL and synthetic data with a private loopback API. Redis/BullMQ and managed backups remain deployment work. The [verification matrix](VERIFICATION.md) records tested scope, technical decisions, and gaps relative to the authoritative specification.
