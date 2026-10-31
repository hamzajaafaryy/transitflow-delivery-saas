# TransitFlow API — société unique, agences et envois (v0.5)

Les routes sont préfixées `/api`. Les requêtes navigateur utilisent le cookie HttpOnly `dn_session`. Toute mutation navigateur requiert `X-Requested-With: delivery-ui` et, si présent, un `Origin` identique à `PUBLIC_BASE_URL`. La synchronisation agence utilise un Bearer distinct. JSON sauf import binaire, export XLSX et documents HTML.

## Configuration et comptes

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/auth/setup` | `{setupRequired,companyName}` |
| POST | `/auth/setup` | Configuration initiale unique : `{companyName,fullName,email,password}` ; ensuite HTTP 409 |
| POST | `/auth/login` | `{email,password}` ; aucun code société |
| POST | `/auth/logout` | Efface le cookie |
| GET | `/me` | Utilisateur, société et permissions |
| GET/POST | `/users` | Lecture opérations/admin ; création admin |
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
| GET/POST | `/shipments` | Commandes ; lectures filtrées par rôle, 300 derniers résultats |
| GET | `/shipments/:id` | Détail, événements et remarques internes selon rôle |
| PATCH | `/shipments/:id` | Corrections avec reason ; COD admin uniquement ; ville non modifiable après ramassage ; contenu d’un container ouvert/fermé protégé |
| POST | `/shipments/:id/notes` | Remarque opérations/admin |
| POST | `/shipments/assign` | `{shipmentId,driverId?}` ; aucune progression automatique de statut |
| POST | `/shipments/:id/status` | Transitions contrôlées ; les étapes ramassage et départ passent par leurs actions dédiées |
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

La clé n’autorise que les colis affectés à son agence. Pour les nouvelles commandes, ramassage et départ de container doivent être confirmés avant les événements de destination. Mappings : `EN_COURS` → IN_TRANSIT, `EN_LIVRAISON` → OUT_FOR_DELIVERY, `LIVRE` → DELIVERED, etc. Un scan d’arrivée dans le hub peut être transmis comme EN_COURS ; il ne doit pas ramener un colis en transit à l’étape ramassage warehouse. `eventId` est unique par agence ; les répétitions retournent `duplicate:true`, les régressions 409.

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
- `POST /ledger/collect {shipmentId}` : COD confirmé manuellement après livraison, une fois ; `GET /ledger` : journal.

Livraison, encaissement COD et paiement marchand restent trois opérations distinctes. Les relevés utilisent le calendrier `Africa/Casablanca`. Aucun endpoint ne déclenche un virement réel.
