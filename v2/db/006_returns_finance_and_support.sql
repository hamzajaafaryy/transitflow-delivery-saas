BEGIN;

ALTER TABLE v2_return_bon_lines ADD COLUMN required boolean NOT NULL DEFAULT true;
ALTER TABLE v2_return_bon_lines ADD COLUMN damaged boolean NOT NULL DEFAULT false;
ALTER TABLE v2_return_bon_lines ADD COLUMN damage_note text;
ALTER TABLE v2_return_bon_lines ADD COLUMN damage_photo_id uuid;
ALTER TABLE v2_scan_events ADD COLUMN evidence text NOT NULL DEFAULT 'UNVERIFIED'
 CHECK (evidence IN ('UNVERIFIED','USB_SERIAL','CAMERA_DECODED','STAFF_BULK'));
ALTER TABLE v2_return_bons ADD COLUMN received_at timestamptz;
ALTER TABLE v2_return_bons ADD COLUMN received_by uuid REFERENCES v2_users(id);

CREATE TABLE v2_private_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
 data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 3000000),
 owner_id uuid NOT NULL REFERENCES v2_users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE v2_return_bon_lines ADD FOREIGN KEY(damage_photo_id) REFERENCES v2_private_files(id);

CREATE TABLE v2_merchant_return_queue (
 order_id uuid PRIMARY KEY REFERENCES v2_orders(id),
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 agency_line_id uuid NOT NULL UNIQUE REFERENCES v2_return_bon_lines(id),
 received_at timestamptz NOT NULL,
 is_exchange boolean NOT NULL,
 damaged boolean NOT NULL
);
CREATE INDEX v2_merchant_returns_queue_date ON v2_merchant_return_queue(merchant_id,received_at DESC);
CREATE TABLE v2_merchant_return_bons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 created_by uuid NOT NULL REFERENCES v2_users(id),
 status text NOT NULL DEFAULT 'EN_PREPARATION' CHECK(status IN
 ('EN_PREPARATION','EXPEDIE_VERS_CLIENT','RECU_PAR_CLIENT','EN_ATTENTE_CONFIRMATION','CONFIRME_PAR_MARCHAND')),
 revision integer NOT NULL DEFAULT 1,
 received_at timestamptz,
 confirmed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_merchant_return_bons_merchant ON v2_merchant_return_bons(merchant_id,created_at DESC);
CREATE TABLE v2_merchant_return_lines (
 bon_id uuid NOT NULL REFERENCES v2_merchant_return_bons(id),
 order_id uuid NOT NULL UNIQUE REFERENCES v2_merchant_return_queue(order_id),
 verified_at timestamptz,
 verified_by uuid REFERENCES v2_users(id),
 PRIMARY KEY(bon_id,order_id)
);

ALTER TABLE v2_agency_payment_bons DROP CONSTRAINT v2_agency_payment_bons_check;
ALTER TABLE v2_agency_payment_receipts ADD COLUMN request_key text UNIQUE;
ALTER TABLE v2_agency_payment_lines ADD COLUMN eligible boolean NOT NULL DEFAULT true;

CREATE TABLE v2_merchant_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 created_by uuid NOT NULL REFERENCES v2_users(id),
 total_centimes bigint NOT NULL,
 paid_at timestamptz,
 paid_by uuid REFERENCES v2_users(id),
 method text CHECK (method IN ('ESPECES','VIREMENT')),
 reference text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((paid_at IS NULL AND paid_by IS NULL AND method IS NULL)
     OR (paid_at IS NOT NULL AND paid_by IS NOT NULL AND method IS NOT NULL))
);
CREATE INDEX v2_merchant_invoices_merchant ON v2_merchant_invoices(merchant_id,created_at DESC);
CREATE TABLE v2_merchant_invoice_lines (
 invoice_id uuid NOT NULL REFERENCES v2_merchant_invoices(id),
 order_id uuid NOT NULL UNIQUE REFERENCES v2_orders(id),
 amount_centimes bigint NOT NULL,
 PRIMARY KEY(invoice_id,order_id)
);
CREATE TABLE v2_cod_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 order_id uuid REFERENCES v2_orders(id),
 invoice_id uuid REFERENCES v2_merchant_invoices(id),
 event_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK (kind IN ('COMMANDE','AJUSTEMENT','VERSEMENT')),
 amount_centimes bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_ledger_merchant ON v2_cod_ledger(merchant_id,id DESC);
