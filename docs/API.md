# TransitFlow API — société unique, agences et envois (v0.7)

Les routes sont préfixées `/api`. Les requêtes navigateur utilisent le cookie HttpOnly `dn_session`. Toute mutation navigateur requiert `X-Requested-With: delivery-ui` et, si présent, un `Origin` identique à `PUBLIC_BASE_URL`. La synchronisation agence utilise un Bearer distinct. JSON sauf import binaire, export XLSX et documents HTML.

## Configuration et comptes

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/auth/setup` | `{setupRequired,companyName}` |
| POST | `/auth/setup` | Configuration initiale unique : `{companyName,fullName,email,password}` ; ensuite HTTP 409 |
| POST | `/auth/login` | `{email,password}` ; aucun code société |
| POST | `/auth/logout` | Révoque la session serveur et efface le cookie |
| GET | `/me` | Utilisateur, société et permissions |
| GET/POST | `/users` | Lecture selon rôle/agence ; création admin |
| GET/POST | `/merchants` | Comptes clients de la société, opérations/admin |

`POST /auth/register` retourne 410. Il n’existe ni inscription d’une autre société ni facturation SaaS.

## Agences et villes

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/cities` | Villes configurées, accessibles aux comptes connectés |
| GET | `/agencies` | Liste opérations/admin |
| POST | `/agencies` | Admin : `{name,city,kind:"PARTNER" ou "INTERNAL",operatorName?,contact?,fee}` ; fee en MAD ; clé retournée une fois |
| PATCH | `/agencies/:id` | Admin : nom, fee, contact, operatorName ; ville fixe |
| POST | `/agencies/:id/rotate-key` | Admin ; révoque immédiatement l’ancienne clé |
| POST | `/agencies/:id/status-map` | Admin : `{map:{STATUT_EXTERNE:"IN_TRANSIT"}}` |

Une seule agence par ville normalisée (casse, espaces et accents). Exemple : Tanger, coût agence 20 MAD. Le coût agence et le tarif marchand sont indépendants.

## Commandes et préparation

```json
{
  "recipient": "Client",
  "phone": "0612345678",
  "city": "Tanger",
  "address": "Rue 12",
  "cod": 199,
  "source": "STOCK",
  "items": [{"productId": "UUID", "quantity": 2}]
}
```

`source` vaut `EXTERNAL` (sans produits) ou `STOCK` (1 à 20 produits distincts). Sans source explicite, la présence de produits détermine STOCK. Création et réservation FIFO sont atomiques ; une rupture retourne 409 et annule la commande. Le serveur détermine le marchand depuis sa session et l’agence depuis la ville. Les comptes marchands ne peuvent fournir une affectation agence/livreur ou un autre marchand.

| Méthode | Route | Description |
| --- | --- | --- |
| GET/POST | `/shipments` | Commandes ; lectures filtrées par rôle, q/status/limit/offset, max 300 par page, total inclus |
| GET | `/shipments/:id` | Détail, événements et remarques internes selon rôle |
| PATCH | `/shipments/:id` | Corrections avec reason ; COD admin uniquement ; ville non modifiable après ramassage ; contenu d’un container ouvert/fermé protégé |
| POST | `/shipments/:id/notes` | Remarque opérations/admin |
| POST | `/shipments/assign` | `{shipmentId,driverId?}` ; aucune progression automatique de statut |
| POST | `/shipments/:id/status` | Annulation seulement ; mouvements physiques par les workflows dédiés |
| GET | `/shipments/:id/ticket` | HTML privé 100 × 150 mm, Code128 et QR |
| GET | `/shipments/:id/preparation` | Opérations/admin : bon stock avec SKU/quantités/emplacements, ou bon livraison externe |
| GET | `/operations/queue` | Préparation et colis ramassés, maximum 1000 ; scan direct disponible au-delà |
| POST | `/operations/ramassage` | `{scan:"tracking ou UUID ou URL QR"}` ; réception et sortie FIFO atomiques pour STOCK |
| GET | `/tracking/:tracking` | Suivi public sans destinataire, téléphone, adresse exacte ou COD |
| GET | `/suivi/:tracking` | Page HTML publique, sans préfixe `/api` |

Un deuxième scan ramassage retourne `duplicate:true` sans nouvelle sortie de stock. Les corrections après départ restent marquées `pending_agency_update` et demandent transmission à l’agence ; aucune propagation sortante automatique n’est promise.

