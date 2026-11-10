BEGIN;
ALTER TABLE v2_complaints ADD COLUMN manager_alerted_at timestamptz;
DROP INDEX v2_one_active_complaint_per_reference;
CREATE UNIQUE INDEX v2_one_active_complaint_per_reference ON v2_complaints(merchant_id,reference_id)
 WHERE reference_id IS NOT NULL AND status NOT IN ('RESOLUE','FERMEE','ANNULEE');
CREATE INDEX v2_complaints_waiting ON v2_complaints(waiting_since)
 WHERE waiting_since IS NOT NULL AND manager_alerted_at IS NULL;
CREATE UNIQUE INDEX v2_dispatch_scan_key ON v2_audit_events((metadata->>'requestKey')) WHERE action='DISPATCH_SCANNED';

REVOKE UPDATE ON v2_partner_events FROM transitflow_v2_runtime;
GRANT UPDATE(mapped_status) ON v2_partner_events TO transitflow_v2_runtime;

CREATE FUNCTION v2_complaint_update_signal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM pg_notify('transitflow_claims',NEW.id::text);
 RETURN NEW;
END $$;
CREATE TRIGGER v2_complaint_signal AFTER INSERT OR UPDATE ON v2_complaints
 FOR EACH ROW EXECUTE FUNCTION v2_complaint_update_signal();

CREATE TABLE v2_notification_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 notification_id uuid NOT NULL REFERENCES v2_notifications(id),
 event text NOT NULL CHECK(event IN ('ALERT','READ','CLEARED')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER v2_notification_history_immutable BEFORE UPDATE OR DELETE ON v2_notification_history
 FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();
CREATE FUNCTION v2_notification_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
   INSERT INTO v2_notification_history(notification_id,event) VALUES(NEW.id,'ALERT');
 ELSIF NEW.cleared_at IS DISTINCT FROM OLD.cleared_at THEN
   INSERT INTO v2_notification_history(notification_id,event) VALUES(NEW.id,'CLEARED');
 ELSIF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
   INSERT INTO v2_notification_history(notification_id,event) VALUES(NEW.id,'READ');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v2_notification_log AFTER INSERT OR UPDATE ON v2_notifications
 FOR EACH ROW EXECUTE FUNCTION v2_notification_log();
GRANT SELECT ON v2_notification_history TO transitflow_v2_runtime;
COMMIT;
