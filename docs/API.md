# API — TransitFlow MVP (v0.1)

All endpoints are under `/api`. The UI requests authenticate with an HttpOnly `dn_session` cookie plus header `X-Requested-With: delivery-ui` for any mutation. Partner status sync uses `Authorization: Bearer <partner_api_key>` and does **not** use a session. Request and response bodies use JSON except file upload and XLSX download.

## Integration with an external delivery company

An admin first adds a partner using `POST /api/partners`, and securely shares the generated `apiKey` with an integration operator. The key is shown only at creation (or rotation). It is hashed in the DB and is restricted to shipments assigned to that partner within one tenant.

**Incoming webhook / push** (generic protocol, to be adapted to partner API):

```http
POST /api/integrations/status HTTP/1.1
Authorization: Bearer dn_***
Content-Type: application/json

{
  "eventId": "oscario-event-74913",
  "tracking": "DNTEST20260001",
  "externalTracking": "OSC-58392",
  "status": "RAMASSE"
}
```

Response:

```json
{"ok":true,"tracking":"DNTEST20260001","status":"PICKED_UP"}
```

If `eventId` is repeated, the server returns `{"ok":true,"duplicate":true,...}` and does not create a duplicate event. State changes are tenant-scoped and validated. Stale/reversed terminal events return HTTP 409. Invalid credentials return 401. Unmapped status: 422. Other common statuses: `EN_COURS` → `IN_TRANSIT`, `EN_LIVRAISON` → `OUT_FOR_DELIVERY`, `LIVRE` → `DELIVERED`, `REFUSE` → `REFUSED`, `RETOUR` → `RETURNING`.

Many partner systems **do not support an outgoing webhook**, and may require *our server* to poll their API. That connector is not implemented yet. Do not assume this endpoint alone automatically connects to Oscario: their real API docs, auth, rate limits and permission must be verified.

Admin may set custom partner status aliases:

```http
POST /api/partners/<partner-id>/status-map
X-Requested-With: delivery-ui
Content-Type: application/json
Cookie: dn_session=...

{"map":{"RECU_DEPOT":"PICKED_UP","EN_COURS_RETOUR":"RETURNING"}}
```

Admin may rotate a compromised API key with `POST /api/partners/<partner-id>/rotate-key` (the previous key is immediately invalid).

## Orders and companies

| Method | Endpoint | Action |
|---|---|---|
| POST | `/auth/register` | Create a company and its first admin. |
| POST | `/auth/login` | Log in using `{company,email,password}`. |
| POST | `/auth/logout` | Log out. |
| GET | `/me` | Current user/company. |
| GET | `/stats` | Status statistics, scoped to role. |
| GET | `/shipments` | Tenant shipments, role-scoped. |
| POST | `/shipments` | Create shipment; fields `recipient, phone, city, address, cod, partnerId?`, etc. |
| POST | `/shipments/assign` | Assign manually `{shipmentId,partnerId}` or `{shipmentId,driverId}`. |
| POST | `/shipments/<id>/status` | Internal updates with `{status,note?}`. Driver only for own shipments. |
| GET | `/tracking/<tracking>` | Sanitized public tracking view. |
| GET/POST | `/partners` | List/create external partners. |
| POST | `/partners/<id>/export` | XLSX manifest generation and state `EXPORTED`. |
| GET | `/manifests` | Export history. |
| POST | `/import/orders` | Binary CSV/XLSX (with corresponding Content-Type). |
| GET/POST | `/users` | Employee list, create role-scoped user (admin only for creation). |
| GET/POST | `/merchants` | Merchant list/create. |
| GET | `/ledger` | COD journal. |
| POST | `/ledger/collect` | Confirm COD for delivered shipment once. |
| GET | `/billing/usage` | Tenant monthly SaaS usage counts, billing inactive. |
| GET | `/inventory` | Products with available/reserved/physical stock. |
| POST | `/inventory/products` | Create product `{sku,name}`. |
| POST | `/inventory/receive` | Receive stock `{productId,quantity,location?}`. |
| POST | `/inventory/reserve` | Reserve stock FIFO `{shipmentId,productId,quantity}`. |
| POST | `/inventory/dispatch` | Dispatch reservations for a shipment. |

## Excel export

The standard XLSX columns are:

```
Tracking | Destinataire | Téléphone | Adresse | Ville | COD | Description
```

The partner's own system may need a **different column order or label names**. Per-partner template designer and custom converters are on the roadmap; no guarantee that this default workbook can be imported in Oscario without adjustment. An XLSX export changes orders to `EXPORTED`, **not** `PICKED_UP`.

## Trust boundaries

- `tenant_id` must always be drawn from the authenticated session, not from user-submitted JSON.
- Partner Bearer key identifies a single external carrier **within a single company**; only this carrier's assigned shipments can be updated.
- Trackings may be duplicated across independent tenants; public tracking refuses to return ambiguous results.
- The finance journal logs manual COD confirmation but does not yet implement double-entry accounting or inter-company settlements.
