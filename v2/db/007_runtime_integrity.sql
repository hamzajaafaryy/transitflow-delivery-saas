-- Serialize Return Bon changes per agency, including overlapping Bons and final closure.
BEGIN;
DROP FUNCTION v2_receive_return(uuid,text,uuid,text,text,uuid,boolean);

CREATE FUNCTION v2_return_eligible(p_status text,p_authorized boolean,p_exchange boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_status='LIVRE' THEN p_exchange
   ELSE p_status IN ('REFUSE','RETOUR_AUTORISE') OR p_authorized END
$$;

CREATE OR REPLACE FUNCTION v2_guard_return_line_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.bon_id,NEW.tracking_code,NEW.order_id,NEW.anomaly_reason,NEW.required)
      IS DISTINCT FROM (OLD.bon_id,OLD.tracking_code,OLD.order_id,OLD.anomaly_reason,OLD.required) THEN
   RAISE EXCEPTION 'RETURN_MEMBERSHIP_UPDATE';
 END IF;
 IF OLD.received_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'RETURN_EVIDENCE_IMMUTABLE';
 END IF;
 IF OLD.superseded_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'RETURN_SUPERSESSION_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION v2_return_bon_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.status='RECU' OR OLD.deleted_at IS NOT NULL THEN
   RAISE EXCEPTION 'RETURN_BON_CLOSED';
 END IF;
 IF OLD.first_received_at IS NOT NULL AND NEW.first_received_at IS DISTINCT FROM OLD.first_received_at THEN
   RAISE EXCEPTION 'RETURN_BON_LOCKED';
 END IF;
 IF NEW.status='RECU' THEN
   IF OLD.status<>'ENVOYE' OR (OLD.first_received_at IS NULL AND NOT EXISTS (SELECT 1 FROM v2_return_bon_lines WHERE bon_id=OLD.id AND superseded_at IS NOT NULL)) OR NEW.received_by IS NULL OR NEW.received_at IS NULL THEN
     RAISE EXCEPTION 'RETURN_BON_NOT_SENT';
   END IF;
   IF EXISTS (
     SELECT 1 FROM v2_return_bon_lines l LEFT JOIN v2_orders o ON o.id=l.order_id
     WHERE l.bon_id=OLD.id AND l.anomaly_reason IS NULL AND l.superseded_at IS NULL AND l.received_at IS NULL
       AND (l.required OR v2_return_eligible(o.status,o.return_authorized,o.is_exchange))
   ) THEN RAISE EXCEPTION 'RETURN_PARCELS_MISSING'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v2_return_bon_state BEFORE UPDATE ON v2_return_bons
 FOR EACH ROW EXECUTE FUNCTION v2_return_bon_state_guard();

