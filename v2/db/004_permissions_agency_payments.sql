-- Migration 004: explicit permissions and agency payment Bon foundation.
BEGIN;
CREATE TABLE v2_permissions (
 code text PRIMARY KEY,
 description text NOT NULL
);
INSERT INTO v2_permissions(code,description) VALUES
 ('orders.read','View orders in permitted scope'),
 ('orders.status_override','Correct order status with reason'),
 ('returns.read','Read return Bons in permitted scope'),
 ('returns.scan','Receive returned parcels'),
 ('returns.manage','Create and manage return Bons within business rules'),
 ('agency_payments.create','Prepare agency payment Bons'),
 ('agency_payments.read','Read agency payments'),
 ('agency_payments.confirm_paid','Confirm fully settled agency payment'),
 ('users.manage','Manage authorized staff accounts');
CREATE TABLE v2_user_permissions (
 user_id uuid NOT NULL REFERENCES v2_users(id),
 permission_code text NOT NULL REFERENCES v2_permissions(code),
 granted_by uuid NOT NULL REFERENCES v2_users(id),
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,permission_code)
);
CREATE TABLE v2_agency_payment_bons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agency_id uuid NOT NULL REFERENCES v2_agencies(id),
 created_by uuid NOT NULL REFERENCES v2_users(id),
 status text NOT NULL DEFAULT 'EN_COURS_TRAITEMENT'
  CHECK(status IN ('EN_COURS_TRAITEMENT','PAYE')),
 expected_centimes bigint NOT NULL DEFAULT 0 CHECK(expected_centimes>=0),
 received_centimes bigint NOT NULL DEFAULT 0 CHECK(received_centimes>=0),
 paid_at timestamptz,
 paid_by uuid REFERENCES v2_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(received_centimes<=expected_centimes),
 CHECK((status='PAYE' AND paid_at IS NOT NULL AND paid_by IS NOT NULL AND received_centimes=expected_centimes)
    OR (status='EN_COURS_TRAITEMENT' AND paid_at IS NULL AND paid_by IS NULL))
);
CREATE TABLE v2_agency_payment_lines (
 bon_id uuid NOT NULL REFERENCES v2_agency_payment_bons(id),
 order_id uuid NOT NULL UNIQUE REFERENCES v2_orders(id),
 cod_centimes bigint NOT NULL CHECK(cod_centimes>=0),
 PRIMARY KEY(bon_id,order_id)
);
CREATE TABLE v2_agency_payment_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 bon_id uuid NOT NULL REFERENCES v2_agency_payment_bons(id),
 amount_centimes bigint NOT NULL CHECK(amount_centimes>0),
 reference text,
 entered_by uuid NOT NULL REFERENCES v2_users(id),
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_agency_payments_agency ON v2_agency_payment_bons(agency_id,created_at DESC);

CREATE OR REPLACE FUNCTION v2_confirm_agency_payment(p_bon uuid,p_actor uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE b v2_agency_payment_bons%ROWTYPE;
BEGIN
 SELECT * INTO b FROM v2_agency_payment_bons WHERE id=p_bon FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment Bon not found'; END IF;
 IF b.status='PAYE' THEN RAISE EXCEPTION 'Already paid'; END IF;
 IF b.expected_centimes<>b.received_centimes THEN
   RAISE EXCEPTION 'Payment Bon not fully settled';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM v2_users u WHERE u.id=p_actor AND u.active
     AND (u.role='ADMIN' OR (u.role='RESPONSABLE' AND EXISTS (
       SELECT 1 FROM v2_user_permissions up WHERE up.user_id=u.id
         AND up.permission_code='agency_payments.confirm_paid')))
 ) THEN RAISE EXCEPTION 'Finance approval permission denied'; END IF;
 UPDATE v2_agency_payment_bons SET status='PAYE',paid_by=p_actor,paid_at=now() WHERE id=p_bon;
 INSERT INTO v2_audit_events(actor_id,action,entity_type,entity_id,metadata)
 VALUES(p_actor,'AGENCY_PAYMENT_CONFIRMED','AGENCY_PAYMENT_BON',p_bon,
        jsonb_build_object('amount_centimes',b.received_centimes));
END $$;
REVOKE ALL ON FUNCTION v2_confirm_agency_payment(uuid,uuid) FROM PUBLIC;
-- Grant EXECUTE only to a trusted service role; never trust actor IDs supplied by clients.
COMMIT;
