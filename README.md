# TransitFlow — Delivery Network SaaS (MVP)

**Statut : prototype fonctionnel pour test local, PAS un service SaaS prêt à commercialiser.**

Une base de projet en français, multi-sociétés (tenants) pour la livraison au Maroc. Les sociétés de transport externes (ex. Oscario à Tanger) **gardent leurs propres logiciels** : nous exportons des bordereaux Excel XLSX pour import chez elles et elles communiquent les changements de statut par API. Le livreur interne utilise **le même site web** avec son compte et une interface mobile dédiée, sans application séparée.

## Fonctionnalités réellement implémentées

- Inscription d'une société indépendante, connexion à l'aide de **code société + email + mot de passe**, session HttpOnly SameSite, rôles `ADMIN`, `OPERATIONS`, `DRIVER`, `MERCHANT`, `FINANCE`.
- Cloisonnement des lectures et écritures par `tenant_id` dans les requêtes du backend ; contrôles de permissions.
- Colis : création, suivi interne, attribution **manuelle** aux partenaires (plusieurs transporteurs par ville) ou aux livreurs internes, historique des statuts.
- Sociétés partenaires : villes couvertes, tarifs indicatifs, contacts, accès API distinct par partenaire, rotation de la clé et mapping de statuts via API.
- Import **CSV et XLSX**, avec validation, prévention des doublons, rapport des erreurs. Export Excel XLSX avec manifest enregistré, pour envoi **manuel** via WhatsApp à un partenaire.
- Scan externe : endpoint API authentifié ; les événements `RAMASSE`, `EN_COURS`, `EN_LIVRAISON`, `LIVRE`, etc. actualisent automatiquement le colis **si le système externe les envoie**. Idempotence via `eventId` ; rejet des transitions régressives.
- Espace livreur mobile dans le même site (liste des colis qui lui sont attribués, téléphone, mise à jour de statuts).
- Espace marchand basé sur le `merchant_id` explicite. Consultations limitées aux colis de ce marchand.
- Suivi public par numéro de tracking à forte entropie (sans téléphone, adresse complète ou COD) ; masquer le suivi si même tracking présent chez plusieurs tenants.
- Stock / fulfillment : création SKU, réception de lots, quantités disponibles/réservées, réservation FIFO transactionnelle et sortie du stock après préparation.
- Finance initiale : collecte COD confirmée manuellement sur une commande `DELIVERED`, entrée de journal non duplicable. **Pas encore de règlement ou rapprochement complet**.
- Metering SaaS : volume mensuel de commandes / événements partenaire / exports. **Les abonnements payants ne sont pas encore activés.**
- Tests automatiques API, permissions, isolation multi-tenant, XLSX et FIFO (sans accès Internet ni packages externes).

## Prérequis

- **Node.js 22.13+** (module `node:sqlite` expérimental dans Node 22)
- **Python 3** dans `PATH`, uniquement pour conversion XLSX (script standard library)
- Aucun `npm install` nécessaire dans ce prototype.

## Démarrer en local

```bash
cp .env.example .env
# IMPORTANT : remplacez SESSION_SECRET par une chaîne générée aléatoirement
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
# collez la valeur obtenue dans .env
npm start
```

Ouvrez `http://localhost:3000` puis cliquez sur **Créer un compte société**. Créez un compte admin de votre société et un transporteur partenaire. Pour le livreur, créez un utilisateur de rôle `DRIVER`. Le livreur se connecte au **même URL**.

En développement : `npm run dev` (Node avec watch). Pour les tests : `npm run check`.

Le fichier `.env` est chargé via l'option native Node (voir `package.json`). La base locale est créée dans `data/delivery.sqlite` et ignorée par git.

## Exemple : Casablanca → Oscario (Tanger)

1. Admin crée le partenaire **Oscario**, choisit `Tanger` et copie **une seule fois** la clé API qui est générée.
2. Crée les commandes et choisit Oscario comme transporteur (ou utilise **Affecter** sur des colis déjà créés).
3. Dans **Transporteurs partenaires**, clique **Export XLSX**. Un bordereau `MAN-...` est créé, les colis passent à `EXPORTED`. Cela ne veut **PAS** dire que les colis ont été physiquement remis.
4. L'employé envoie le fichier XLSX par WhatsApp, manuellement. Oscario importe le fichier dans son propre système.
5. Le salarié d'Oscario scanne les barcodes. Une **intégration développée avec l'API réelle d'Oscario** envoie ensuite un changement de statut vers notre endpoint.
6. Le colis devient `PICKED_UP` (Ramassé). Les autres statuts sont répercutés dans l'espace marchand et le suivi public.
7. COD/versement reste séparé du statut de livraison : une commande livrée n'est pas automatiquement considérée comme encaissée ou payée au marchand.

**IMPORTANT** : le connecteur Oscario n'est **pas branché**. Nous ne disposons pas encore de sa documentation API. Le protocole générique entrant fonctionne (voir `docs/API.md`) mais il faut un adaptateur qui mappe son authentification, son format, les identifiants et ses notifications.

## Architecture et limitations

