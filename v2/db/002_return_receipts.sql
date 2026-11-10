-- V2 migration 002: append-only receipts, locked Bon membership and idempotent possession transfer.
-- Run only after 001_foundation.sql on an isolated V2 database.
BEGIN;
ALTER TABLE v2_return_bon_lines ADD COLUMN superseded_at timestamptz;
ALTER TABLE v2_return_bon_lines ADD COLUMN superseded_by uuid REFERENCES v2_return_bons(id);
ALTER TABLE v2_return_bon_lines ADD CONSTRAINT v2_no_received_superseded CHECK (received_at IS NULL OR superseded_at IS NULL);

CREATE OR REPLACE FUNCTION v2_protect_bon_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE b v2_return_bons%ROWTYPE;
BEGIN
  SELECT * INTO b FROM v2_return_bons WHERE id = COALESCE(NEW.bon_id,OLD.bon_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bon not found'; END IF;
  IF b.first_received_at IS NOT NULL OR b.status='RECU' OR b.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Bon membership permanently locked';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
-- Membership edits are blocked after first receipt. Receipt fields are changed by trusted function below.
CREATE TRIGGER v2_bon_insert_guard BEFORE INSERT ON v2_return_bon_lines
FOR EACH ROW EXECUTE FUNCTION v2_protect_bon_membership();
CREATE TRIGGER v2_bon_delete_guard BEFORE DELETE ON v2_return_bon_lines
FOR EACH ROW EXECUTE FUNCTION v2_protect_bon_membership();

CREATE OR REPLACE FUNCTION v2_receive_return(
 p_bon uuid, p_code text, p_actor uuid, p_method text,
 p_request_key text, p_manual_confirmed boolean DEFAULT false
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE b v2_return_bons%ROWTYPE;
        l v2_return_bon_lines%ROWTYPE;
        o v2_orders%ROWTYPE;
        prior v2_scan_events%ROWTYPE;
BEGIN
  IF p_method NOT IN ('BARCODE','CAMERA','MANUAL') THEN RAISE EXCEPTION 'Invalid input method'; END IF;
  IF p_method='MANUAL' AND NOT p_manual_confirmed THEN RAISE EXCEPTION 'Manual confirmation required'; END IF;
  IF p_request_key IS NULL OR length(trim(p_request_key))=0 THEN RAISE EXCEPTION 'Idempotency key required'; END IF;
  -- All receipts for one tracking code serialize on its order row.
  SELECT * INTO o FROM v2_orders WHERE tracking_code=p_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tracking code unknown'; END IF;
  SELECT * INTO prior FROM v2_scan_events WHERE request_key=p_request_key;
  IF FOUND THEN
    IF prior.order_id=o.id AND prior.bon_id=p_bon AND prior.actor_id=p_actor AND prior.method=p_method
    THEN RETURN 'ALREADY_PROCESSED'; END IF;
    RAISE EXCEPTION 'Idempotency key reused with different request';
  END IF;
  SELECT * INTO b FROM v2_return_bons WHERE id=p_bon FOR UPDATE;
  IF NOT FOUND OR b.deleted_at IS NOT NULL OR b.status='RECU' THEN RAISE EXCEPTION 'Bon unavailable'; END IF;
  SELECT * INTO l FROM v2_return_bon_lines WHERE bon_id=p_bon AND tracking_code=p_code FOR UPDATE;
  IF NOT FOUND OR l.anomaly_reason IS NOT NULL OR l.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Code not eligible in this Bon; refresh';
  END IF;
  IF l.received_at IS NOT NULL THEN RAISE EXCEPTION 'Already received'; END IF;
  IF o.current_holder_type <> 'AGENCY' OR o.current_holder_id IS DISTINCT FROM b.agency_id THEN
    RAISE EXCEPTION 'Incorrect current agency/holder';
  END IF;
  IF o.status NOT IN ('REFUSE','ANNULE','RETOUR_AUTORISE') THEN
    RAISE EXCEPTION 'Order status must be corrected before receipt';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM v2_users WHERE id=p_actor AND active) THEN
    RAISE EXCEPTION 'Actor inactive or unknown';
  END IF;
  -- IMPORTANT: caller must be authorized server-side for Retour on this Bon.
  -- No direct DB execute grants to web or partner accounts.
  UPDATE v2_return_bons SET first_received_at=COALESCE(first_received_at,now()) WHERE id=p_bon;
  UPDATE v2_return_bon_lines SET received_at=now(),received_by=p_actor,input_method=p_method WHERE id=l.id;
  UPDATE v2_orders SET current_holder_type='WAREHOUSE',current_holder_id=b.agency_id,holder_updated_at=now()
   WHERE id=o.id;
  INSERT INTO v2_scan_events(order_id,bon_id,actor_id,method,from_holder_type,from_holder_id,to_holder_type,to_holder_id,request_key)
   VALUES(o.id,p_bon,p_actor,p_method,o.current_holder_type,o.current_holder_id,'WAREHOUSE',b.agency_id,p_request_key);
  UPDATE v2_return_bon_lines other
    SET superseded_at=now(),superseded_by=p_bon
    FROM v2_return_bons other_bon
    WHERE other.bon_id=other_bon.id AND other.order_id=o.id AND other.bon_id<>p_bon
      AND other.received_at IS NULL AND other.superseded_at IS NULL
      AND other_bon.deleted_at IS NULL AND other_bon.status<>'RECU';
  INSERT INTO v2_audit_events(actor_id,action,entity_type,entity_id,metadata)
    VALUES(p_actor,'RETURN_RECEIVED','ORDER',o.id,
      jsonb_build_object('bon_id',p_bon,'method',p_method,'manual_unverified',p_method='MANUAL'));
  RETURN 'RECEIVED';
END $$;

-- Deny direct mutation of audit history; provision a dedicated restricted application role.
-- A production migration must add RLS, precise grants and real warehouse holder IDs.
COMMIT;
