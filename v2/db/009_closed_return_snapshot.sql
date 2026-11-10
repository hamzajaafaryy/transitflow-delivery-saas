BEGIN;

CREATE OR REPLACE FUNCTION v2_return_eligible(p_status text,p_authorized boolean,p_exchange boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE
   WHEN p_status='LIVRE' THEN p_exchange
   WHEN p_status IN ('EXPEDIE','MISE_EN_DISTRIBUTION','ATTENTE_RAMASSAGE','RAMASSE','MANQUE_STOCK') THEN false
   ELSE p_status IN ('REFUSE','RETOUR_AUTORISE') OR p_authorized
 END
$$;

CREATE TABLE v2_return_close_lines (
 line_id uuid PRIMARY KEY REFERENCES v2_return_bon_lines(id),
 order_status text,
 status_valid boolean NOT NULL,
 required boolean NOT NULL,
 is_exchange boolean NOT NULL
);
CREATE TRIGGER v2_closed_return_snapshot_immutable BEFORE UPDATE OR DELETE ON v2_return_close_lines
 FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();

CREATE FUNCTION v2_snapshot_closed_returns() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO v2_return_close_lines(line_id,order_status,status_valid,required,is_exchange)
 SELECT l.id,
   CASE WHEN l.anomaly_reason IS NULL THEN o.status END,
   l.anomaly_reason IS NULL AND COALESCE(v2_return_eligible(o.status,o.return_authorized,o.is_exchange),false),
   l.anomaly_reason IS NULL AND (l.required OR COALESCE(v2_return_eligible(o.status,o.return_authorized,o.is_exchange),false)),
   l.anomaly_reason IS NULL AND COALESCE(o.is_exchange,false)
 FROM v2_return_bon_lines l LEFT JOIN v2_orders o ON o.id=l.order_id WHERE l.bon_id=NEW.id;
 RETURN NEW;
END $$;

CREATE TRIGGER v2_close_return_snapshot AFTER UPDATE OF status ON v2_return_bons
 FOR EACH ROW WHEN (OLD.status<>'RECU' AND NEW.status='RECU') EXECUTE FUNCTION v2_snapshot_closed_returns();

INSERT INTO v2_return_close_lines(line_id,order_status,status_valid,required,is_exchange)
 SELECT l.id,
   CASE WHEN l.anomaly_reason IS NULL THEN o.status END,
   l.anomaly_reason IS NULL AND COALESCE(v2_return_eligible(o.status,o.return_authorized,o.is_exchange),false),
   l.anomaly_reason IS NULL AND (l.required OR COALESCE(v2_return_eligible(o.status,o.return_authorized,o.is_exchange),false)),
   l.anomaly_reason IS NULL AND COALESCE(o.is_exchange,false)
 FROM v2_return_bons b JOIN v2_return_bon_lines l ON l.bon_id=b.id
 LEFT JOIN v2_orders o ON o.id=l.order_id WHERE b.status='RECU';

GRANT SELECT ON v2_return_close_lines TO transitflow_v2_runtime;
COMMIT;