## Containers / bons d’envoi par ville

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/dispatches` | 200 derniers envois, avec compteurs expected/scanned |
| POST | `/dispatches` | `{agencyId,shipmentIds?}` ; instantané des colis ramassés non encore affectés ; maximum 2000 ; un container OPEN par agence |
| GET | `/dispatches/:id` | `{dispatch,items,summary:{expected,scanned,missing}}` |
| POST | `/dispatches/:id/scan` | `{scan}` ; contrôle ville/agence/ramassage/lot ; doublons refusés en 409 |
| POST | `/dispatches/:id/close` | `{}` ; exige tous les attendus scannés ; état CLOSED |
| POST | `/dispatches/:id/export` | `{}` ; XLSX du seul container CLOSED/SHIPPED ; aucune transition de livraison |
| POST | `/dispatches/:id/ship` | `{}` ; départ physique explicite après fermeture ; SHIPPED et colis IN_TRANSIT |
| POST | `/dispatches/:id/cancel` | `{reason}` ; OPEN/CLOSED seulement ; libère les colis sans effacer leur ramassage/stock |

Un colis ramassé après l’ouverture est destiné à un prochain lot. Les tarifs sont figés dans chaque container. Colonnes XLSX : `Tracking, Destinataire, Téléphone, Adresse, Ville, COD, Description`. Les modèles propres au logiciel de l’agence nécessitent une adaptation.

## Suivi entrant des agences

```http
POST /api/integrations/status
Authorization: Bearer dn_...
Content-Type: application/json