CREATE FUNCTION v2_receive_return(
 p_bon uuid,p_code text,p_actor uuid,p_method text,p_request_key text,p_manual_confirmed boolean,
 p_damaged boolean,p_damage_note text,p_photo uuid
) RETURNS TABLE(outcome text, line_id uuid, order_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b v2_return_bons%ROWTYPE;
        l v2_return_bon_lines%ROWTYPE;
        o v2_orders%ROWTYPE;
        prior v2_scan_events%ROWTYPE;
        warehouse_id uuid;
        receipt_time timestamptz := clock_timestamp();
        target_agency uuid;
        evidence_kind text;
BEGIN
 IF p_method IS NULL OR p_method NOT IN ('BARCODE','CAMERA','MANUAL') THEN RAISE EXCEPTION 'SCAN_METHOD_INVALID'; END IF;
 IF p_method='MANUAL' AND p_manual_confirmed IS DISTINCT FROM true THEN RAISE EXCEPTION 'SCAN_CONFIRM_MANUAL'; END IF;
 IF p_request_key IS NULL OR length(p_request_key) NOT BETWEEN 16 AND 150 THEN RAISE EXCEPTION 'SCAN_KEY_INVALID'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM v2_users u WHERE u.id=p_actor AND u.active AND u.presence<>'ABSENTE'
   AND (u.role IN ('ADMIN','DEVELOPER') OR (u.role IN ('EMPLOYEE','RESPONSABLE') AND EXISTS (
     SELECT 1 FROM v2_user_permissions p WHERE p.user_id=u.id AND p.permission_code IN ('returns.scan','returns.manage')
   )))
 ) THEN RAISE EXCEPTION 'SCAN_FORBIDDEN'; END IF;

 SELECT agency_id INTO target_agency FROM v2_return_bons WHERE id=p_bon;
 IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_BON_NOT_FOUND'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('return:'||target_agency::text,0));
 SELECT * INTO b FROM v2_return_bons WHERE id=p_bon FOR UPDATE;
 IF b.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'RETURN_BON_NOT_FOUND'; END IF;
 SELECT * INTO l FROM v2_return_bon_lines WHERE bon_id=p_bon AND tracking_code=p_code FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_CODE_REMOVED'; END IF;
 SELECT * INTO o FROM v2_orders WHERE id=l.order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SCAN_UNKNOWN'; END IF;

 SELECT * INTO prior FROM v2_scan_events WHERE request_key=p_request_key;
 IF FOUND THEN
   IF (prior.order_id,prior.bon_id,prior.actor_id,prior.method) IS NOT DISTINCT FROM (o.id,p_bon,p_actor,p_method)
      AND (l.damaged,l.damage_note,l.damage_photo_id) IS NOT DISTINCT FROM (p_damaged,p_damage_note,p_photo)
   THEN RETURN QUERY SELECT 'REPLAY'::text,l.id,o.id; RETURN; END IF;
   RAISE EXCEPTION 'SCAN_KEY_REUSED';
 END IF;
 IF l.received_at IS NOT NULL THEN RAISE EXCEPTION 'SCAN_DUPLICATE'; END IF;
 IF b.status='RECU' THEN RAISE EXCEPTION 'RETURN_BON_CLOSED'; END IF;
 IF l.superseded_at IS NOT NULL THEN RAISE EXCEPTION 'SCAN_DUPLICATE'; END IF;
 IF o.current_holder_type IS DISTINCT FROM 'AGENCY' OR o.current_holder_id IS DISTINCT FROM b.agency_id
   THEN RAISE EXCEPTION 'SCAN_WRONG_AGENCY'; END IF;
 IF l.anomaly_reason IS NOT NULL THEN RAISE EXCEPTION 'RETURN_CODE_INELIGIBLE'; END IF;
 IF NOT v2_return_eligible(o.status,o.return_authorized,o.is_exchange) THEN RAISE EXCEPTION 'SCAN_WRONG_STATUS'; END IF;
 SELECT id INTO STRICT warehouse_id FROM v2_warehouses WHERE is_main;
 evidence_kind := CASE p_method WHEN 'BARCODE' THEN 'USB_SERIAL' WHEN 'CAMERA' THEN 'CAMERA_DECODED' ELSE 'UNVERIFIED' END;

 UPDATE v2_return_bons SET first_received_at=receipt_time WHERE id=p_bon AND first_received_at IS NULL;
 UPDATE v2_return_bon_lines
  SET received_at=receipt_time,received_by=p_actor,input_method=p_method,
      damaged=p_damaged,damage_note=p_damage_note,damage_photo_id=p_photo WHERE id=l.id;
 UPDATE v2_orders SET current_holder_type='WAREHOUSE',current_holder_id=warehouse_id,holder_updated_at=receipt_time
  WHERE id=o.id;
 INSERT INTO v2_scan_events(order_id,bon_id,actor_id,method,from_holder_type,from_holder_id,to_holder_type,to_holder_id,request_key,evidence)
  VALUES(o.id,p_bon,p_actor,p_method,'AGENCY',b.agency_id,'WAREHOUSE',warehouse_id,p_request_key,evidence_kind);
 WITH reconciled AS (
   UPDATE v2_return_bon_lines other SET superseded_at=receipt_time,superseded_by=p_bon
   FROM v2_return_bons other_bon WHERE other.bon_id=other_bon.id AND other.order_id=o.id AND other.bon_id<>p_bon
     AND other_bon.agency_id=b.agency_id AND other.received_at IS NULL AND other.superseded_at IS NULL
     AND other.anomaly_reason IS NULL AND other_bon.deleted_at IS NULL AND other_bon.status<>'RECU'
   RETURNING other.bon_id
 )
 INSERT INTO v2_audit_events(actor_id,action,entity_type,entity_id,metadata)
  SELECT p_actor,'RETURN_EXPECTATION_RECONCILED','RETURN_BON',bon_id,jsonb_build_object('source_bon',p_bon,'order_id',o.id)
  FROM reconciled;
 INSERT INTO v2_audit_events(actor_id,action,entity_type,entity_id,metadata)
  VALUES(p_actor,'RETURN_RECEIVED','ORDER',o.id,jsonb_build_object(
    'bon_id',p_bon,'agency_id',b.agency_id,'method',p_method,'evidence',evidence_kind,'damaged',p_damaged
  ));
 RETURN QUERY SELECT 'RECEIVED'::text,l.id,o.id;
END $$;

CREATE FUNCTION v2_paid_document_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.paid_at IS NOT NULL THEN RAISE EXCEPTION 'PAID_DOCUMENT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v2_paid_agency_guard BEFORE UPDATE OR DELETE ON v2_agency_payment_bons
 FOR EACH ROW EXECUTE FUNCTION v2_paid_document_guard();
