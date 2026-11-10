-- Runtime accounts and the single-company operations data model.
BEGIN;

ALTER TABLE v2_users ADD COLUMN login text UNIQUE;
ALTER TABLE v2_users ADD COLUMN display_name text NOT NULL DEFAULT '';
ALTER TABLE v2_users ADD COLUMN mfa_secret_encrypted text;
ALTER TABLE v2_users ADD COLUMN last_totp_step bigint;
ALTER TABLE v2_users ADD COLUMN presence text NOT NULL DEFAULT 'PRESENTE'
 CHECK (presence IN ('PRESENTE','TT','ABSENTE'));
ALTER TABLE v2_users ADD COLUMN zone text;
ALTER TABLE v2_users ADD CONSTRAINT v2_login_scope CHECK (
 (role IN ('PARTNER_AGENCY','MERCHANT')) OR (agency_id IS NULL AND merchant_id IS NULL)
);
CREATE UNIQUE INDEX v2_single_developer ON v2_users(role) WHERE role='DEVELOPER';

CREATE TABLE v2_sessions (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES v2_users(id),
 expires_at timestamptz NOT NULL,
 mfa_verified boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_sessions_user ON v2_sessions(user_id);
CREATE INDEX v2_sessions_expiry ON v2_sessions(expires_at);
CREATE TABLE v2_login_limits (
 key_hash text PRIMARY KEY,
 attempts integer NOT NULL,
 reset_at timestamptz NOT NULL
);
ALTER TABLE v2_audit_events ADD COLUMN agency_actor_id uuid REFERENCES v2_agencies(id);

INSERT INTO v2_permissions(code,description) VALUES
 ('orders.create','Créer des commandes'), ('orders.export','Exporter les commandes'),
 ('stock.read','Consulter le stock'), ('stock.manage','Réceptionner et ajuster le stock'),
 ('pickups.create','Demander un ramassage'), ('pickups.manage','Affecter et clore les ramassages'),
 ('pickups.collect','Collecter les ramassages affectés'),
 ('dispatch.manage','Préparer les envois et traiter les réceptions par ville'),
 ('merchant_returns.read','Consulter les retours au marchand'),
 ('merchant_returns.manage','Préparer et remettre les retours aux marchands'),
 ('merchant_returns.confirm','Confirmer la réception d’un retour marchand'),
 ('merchant_finance.read','Consulter les relevés marchands'),
 ('claims.create','Créer une réclamation'), ('claims.manage','Traiter les réclamations'),
 ('claims.read','Consulter les réclamations'), ('claims.supervise','Superviser les réclamations'),
 ('settings.manage','Gérer les référentiels opérationnels');

CREATE TABLE v2_warehouses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 is_main boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX v2_one_main_warehouse ON v2_warehouses(is_main) WHERE is_main;
INSERT INTO v2_warehouses(name,is_main) VALUES ('Entrepôt principal',true);

ALTER TABLE v2_agencies ADD COLUMN return_excel_header text NOT NULL DEFAULT 'CODE SUIVI';
ALTER TABLE v2_agencies ADD COLUMN dispatch_excel_headers text[] NOT NULL DEFAULT
 ARRAY['CODE SUIVI','DESTINATAIRE','TELEPHONE','ADRESSE','PRIX','VILLE','COMMENTAIRE','MARCHANDISE','QTY','PEUT OUVRIR','COLIS REMPLACER'];
ALTER TABLE v2_merchants ADD COLUMN phone text;
ALTER TABLE v2_merchants ADD COLUMN refused_fee_centimes bigint NOT NULL DEFAULT 0 CHECK (refused_fee_centimes >= 0);
CREATE TABLE v2_merchant_rates (
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 city text NOT NULL,
 delivery_fee_centimes bigint NOT NULL CHECK (delivery_fee_centimes >= 0),
 PRIMARY KEY(merchant_id,city)
);
CREATE TABLE v2_packaging_rates (
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 kind text NOT NULL CHECK (kind IN ('SACHET_PETIT','SACHET_GRAND','CARTON_PETIT','CARTON_GRAND')),
 centimes bigint NOT NULL CHECK (centimes >= 0),
 PRIMARY KEY(merchant_id,kind)
);

ALTER TABLE v2_orders ADD COLUMN agency_id uuid REFERENCES v2_agencies(id);
ALTER TABLE v2_orders ADD COLUMN recipient text NOT NULL DEFAULT '';
ALTER TABLE v2_orders ADD COLUMN phone text NOT NULL DEFAULT '';
ALTER TABLE v2_orders ADD COLUMN address text NOT NULL DEFAULT '';
ALTER TABLE v2_orders ADD COLUMN city text NOT NULL DEFAULT '';
ALTER TABLE v2_orders ADD COLUMN comment text NOT NULL DEFAULT '';
ALTER TABLE v2_orders ADD COLUMN merchandise text NOT NULL DEFAULT '';
ALTER TABLE v2_orders ADD COLUMN quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0);
ALTER TABLE v2_orders ADD COLUMN can_open boolean NOT NULL DEFAULT false;
ALTER TABLE v2_orders ADD COLUMN is_exchange boolean NOT NULL DEFAULT false;
ALTER TABLE v2_orders ADD COLUMN return_authorized boolean NOT NULL DEFAULT false;
ALTER TABLE v2_orders ADD COLUMN delivered_at timestamptz;
ALTER TABLE v2_orders ADD COLUMN company_packed boolean NOT NULL DEFAULT false;
ALTER TABLE v2_orders ADD COLUMN packaging_kind text CHECK (packaging_kind IN ('SACHET_PETIT','SACHET_GRAND','CARTON_PETIT','CARTON_GRAND'));
ALTER TABLE v2_orders ADD COLUMN packaging_centimes bigint NOT NULL DEFAULT 0 CHECK (packaging_centimes>=0);
ALTER TABLE v2_orders ADD COLUMN delivery_fee_centimes bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_centimes>=0);
ALTER TABLE v2_orders ADD COLUMN refused_fee_centimes bigint NOT NULL DEFAULT 0 CHECK (refused_fee_centimes>=0);
ALTER TABLE v2_orders ADD CONSTRAINT v2_packaging_company_only CHECK (
 company_packed OR (packaging_kind IS NULL AND packaging_centimes=0)
);
CREATE INDEX v2_order_status_updated ON v2_orders(status_updated_at DESC,id DESC);
CREATE INDEX v2_order_dispatch_candidates ON v2_orders(city,status,tracking_code);
CREATE INDEX v2_order_agency_delivered ON v2_orders(agency_id,delivered_at DESC) WHERE status='LIVRE';

