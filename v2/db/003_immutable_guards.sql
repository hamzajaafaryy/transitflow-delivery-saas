-- Migration 003: harden Bon membership against UPDATE and audit tampering.
BEGIN;
CREATE OR REPLACE FUNCTION v2_guard_return_line_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE b v2_return_bons%ROWTYPE;
BEGIN
 IF NEW.bon_id IS DISTINCT FROM OLD.bon_id
 OR NEW.tracking_code IS DISTINCT FROM OLD.tracking_code
 OR NEW.order_id IS DISTINCT FROM OLD.order_id
 OR NEW.anomaly_reason IS DISTINCT FROM OLD.anomaly_reason THEN
   SELECT * INTO b FROM v2_return_bons WHERE id=OLD.bon_id FOR UPDATE;
   IF b.first_received_at IS NOT NULL OR b.status='RECU' OR b.deleted_at IS NOT NULL THEN
     RAISE EXCEPTION 'Bon membership permanently locked';
   END IF;
 END IF;
 IF OLD.received_at IS NOT NULL AND (
   NEW.received_at IS DISTINCT FROM OLD.received_at OR
   NEW.received_by IS DISTINCT FROM OLD.received_by OR
   NEW.input_method IS DISTINCT FROM OLD.input_method) THEN
   RAISE EXCEPTION 'Receipt evidence immutable';
 END IF;
 IF OLD.superseded_at IS NOT NULL AND (
   NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR
   NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
   RAISE EXCEPTION 'Supersession evidence immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v2_return_line_update_guard
BEFORE UPDATE ON v2_return_bon_lines
FOR EACH ROW EXECUTE FUNCTION v2_guard_return_line_update();

CREATE OR REPLACE FUNCTION v2_reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Append-only event record';
END $$;
CREATE TRIGGER v2_scan_event_immutable
BEFORE UPDATE OR DELETE ON v2_scan_events
FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();
CREATE TRIGGER v2_audit_event_immutable
BEFORE UPDATE OR DELETE ON v2_audit_events
FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();

-- The business API must validate actor permissions before invoking receipt function.
-- Restrict EXECUTE on v2_receive_return to the trusted service role only.
REVOKE ALL ON FUNCTION v2_receive_return(uuid,text,uuid,text,text,uuid,boolean) FROM PUBLIC;
COMMIT;