```
public/            UI responsive French, login, dashboards, PWA manifest
src/server.mjs     HTTP API, auth, permission checks, business transactions
src/db.mjs         SQLite schema multi-tenant (MVP local)
src/domain.mjs     Shipment lifecycle, partner status mapping
src/auth.mjs       Password hashing, signed session, API partner keys
src/excel.mjs      Import CSV + bridge XLSX
scripts/excel.py   Pure-stdlib ZIP/XML XLSX reader/writer
tests/             Node tests
examples/          Example Excel-compatible CSV
docs/              Architecture, API, roadmap, production checklist
```

This version intentionally uses dependency-free Node.js + SQLite to make the first working proof-of-concept testable here. **For production**, migrate to PostgreSQL, an audited/auth library with MFA and recovery, a background queue and jobs for integrations, object storage, monitoring and backup restores, proper tenant-level database RLS or per-tenant storage, and a payment provider for subscription billing. See `docs/ROADMAP.md`.

## Security / confidentiality

- `SESSION_SECRET` must be strong and persistent. Never commit `.env` or `data/`.
- If deployed behind HTTPS proxy, set `PUBLIC_BASE_URL=https://your-domain` and `COOKIE_SECURE=true`.
- Browser mutation requests use same-origin protection, a custom anti-CSRF header and SameSite cookies; API partners use independent Bearer keys stored as hashes.
- The public tracking endpoint has no rate limiting in the MVP. Do not expose publicly without abuse controls and threat review.
- This prototype does not have full privacy/compliance features, MFA, password reset, backups, anti-fraud, reliable financial ledger, and payment collection/settlements.
- **Do not use this pilot for real COD settlements or production customer data before a full review.**

© Project source is provided to the user for further development. No third-party logos or branding included.

## Colis workflow — update v0.2

The authenticated **Gestion des colis** now includes role-scoped actions:
parcel information, chronological status events, internal remarks, controlled
corrections, COD price changes (company ADMIN only), and 100 × 150 mm printable
shipping tickets. The ticket embeds an offline-generated Code128 barcode and a
QR code leading to a redacted public tracking timeline.

On small screens, orders render as responsive cards rather than a wide table.
The `PAYMENT` indicator refers specifically to **confirmed COD collection**, not
merchant payout or inter-company settlement. Corrections made after an Excel
partner export are marked `Modification à transmettre` until reconciled; this
version does not yet push edits to an external partner's API.

For usable printed QR links outside localhost, set `PUBLIC_BASE_URL` to the
actual HTTPS origin during deployment. Browser Print / Save as PDF is used;
there is no dedicated server-side PDF renderer.

The Code128 encoder is implemented locally; the QR encoder carries a vendored
MIT-licensed Kazuhiko Arase implementation under `src/vendor/qrcode/` with its
licence notice. New server integration tests cover tenant isolation for labels,
HTML escaping, role permissions, price edits, and partner update flags.

## Espace marchand enrichi — v0.4 (Livraisons 24h, relevés, stock détaillé)

- Ouvrir `/merchant.html` après connexion avec un compte marchand. Le comptable peut accéder au même écran pour consulter un marchand, configurer des tarifs et préparer un relevé.
- Rapport `Hier`, `24 heures`, `Aujourd'hui` ou date précise en fuseau **Africa/Casablanca** : colis livrés, COD déclaré, collecte confirmée, montant restant à collecter. Un statut « Livré » **ne prouve pas** le versement au marchand.
- Tarification par marchand et ville (ou `*` pour un tarif par défaut), en centimes MAD. Aucun montant net n'est inventé si le tarif manque.
- Relevés journaliers **brouillon → validé → marqué versé**. Les lignes sont une photographie immuable des colis livrés, COD encaissés et frais appliqués; un colis ne peut apparaître que dans un seul relevé. L'impression « Enregistrer en PDF » utilise le navigateur. **Un relevé ne constitue pas une facture fiscale, ni une preuve de virement bancaire.**
- Inventaire marchand par SKU : quantité physique, quantité réservée, disponible, répartition par dépôt/emplacement, lots FIFO, allocations. Le marchand n'accède qu'à ses propres produits. Les SKU doivent être associés à son `merchant_id` lors de leur création; l'administrateur peut attribuer les anciens SKU non associés après vérification.
- Le marchand peut créer une commande et réserver facultativement un SKU en FIFO dans la même transaction. Si le stock est insuffisant, la création de commande est annulée.
- Tests : isolation des marchands, quantités FIFO, refus des sur-réservations, collecte COD, relevés et versements étape par étape.

API : `GET /api/merchant/overview?period=yesterday|today|24h|date&date=AAAA-MM-JJ`, `GET /api/merchant/stock`, `GET /api/merchant/statements`, `POST /api/merchant/orders`, `GET /api/finance/merchant-list`, `POST /api/finance/merchant-rates`, `POST /api/finance/merchant-statements`, `POST /api/finance/merchant-statements/:id/confirm`, `POST .../:id/mark-paid`. L'API comptable est limitée à ADMIN/FINANCE. Voir les validations dans le code.

**Limites MVP** : pas de virements automatiques, contrôle bancaire, factures fiscales ou rapprochement intercompagnies complet. Avant utilisation réelle des fonds COD, prévoir les contrôles comptables, une base PostgreSQL multi-tenant, des sauvegardes et une validation fiscale/juridique.
