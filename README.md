# TransitFlow — exploitation d’une société de livraison au Maroc

Version 0.6 : une société, ses clients marchands, son warehouse et son réseau d’agences/hubs par ville. Les partenaires locaux sont des agences de destination ; aucune inscription de sociétés indépendantes ni abonnement SaaS.

## Périmètre livré

- Commandes externes et commandes stock marchand, réservation FIFO atomique, bons de préparation et tickets privés Code128/QR.
- Demandes de ramassage par boutique/fournisseur, point et rendez-vous ; ramasseur et véhicule personnel ou société ; collecte au scan, manquants et réception warehouse distincte.
- Containers par ville : attendus/scannés/manquants, contrôle destination/doublons, fermeture, Excel du lot et départ physique.
- Réception agence, périmètre propre à chaque agence, tournées, tentatives, reports datés, refus, injoignable, perte/dommage et colis retrouvé.
- Retours et échanges : demande, autorisation, conducteur, transport, réception, inspection, stock conforme, remise au marchand ou nouvel envoi avec nouveau tracking.
- Réclamations : conversation, agent support, priorité, délai cible configurable, notes internes privées, pièces PNG/JPEG/PDF, résolution et réouverture.
- COD déclaré, remise, écart de caisse, rapprochement, tarifs marchands, relevés, références de versement, ajustements et report des dettes. Montants en centimes entiers.
- Notifications internes, audit, désactivation des comptes et révocation serveur des sessions.

Le [cadrage métier et les sources marocaines](docs/OPERATIONS_MAROC.md) distingue les pratiques publiées et les choix propres à TransitFlow. Voir aussi l’[API](docs/API.md).

## Comptes et périmètres

| Compte | Travail principal | Périmètre |
| --- | --- | --- |
| ADMIN | Société, villes, comptes, paramètres et audit | Société |
| OPERATIONS | Warehouse, dispatch, tournées, retours, support | Société ; lecture caisse, sans validation de paiement |
| DISPATCHER | Ramassages, véhicules, envois et tournées | Société ; sans comptabilité ni entrée stock |
| WAREHOUSE | Réception/préparation, FIFO, tri et inspection retours | Warehouse ; sans caisse |
| PICKUP_DRIVER | Collecte et transport des retours affectés | Ses missions et son véhicule |
| AGENCY_MANAGER | Arrivées, tournées, livreurs, retours et remises | Son agence |
| AGENCY_AGENT | Réception et consultation des colis/envois | Son agence |
| DRIVER | Tournées, tentatives, preuve nominative et caisse | Ses colis et tournées |
| SUPPORT | Contacts, réclamations et autorisation retours | Société ; lecture ramassages, sans stock ni caisse |
| FINANCE | Rapprochement, tarifs, ajustements, relevés, versements | Société ; sans mouvement physique |
| MERCHANT | Commandes, stock, collecte/retour, réclamations et relevés | Son magasin |

Le serveur filtre aussi les documents et pièces jointes. Ramasseur et livreur sont deux rôles distincts ; le compte polyvalent reste à développer.

## Parcours physique

1. Le marchand crée EXTERNAL ou STOCK. Les produits appartiennent à son magasin et sont réservés en FIFO ; une rupture annule toute la transaction.
2. Le dispatcher affecte ramasseur et véhicule à une demande. Le scan chez le marchand donne COLLECTED. Les absents sont motivés et libérés pour une nouvelle demande.
3. Le magasinier imprime bon et ticket, prépare puis scanne : PICKED_UP. Pour STOCK, les réservations sortent physiquement une seule fois. Un dépôt direct reste possible hors demande active.
4. Chaque colis attendu est scanné dans le container de sa ville avant fermeture. Excel et départ sont séparés. Le départ donne IN_TRANSIT.
5. L’agence réceptionne au scan (AT_AGENCY), prépare une tournée et confirme le départ (OUT_FOR_DELIVERY). Chaque arrêt a un résultat avant clôture.
6. Livrer exige réceptionnaire et COD exact. Un report exige une date future, un échec un motif. Déroger à un report/limite d’essais exige un motif responsable audité.
7. Le retour suit son propre dossier. La réception seule n’ajoute jamais de stock vendable. L’inspection autorise stock conforme, remise au marchand ou nouveau tracking lié à l’ancien.