CREATE INDEX v2_ledger_order ON v2_cod_ledger(order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER v2_ledger_immutable BEFORE UPDATE OR DELETE ON v2_cod_ledger
 FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();
CREATE TABLE v2_invoice_offsets (
 ledger_id bigint PRIMARY KEY REFERENCES v2_cod_ledger(id),
 invoice_id uuid NOT NULL REFERENCES v2_merchant_invoices(id)
);

CREATE TABLE v2_partner_connections (
 agency_id uuid PRIMARY KEY REFERENCES v2_agencies(id),
 secret_encrypted text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 last_seen_at timestamptz,
 last_error_at timestamptz
);
CREATE TABLE v2_partner_mappings (
 agency_id uuid NOT NULL REFERENCES v2_agencies(id),
 external_status text NOT NULL,
 internal_status text NOT NULL,
 PRIMARY KEY(agency_id,external_status)
);
CREATE TABLE v2_partner_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 agency_id uuid NOT NULL REFERENCES v2_agencies(id),
 event_key text NOT NULL,
 order_id uuid NOT NULL REFERENCES v2_orders(id),
 external_status text NOT NULL,
 occurred_at timestamptz NOT NULL,
 mapped_status text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(agency_id,event_key)
);
CREATE INDEX v2_partner_event_replay ON v2_partner_events(order_id,occurred_at DESC,id DESC);
CREATE INDEX v2_unmapped_status ON v2_partner_events(agency_id,external_status) WHERE mapped_status IS NULL;

CREATE TABLE v2_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient_id uuid NOT NULL REFERENCES v2_users(id),
 group_key text NOT NULL,
 title text NOT NULL,
 entity_id uuid,
 read_at timestamptz,
 cleared_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(recipient_id,group_key)
);
CREATE INDEX v2_notifications_recipient ON v2_notifications(recipient_id,read_at,updated_at DESC)
 WHERE cleared_at IS NULL;

CREATE TABLE v2_complaints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 topic text NOT NULL CHECK (topic IN ('ORDER','PICKUP','STOCK','INVOICE','SETTLEMENT','RETURN','OTHER')),
 reference_id uuid,
 subject text NOT NULL,
 status text NOT NULL DEFAULT 'OUVERTE'
  CHECK (status IN ('OUVERTE','EN_COURS','RESOLUE','FERMEE','ESCALADEE','ANNULEE')),
 assignee_id uuid REFERENCES v2_users(id),
 urgent boolean NOT NULL DEFAULT false,
 reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count BETWEEN 0 AND 3),
 waiting_since timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((topic='OTHER') OR (reference_id IS NOT NULL))
);
CREATE UNIQUE INDEX v2_one_active_complaint_per_reference ON v2_complaints(merchant_id,topic,reference_id)
 WHERE reference_id IS NOT NULL AND status NOT IN ('RESOLUE','FERMEE','ANNULEE');
CREATE INDEX v2_complaints_activity ON v2_complaints(updated_at DESC);
CREATE TABLE v2_complaint_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 complaint_id uuid NOT NULL REFERENCES v2_complaints(id),
 actor_id uuid NOT NULL REFERENCES v2_users(id),
 body text NOT NULL,
 private_note boolean NOT NULL DEFAULT false,
 file_id uuid REFERENCES v2_private_files(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER v2_complaint_messages_immutable BEFORE UPDATE OR DELETE ON v2_complaint_messages
 FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();
CREATE TABLE v2_complaint_parcels (
 complaint_id uuid NOT NULL REFERENCES v2_complaints(id),
 order_id uuid NOT NULL REFERENCES v2_orders(id),
 PRIMARY KEY(complaint_id,order_id)
);
CREATE TABLE v2_holidays (
 day date PRIMARY KEY,
 label text NOT NULL
);

COMMIT;