CREATE TABLE v2_order_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES v2_orders(id),
 status text NOT NULL,
 source text NOT NULL CHECK (source IN ('OPERATIONS','CORRECTION','PARTNER')),
 reason text,
 occurred_at timestamptz NOT NULL,
 actor_id uuid REFERENCES v2_users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_order_events_history ON v2_order_events(order_id,occurred_at DESC,id DESC);
CREATE TRIGGER v2_order_event_immutable BEFORE UPDATE OR DELETE ON v2_order_events
 FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();

CREATE TABLE v2_ticket_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES v2_users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE v2_ticket_batch_lines (
 batch_id uuid NOT NULL REFERENCES v2_ticket_batches(id),
 order_id uuid NOT NULL REFERENCES v2_orders(id),
 position integer NOT NULL,
 PRIMARY KEY(batch_id,order_id),
 UNIQUE(batch_id,position)
);

CREATE TABLE v2_pickups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 zone text NOT NULL,
 address text NOT NULL,
 status text NOT NULL DEFAULT 'EN_ATTENTE'
  CHECK (status IN ('EN_ATTENTE','AFFECTE','PICKED','REPORTE','TERMINE','ANNULE')),
 assignee_id uuid REFERENCES v2_users(id),
 scheduled_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_pickups_merchant ON v2_pickups(merchant_id,created_at DESC);
CREATE INDEX v2_pickups_assignee ON v2_pickups(assignee_id,status);

CREATE TABLE v2_dispatch_bons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agency_id uuid NOT NULL REFERENCES v2_agencies(id),
 city text NOT NULL,
 created_by uuid NOT NULL REFERENCES v2_users(id),
 status text NOT NULL DEFAULT 'EN_PREPARATION' CHECK (status IN ('EN_PREPARATION','ENVOYE','RECU')),
 first_received_at timestamptz,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (first_received_at IS NULL OR deleted_at IS NULL)
);
CREATE TABLE v2_dispatch_lines (
 bon_id uuid NOT NULL REFERENCES v2_dispatch_bons(id),
 order_id uuid NOT NULL UNIQUE REFERENCES v2_orders(id),
 received_at timestamptz,
 PRIMARY KEY(bon_id,order_id)
);
CREATE INDEX v2_dispatch_bons_agency ON v2_dispatch_bons(agency_id,created_at DESC);

CREATE TABLE v2_stock_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 merchant_id uuid NOT NULL REFERENCES v2_merchants(id),
 sku text NOT NULL,
 name text NOT NULL,
 UNIQUE(merchant_id,sku)
);
CREATE TABLE v2_stock_lots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id uuid NOT NULL REFERENCES v2_stock_products(id),
 physical integer NOT NULL CHECK (physical>=0),
 reserved integer NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND physical),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX v2_stock_lots_fifo ON v2_stock_lots(product_id,created_at,id);
CREATE TABLE v2_stock_order_items (
 order_id uuid NOT NULL REFERENCES v2_orders(id),
 product_id uuid NOT NULL REFERENCES v2_stock_products(id),
 quantity integer NOT NULL CHECK (quantity>0),
 PRIMARY KEY(order_id,product_id)
);
CREATE TABLE v2_stock_allocations (
 order_id uuid NOT NULL REFERENCES v2_orders(id),
 lot_id uuid NOT NULL REFERENCES v2_stock_lots(id),
 quantity integer NOT NULL CHECK (quantity>0),
 deducted_at timestamptz,
 PRIMARY KEY(order_id,lot_id)
);
CREATE TABLE v2_stock_moves (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 product_id uuid NOT NULL REFERENCES v2_stock_products(id),
 order_id uuid REFERENCES v2_orders(id),
 lot_id uuid REFERENCES v2_stock_lots(id),
 delta integer NOT NULL CHECK (delta<>0),
 kind text NOT NULL CHECK (kind IN ('RECEPTION','RAMASSAGE','AJUSTEMENT','RETOUR','QUARANTAINE')),
 actor_id uuid NOT NULL REFERENCES v2_users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX v2_stock_return_once ON v2_stock_moves(order_id,product_id)
 WHERE kind IN ('RETOUR','QUARANTAINE');
CREATE TRIGGER v2_stock_moves_immutable BEFORE UPDATE OR DELETE ON v2_stock_moves
 FOR EACH ROW EXECUTE FUNCTION v2_reject_event_mutation();

COMMIT;