Douchette clavier avec Entrée, saisie tracking/UUID et URL QR sont acceptées. Pas de scan caméra ni de mode hors ligne.

## Exemple comptable

Tanger : COD **200 MAD**, coût agence **20 MAD**, tarif marchand **30 MAD**.

| Flux | Montant |
| --- | --- |
| COD déclaré agence | 200 MAD |
| Frais agence retenus, figés sur l’envoi | 20 MAD |
| Remise nette attendue | 180 MAD |
| Relevé marchand après rapprochement, hors ajustement | 170 MAD |
| Écart commercial avant autres charges | 10 MAD |

Une remise de moins de 180 MAD reste en litige et ne crédite pas automatiquement le COD marchand. Un rapprochement exact comptabilise le brut une seule fois. Le livreur interne remet le brut ; aucune commission personnelle n’est déduite automatiquement.

Un prépayé peut produire des frais et un relevé débiteur. Un remboursement après livraison est un ajustement distinct : le relevé payé reste inchangé, la dette se reporte. Aucun montant négatif n’est marqué comme virement sortant.

`/merchant.html` conserve les livraisons hier/24h/date au calendrier Africa/Casablanca, le stock détaillé, les relevés et impressions. Ce sont des documents de suivi interne, pas des factures fiscales ni des ordres bancaires.

## Démarrage

Prérequis : **Node.js 22.13+**, **Python 3** dans PATH pour XLSX. Aucune dépendance npm de production.

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
# Mettre cette valeur dans SESSION_SECRET de .env.
npm start
```

Ouvrir http://localhost:3000, configurer la société une fois, puis villes, marchands, comptes et stock. Définir PUBLIC_BASE_URL sur l’origine réelle ; derrière HTTPS, activer COOKIE_SECURE=true. Base : data/delivery.sqlite.

```bash
npm run check
```

La CI exécute aussi `npm run test:browser` : formulaires réels des deux sources, voiture personnelle, warehouse, container/XLSX, agence, livraison/refus, retour/inspection, caisse et support. Elle contrôle SQLite et les espaces des onze rôles. Captures desktop/mobile et résultats : artefact browser-evidence. Playwright est installé uniquement pour la CI, hors application.

## Architecture et migration

| Module dans src/ | Responsabilité |
| --- | --- |
| server.mjs, auth.mjs, access.mjs | HTTP, comptes, sessions révocables et permissions |
| db.mjs, workflow-db.mjs | Schéma, migration transactionnelle et contrôle FK |
| logistics.mjs | Agences, FIFO, préparation, containers et XLSX |
| pickups.mjs, delivery.mjs | Collectes, véhicules, arrivées, tournées et tentatives |
| returns.mjs, claims.mjs | Retours, inspection, échanges et service client |
| cash.mjs, merchant-portal.mjs | Remises, tarifs, relevés et ajustements |
| workflows.mjs, workflow-shared.mjs | Pilotage, notifications et contrôles partagés |

L’interface principale utilise public/app.js, operations.js, workflows.js et workflow-forms.js. Le portail détaillé utilise merchant.js.

La migration conserve commandes, utilisateurs, stock, événements et relevés. Elle transforme les anciens transporteurs multi-villes en agences et élargit les rôles sans supprimer les références utilisateurs. Plusieurs sociétés indépendantes dans une base sont refusées atomiquement. Sauvegarder avant mise à niveau.

## Limites

Les parcours sont exécutables ; l’application n’est pas certifiée prête pour une exploitation à grande échelle. La [suite du périmètre](docs/ROADMAP.md) comprend connecteurs partenaires réels, banques, signature/photo/OTP, approvisionnement SKU, multi-hubs, multi-cartons/livraison partielle, fiscalité, MFA/récupération, sauvegardes et charge. Les frais spéciaux de retour/stockage/ramassage utilisent un ajustement motivé ; aucun contrat d’un autre opérateur n’est appliqué automatiquement.
