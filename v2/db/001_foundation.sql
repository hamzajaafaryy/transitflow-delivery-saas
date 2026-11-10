-- TransitFlow V2 initial PostgreSQL foundation. Apply to a NEW V2 database only.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE v2_agencies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 city text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE v2_merchants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE v2_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agency_id uuid REFERENCES v2_agencies(id),
 merchant_id uuid REFERENCES v2_merchants(id),
 role text NOT NULL CHECK (role IN ('DEVELOPER','ADMIN','RESPONSABLE','EMPLOYEE','MERCHANT','PARTNER_AGENCY')),
 password_hash text NOT NULL,
 mfa_enabled boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT (agency_id IS NOT NULL AND merchant_id IS NOT NULL)),
 CHECK (role <> 'PARTNER_AGENCY' OR (agency_id IS NOT NULL AND merchant_id IS NULL)),
 CHECK (role <> 'MERCHANT' OR (merchant_id IS NOT NULL AND agency_id IS NULL))
);
CREATE UNIQUE INDEX v2_one_partner_login_per_agency ON v2_users(agency_id) WHERE role='PARTNER_AGENCY';
CREATE TABLE v2_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tracking_code text NOT NULL UNIQUE,
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 source text NOT NULL CHECK (source IN ('STOCK','EXTERNAL')),
 status text NOT NULL,
 cod_centimes bigint NOT NULL CHECK (cod_centimes >= 0),
 current_holder_type text CHECK (current_holder_type IN ('AGENCY','WAREHOUSE','DRIVER','MERCHANT')),
 current_holder_id uuid,
 status_updated_at timestamptz NOT NULL DEFAULT now(),
 holder_updated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((current_holder_type IS NULL) = (current_holder_id IS NULL))
);
CREATE INDEX v2_orders_merchant_status ON v2_orders(merchant_id,status);
CREATE INDEX v2_orders_holder ON v2_orders(current_holder_type,current_holder_id);
CREATE TABLE v2_return_bons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agency_id uuid NOT NULL REFERENCES v2_agencies(id),
 created_by uuid NOT NULL REFERENCES v2_users(id),
 creator_kind text NOT NULL CHECK (creator_kind IN ('AGENCY','STAFF')),
 status text NOT NULL DEFAULT 'BROUILLON' CHECK (status IN ('BROUILLON','ENVOYE','RECU')),
 first_received_at timestamptz,
 import_fingerprint text,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (first_received_at IS NULL OR deleted_at IS NULL)
);
CREATE UNIQUE INDEX v2_active_import_once ON v2_return_bons(agency_id,import_fingerprint) WHERE deleted_at IS NULL AND import_fingerprint IS NOT NULL;
CREATE TABLE v2_return_bon_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 bon_id uuid NOT NULL REFERENCES v2_return_bons(id),
 tracking_code text NOT NULL,
 order_id uuid REFERENCES v2_orders(id),
 anomaly_reason text,
 received_at timestamptz,
 received_by uuid REFERENCES v2_users(id),
 input_method text CHECK (input_method IN ('BARCODE','CAMERA','MANUAL')),
 UNIQUE(bon_id,tracking_code),
 CHECK (received_at IS NULL OR (received_by IS NOT NULL AND input_method IS NOT NULL))
);
CREATE INDEX v2_return_lines_order ON v2_return_bon_lines(order_id);
CREATE TABLE v2_scan_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES v2_orders(id),
 bon_id uuid REFERENCES v2_return_bons(id),
 actor_id uuid NOT NULL REFERENCES v2_users(id),
 method text NOT NULL CHECK (method IN ('BARCODE','CAMERA','MANUAL')),
 from_holder_type text,
 from_holder_id uuid,
 to_holder_type text NOT NULL,
 to_holder_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 request_key text NOT NULL UNIQUE
);
CREATE TABLE v2_audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid REFERENCES v2_users(id),
 action text NOT NULL,
 entity_type text NOT NULL,
 entity_id uuid NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_audit_entity ON v2_audit_events(entity_type,entity_id,created_at DESC);
-- Application DB role must NOT be permitted to UPDATE or DELETE audit or scan events.
-- Triggers, transaction functions and RLS policies follow in the next migration.
COMMIT;