CREATE TRIGGER v2_paid_merchant_guard BEFORE UPDATE OR DELETE ON v2_merchant_invoices
 FOR EACH ROW EXECUTE FUNCTION v2_paid_document_guard();
CREATE FUNCTION v2_paid_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE settled timestamptz;
BEGIN
 IF TG_TABLE_NAME='v2_merchant_invoice_lines' THEN
   SELECT paid_at INTO settled FROM v2_merchant_invoices WHERE id=COALESCE(NEW.invoice_id,OLD.invoice_id) FOR UPDATE;
 ELSE
   SELECT paid_at INTO settled FROM v2_agency_payment_bons WHERE id=COALESCE(NEW.bon_id,OLD.bon_id) FOR UPDATE;
 END IF;
 IF settled IS NOT NULL THEN RAISE EXCEPTION 'PAID_DOCUMENT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v2_paid_agency_line_guard BEFORE INSERT OR UPDATE OR DELETE ON v2_agency_payment_lines
 FOR EACH ROW EXECUTE FUNCTION v2_paid_lines_guard();
CREATE TRIGGER v2_paid_agency_receipt_guard BEFORE INSERT ON v2_agency_payment_receipts
 FOR EACH ROW EXECUTE FUNCTION v2_paid_lines_guard();
CREATE TRIGGER v2_agency_receipt_immutable BEFORE UPDATE OR DELETE ON v2_agency_payment_receipts
 FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();
CREATE TRIGGER v2_paid_merchant_line_guard BEFORE INSERT OR UPDATE OR DELETE ON v2_merchant_invoice_lines
 FOR EACH ROW EXECUTE FUNCTION v2_paid_lines_guard();

ALTER FUNCTION v2_confirm_agency_payment(uuid,uuid) SECURITY DEFINER;
ALTER FUNCTION v2_confirm_agency_payment(uuid,uuid) SET search_path=pg_catalog,public,pg_temp;

REVOKE EXECUTE ON FUNCTION v2_receive_return(uuid,text,uuid,text,text,boolean,boolean,text,uuid) FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='transitflow_v2_runtime') THEN
   CREATE ROLE transitflow_v2_runtime NOLOGIN;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO transitflow_v2_runtime;
GRANT EXECUTE ON FUNCTION v2_receive_return(uuid,text,uuid,text,text,boolean,boolean,text,uuid),
 v2_confirm_agency_payment(uuid,uuid) TO transitflow_v2_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO transitflow_v2_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO transitflow_v2_runtime;
GRANT INSERT,UPDATE ON v2_login_limits,v2_agencies,v2_merchants,v2_merchant_rates,v2_packaging_rates,
 v2_orders,v2_pickups,v2_dispatch_bons,v2_dispatch_lines,v2_stock_products,v2_stock_lots,v2_stock_allocations,
 v2_merchant_return_bons,v2_merchant_return_lines,v2_merchant_invoices,v2_partner_connections,v2_partner_mappings,
 v2_partner_events,v2_notifications,v2_complaints,v2_holidays TO transitflow_v2_runtime;
GRANT INSERT ON v2_users TO transitflow_v2_runtime;
GRANT UPDATE(presence,active,last_totp_step) ON v2_users TO transitflow_v2_runtime;
GRANT INSERT,DELETE ON v2_sessions,v2_user_permissions TO transitflow_v2_runtime;
GRANT DELETE ON v2_login_limits,v2_dispatch_lines,v2_stock_allocations,v2_merchant_return_lines TO transitflow_v2_runtime;
GRANT INSERT ON v2_return_bons,v2_merchant_return_queue,v2_agency_payment_bons,v2_agency_payment_lines,
 v2_agency_payment_receipts,v2_merchant_invoice_lines,v2_invoice_offsets,
 v2_ticket_batches,v2_ticket_batch_lines,v2_stock_order_items,v2_stock_moves,v2_scan_events,v2_audit_events,
 v2_order_events,v2_cod_ledger,v2_private_files,v2_complaint_messages,v2_complaint_parcels TO transitflow_v2_runtime;
GRANT UPDATE(status,deleted_at,received_at,received_by) ON v2_return_bons TO transitflow_v2_runtime;
GRANT INSERT(bon_id,tracking_code,order_id,anomaly_reason,required),DELETE ON v2_return_bon_lines TO transitflow_v2_runtime;
GRANT UPDATE(expected_centimes,received_centimes) ON v2_agency_payment_bons TO transitflow_v2_runtime;
GRANT UPDATE(eligible,cod_centimes) ON v2_agency_payment_lines TO transitflow_v2_runtime;
GRANT UPDATE(amount_centimes) ON v2_merchant_invoice_lines TO transitflow_v2_runtime;
COMMIT;