{"eventId":"agence-123","tracking":"TF...","status":"EN_LIVRAISON"}
```

La clé n’autorise que les colis affectés à son agence. Pour les nouvelles commandes, ramassage et départ de container doivent être confirmés avant les événements de destination. Mappings : `EN_COURS` → IN_TRANSIT, `EN_LIVRAISON` → OUT_FOR_DELIVERY, `LIVRE` → DELIVERED, etc. RECU_AGENCE → AT_AGENCY, INJOIGNABLE → UNREACHABLE. RETURNED entrant devient RETURNING jusqu’à réception physique du retour. `eventId` est unique par agence ; les répétitions retournent `duplicate:true`, les régressions 409.

## Stock et comptabilité conservés

- `GET /inventory`, `POST /inventory/products {sku,name,merchantId?}`, `POST /inventory/receive {productId,quantity,location?}`.
- `POST /inventory/reserve {shipmentId,productId,quantity}` : réservation manuelle avant ramassage, transforme le colis en commande stock.
- `POST /inventory/dispatch` retourne 410 : utiliser le scan ramassage pour la sortie physique.
- `POST /import/orders` : CSV/XLSX binaire, 4 Mo et 1000 lignes maximum ; validation des villes et rapport des doublons/erreurs.
- `GET /merchant/overview?period=yesterday|today|24h|date&date=AAAA-MM-JJ`, `/merchant/stock`, `/merchant/statements` ; filtrés sur le marchand connecté. Admin/finance ajoutent `merchantId`.
- `POST /merchant/orders` : création marchand utilisant la même transaction de commande/réservation.
- `GET /merchant/deliveries/print?period=yesterday|today|24h|date&date=AAAA-MM-JJ` : rapport des livraisons de la période, imprimable.
- `GET /merchant/statements/:id/print` : relevé privé imprimable, pas une facture fiscale.
- `GET /finance/merchant-list`, `GET/POST /finance/merchant-rates`, `POST /finance/merchant-product-owner` (admin), `POST /finance/merchant-statements`, `POST /finance/merchant-statements/:id/confirm`, `/mark-paid`.
- `POST /ledger/collect {shipmentId}` : Compatibilité historique uniquement sans reçu opérationnel ; un reçu non rapproché impose le workflow caisse ; `GET /ledger` : journal.

Livraison, encaissement COD et paiement marchand restent trois opérations distinctes. Les relevés utilisent le calendrier `Africa/Casablanca`. Aucun endpoint ne déclenche un virement réel.


## Comptes et sessions v0.6

`PATCH /users/:id {name?,phone?,role?,agencyId?,merchantId?,password?,active?}` : admin ; agence requise pour les rôles agence, marchand requis pour MERCHANT. La modification sensible révoque les sessions. Le dernier administrateur actif est protégé. Les onze rôles figurent dans `src/access.mjs`. Les rôles agence sont limités à leur agence, les marchands à leur magasin, les conducteurs à leurs missions.

Champs commande supplémentaires : `sector`, `fragile` et `allowOpen` booléens. Les routes ci-dessous sont relatives à `/api/workflow`.

## Ramassages et véhicules

| Méthode | Route | Données / contrôle |
| --- | --- | --- |
| GET | `/bootstrap` | Permissions, annuaires autorisés et paramètres |
| GET | `/eligible?kind=pickup&merchantId=...` | EXTERNAL CREATED sans collecte active |
| GET/POST | `/pickup-points` | merchantId si équipe, label, contactName, phone, city, address, notes? |
| GET/POST | `/vehicles` | plate, kind CAR/VAN/MOTORCYCLE/TRUCK, ownership DRIVER/COMPANY, driverId ; création exploitation/dispatcher |
| GET/POST | `/pickups` | pointId, merchantId?, scheduledAt ISO, slot?, shipmentIds ; 1 à 1000 colis distincts |
| GET | `/pickups/:id` | Point, demande, attendus/collectés/manquants/reçus |
| POST | `/pickups/:id/assign` | driverId PICKUP_DRIVER, vehicleId compatible |
| POST | `/pickups/:id/start` | Mission affectée, conducteur/véhicule disponibles |
| POST | `/pickups/:id/scan` | scan : colis attendu de ce marchand ; COLLECTED |
| POST | `/pickups/:id/complete` | receiverName, note obligatoire si manquants ; libère absents |
| POST | `/pickups/:id/cancel` | reason ; avant démarrage |
| GET | `/pickups/:id/print` | Bon privé imprimable |

La réception warehouse reste `POST /api/operations/ramassage`. Elle marque les éléments collectés RECEIVED séparément de la collecte marchand. Le support a lecture seule des ramassages.

## Agence, tournées et tentatives

| Méthode | Route | Contrat |
| --- | --- | --- |
| GET | `/arrivals` | Envois partis et attendus/reçus dans le périmètre |
| GET | `/arrivals/:dispatchId` | Liste attendus et manquants |
| POST | `/arrivals/:dispatchId/scan` | scan attendu de l’agence ; AT_AGENCY |
| GET | `/arrivals/:dispatchId/print` | Bon de réception |
| GET | `/eligible?kind=route&agencyId=...` | Colis potentiellement disponibles ; création revalide tous les critères |
| GET/POST | `/routes` | agencyId, driverId, vehicleId?, date?, shipmentIds, overrideReason? ; max 500 |
| GET | `/routes/:id` | Arrêts ordonnés et états |
| POST | `/routes/:id/start` | DRAFT → ACTIVE, colis OUT_FOR_DELIVERY |
| POST | `/routes/:id/close` | ACTIVE → CLOSED, aucun arrêt sans résultat |
| POST | `/routes/:id/cancel` | reason ; DRAFT seulement |
| GET | `/routes/:id/print` | Feuille de tournée |
| GET/POST | `/shipments/:id/attempts` | Historique / résultat de tentative |
| POST | `/shipments/:id/contact` | outcome REACHED/NO_ANSWER/WRONG_NUMBER/CALLBACK, note, nextAttemptAt? |
| POST | `/shipments/:id/incident` | kind LOST/DAMAGED, note ; responsable |
| POST | `/shipments/:id/recover` | scan, note ; colis LOST retrouvé |

Tentative : `result` DELIVERED/REFUSED/UNREACHABLE/POSTPONED/BAD_ADDRESS, `note`, `receiverName`, `collectedAmount` MAD, `paymentMethod` CASH/CARD, `paymentReference` carte, `nextAttemptAt` ISO et `requestId` idempotent facultatif. DELIVERED exige nom et COD exact ; POSTPONED exige date future ; échec exige motif. Une nouvelle tournée avant rendez-vous ou au-delà de la limite exige dérogation responsable. Aucun paiement carte réel n’est déclenché.

## Retours et échanges

| Méthode | Route | Données / étape |
| --- | --- | --- |
| GET/POST | `/returns` | shipmentId, kind RETURN/EXCHANGE, reason, items? [{allocationId,quantity}] |
| GET | `/returns/:id` | Dossier, colis et produits réellement sortis |
| POST | `/returns/:id/authorize` | accepted booléen, note ; décision responsable |
| POST | `/returns/:id/assign` | driverId retour |
| POST | `/returns/:id/ship` | proofReference ; AUTHORIZED → IN_TRANSIT |
| POST | `/returns/:id/receive` | scan, condition SEALED/GOOD/DAMAGED/INCOMPLETE, note si écart |
| POST | `/returns/:id/inspect` | disposition RESTOCK/RETURN_MERCHANT/RESHIP/DISCARD, note, location? |
| POST | `/returns/:id/complete` | receiverName/proofReference si remise marchand |
| POST | `/returns/:id/cancel` | reason ; demande non traitée |
| POST | `/returns/:id/reexpedite` | order avec nouveau destinataire/téléphone/ville/adresse/COD ; nouveau tracking |
| POST | `/returns/:id/replacement` | order de remplacement (STOCK/items) après inspection d’un EXCHANGE |
| GET | `/returns/:id/print` | Bon de retour privé |

Une demande ne change pas le stock. RESTOCK exige réception et inspection conforme des produits stock réellement sortis ; double retour au-delà des quantités sorties refusé. EXTERNAL ne crée aucun SKU. Un retour après livraison garde le statut DELIVERED et les relevés historiques ; remboursement séparé. Le remplacement est lié à l’ancien tracking, pas une livraison simultanée au pas de porte.

## Réclamations, pièces et notifications

`GET/POST /claims` : subject, message, category DELAY/DELIVERY/RETURN/STOCK/PAYMENT/DAMAGED/LOST/TECHNICAL/OTHER, priority NORMAL/HIGH/URGENT, shipmentId?, pickupId?, merchantId? (équipe). Un conducteur doit lier sa mission/son colis. Les agences ne voient pas les réclamations financières.

- `GET /claims/:id` : messages autorisés et pièces.
- `POST /claims/:id/messages {message,internal?}` : internal réservé au support/exploitation.
- `POST /claims/:id/update {state,assignedTo?,note}` : IN_PROGRESS/WAITING_MERCHANT/WAITING_AGENCY/RESOLVED/CLOSED. Le marchand peut confirmer la clôture après résolution ou rouvrir avec motif.
- `POST /claims/:id/attachments {filename,mime,base64,messageId?}` : 1 Mo, cinq pièces, PNG/JPEG/PDF vérifiés.
- `GET /claims/:id/attachments/:attachmentId` : téléchargement privé avec contrôle du ticket et de la note interne.
- `GET /notifications`, `POST /notifications/read {id?}` : utilisateur courant.
- `GET /overview` : pilotage filtré ; caisse nationale réservée finance/admin.
- `GET /audit` : admin, 300 dernières opérations.
- `POST /settings {claimSlaHours,maxDeliveryAttempts}` : admin ; délais internes, pas une garantie commerciale universelle.

## Caisse et ajustements

| Méthode | Route | Contrat |
| --- | --- | --- |
| GET | `/cash` | Reçus et remises ; filtre livreur/agence |
| POST | `/cash/remittances` | receiptIds, proofReference, note? ; un seul détenteur, reçu non déjà remis |
| POST | `/cash/remittances/:id/reconcile` | receivedAmount MAD signé, note obligatoire si écart ; finance/admin |
| GET/POST | `/adjustments` | merchantId, kind REFUND/COMPENSATION/FEE_CORRECTION, amount signé, reference unique, note, returnId? ; création finance/admin |

Le reçu créé lors d’une livraison est DECLARED. La remise est SUBMITTED. Pour une agence : net attendu = COD brut − frais agence figés. Un écart donne DISPUTED sans crédit COD ; un rapprochement exact donne RECONCILED et inscrit le brut une seule fois. Un net négatif représente un paiement dû à l’agence pour du prépayé, pas du cash reçu positif.

REFUND est négatif ; avec returnId il exige un retour reçu après livraison. COMPENSATION est positif. Les ajustements sont intégrés une fois aux relevés marchands ; une dette validée est reportée une fois au relevé suivant. Un relevé négatif ou déjà reporté ne peut pas être marqué payé. Les références restent déclaratives ; aucune route ne déclenche un virement.


## Recherche et pilotage v0.7

`GET /shipments` accepte `q` (tracking, nom, téléphone, ID exact ou nom marchand), `city`, `status`, `source=EXTERNAL|STOCK`, `merchantId`, `sort=newest|oldest|cod_desc`, `limit` et `offset`. Les critères s’ajoutent au périmètre de la session ; ils ne le remplacent jamais. Le total filtré est renvoyé avant pagination. Le CSV de l’interface exporte uniquement les lignes visibles sélectionnées, avec protection des cellules interprétables comme formules.

`GET /workflow/overview` ajoute `cityDistribution`, `recentShipments`, `recentActivity` et, pour les rôles autorisés, `cashHeldCentimes` filtré sur leur caisse. Les derniers colis et mouvements sont filtrés par la même portée marchand/agence/conducteur que la liste colis. Aucun chiffre de démonstration ni tendance artificielle n’est utilisé dans le tableau de bord.
