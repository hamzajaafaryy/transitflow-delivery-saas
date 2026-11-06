# TransitFlow — exploitation d’une société de livraison au Maroc

Version 0.9 : une société, ses clients marchands, son warehouse et son réseau d’agences/hubs par ville. Les partenaires locaux sont des agences de destination ; aucune inscription de sociétés indépendantes ni abonnement SaaS.

## Tickets, scans et retours par ville v0.9

- **Tickets · ramassage** : colis externes du marchand, sans prélèvement warehouse. **Tickets · stock** : commandes préparées depuis ses produits. Chaque lot contient un seul marchand et une seule source ; un ticket Code128/QR par page **100 × 100 mm**. Sélection, impression groupée et réimpression sont disponibles dans les comptes marchands et à l’exploitation.
- La préparation d’un lot est une action enregistrée : les nouvelles commandes passent de « À imprimer » à **En attente de ramassage**. Ouvrir un aperçu en GET ne change rien. Une réimpression ne remet jamais un colis en arrière. La confirmation de l’imprimante physique reste celle de l’opérateur.
- Scan ramassage / préparation → **Ramassé** ; scan dans le bon d’envoi de la ville → **Envoi expédié** ; scan arrivée → **Reçu par ville** ; scan individuel de remise au livreur → **Mise en distribution**. La fermeture et le départ physique des containers restent enregistrés séparément. Une tournée ne démarre qu’après scan de tous ses colis.
- **Colis par agence** affiche les colis physiquement à l’agence ou avec ses livreurs, à partir de leur dernière position. Une affectation commerciale à Tanger ne suffit pas à prétendre que le colis y est arrivé.
- **Retours par ville** suit refusés, annulés et autres retours autorisés jusqu’à leur arrivée à l’origine. Ouvrir un container, scanner les colis de cette ville, fermer, puis confirmer le départ avec référence de transport. Une liste attendue peut être fournie par API ; les manquants bloquent la fermeture. Un container vide peut être rempli progressivement au scan. Deux containers ne peuvent pas retenir le même colis.
- À l’origine, scanner chaque colis attendu et indiquer son état physique. Un retour stock conforme est contrôlé et réintégré au stock du marchand propriétaire dans la même transaction, une seule fois. Un retour externe conforme entre dans **Retours aux marchands**, sans créer de SKU ou de stock. Un colis endommagé ou incomplet reste en contrôle sans ajouter de stock disponible.
- **Retours aux marchands** : ouvrir le bon du propriétaire, scanner les retours à lui remettre, puis confirmer le nom du réceptionnaire et la preuve de remise. Le statut devient **Retourné au marchand**. Le marchand consulte ses bons et leurs preuves ; il ne valide pas lui-même une remise effectuée par le warehouse.
- Une annulation avant collecte libère les réservations. Une annulation après collecte conserve la position physique et les sorties de stock : elle doit suivre le parcours retour. Une réception partielle de 49 colis sur 50 laisse le cinquantième dans les retours non reçus.

Le scan de réception d’un container inclut le contrôle de conformité déclaré par l’opérateur. La réception isolée d’un dossier retour historique reste distincte de son inspection. Les retours après livraison et les échanges conservent leur dossier, sans modifier rétroactivement la livraison ou le COD.

## Périmètre livré

- Commandes externes et commandes stock marchand, réservation FIFO atomique, contrôle SKU/code-barres et quantités avant sortie, bons de préparation et tickets privés 100 × 100 mm Code128/QR.
- Catalogue par marchand, bons de réapprovisionnement par dépôt ou collecte, ramasseur/véhicule, réceptions partielles, cartons, unités conformes/endommagées, écarts et justificatifs.
- Quarantaine séparée du disponible, traitement approuvé avec preuve, inventaires physiques soumis puis validés, mouvements de stock conservés et soldes de migration identifiés.
- Demandes de ramassage par boutique/fournisseur, point et rendez-vous ; ramasseur et véhicule personnel ou société ; collecte au scan, manquants et réception warehouse distincte.
- Containers par ville : attendus/scannés/manquants, contrôle destination/doublons, fermeture, Excel du lot et départ physique.
- Réception agence, périmètre propre à chaque agence, tournées, tentatives, reports datés, refus, injoignable, perte/dommage et colis retrouvé.
- Retours et échanges : demande, autorisation, conducteur, transport, réception, inspection, stock conforme, remise au marchand ou nouvel envoi avec nouveau tracking.
- Réclamations : conversation, agent support, priorité, délai cible configurable, notes internes privées, pièces PNG/JPEG/PDF, résolution et réouverture.
- COD déclaré, remise, écart de caisse, rapprochement, tarifs marchands, relevés, références de versement, ajustements et report des dettes. Montants en centimes entiers.
- Notifications internes, audit, désactivation des comptes et révocation serveur des sessions.

Le [cadrage métier et les sources marocaines](docs/OPERATIONS_MAROC.md) distingue les pratiques publiées et les choix propres à TransitFlow. Voir aussi l’[API](docs/API.md).


## Warehouse & stock v0.8

1. **Catalogue produits** : le marchand déclare ses SKU, codes-barres et seuils d’alerte. Deux marchands peuvent utiliser le même SKU sans partager leur stock.
2. **Entrées de stock** : créer un bon avec cartons et quantités annoncés. En collecte, affecter ramasseur et véhicule puis confirmer les cartons chez le marchand. Cette étape ne crée pas encore de stock warehouse.
3. **Réception** : saisir les cartons réellement arrivés, le réceptionnaire, la preuve et les quantités conformes ou endommagées par SKU. Plusieurs réceptions sont possibles. Les conformes deviennent des lots FIFO ; les dommages vont en quarantaine. Clôturer le bon avec un motif pour tout manque, surplus, dommage ou écart de cartons.
4. **Préparation stock** : ouvrir « Contrôler produits » depuis Réception & préparation, scanner chaque SKU/code-barres et sa quantité, puis scanner le tracking du colis. Un produit absent, une quantité supplémentaire ou un bon incomplet bloque la sortie.
5. **Inventaires** : le magasinier compte les lots d’un marchand/emplacement puis soumet. Direction/exploitation valide les écarts avec motif. Si stock, réservations ou lots ont changé entre-temps, recommencer ; les réservations ne peuvent pas devenir supérieures au physique.
6. **Quarantaine & mouvements** : direction/exploitation peut lever la quarantaine, remettre au marchand ou écarter physiquement des unités avec motif et preuve. Le journal conserve les variations conformes/réservées/quarantaine et l’auteur. Les anciens lots reçoivent un solde de migration, sans reconstituer un passé absent.

Les preuves sont des noms et références déclarées. La réception directe historique reste accessible pour les reprises de stock simples ; les réceptions avec bon suivent le parcours ci-dessus. Les produits endommagés des retours colis gardent leur dossier retour et ne sont pas dupliqués dans la quarantaine d’approvisionnement. Les pages marchands et les documents restent limités à leur magasin.

## Espace de travail v0.7

Navigation regroupée par exploitation, relation client, finance et ressources ; tableau de bord adapté au rôle avec priorités réelles, répartition des colis, principales villes et derniers mouvements. La liste colis propose recherche tracking/nom/téléphone/ID/marchand, filtres ville/statut/source/marchand, tri, pagination et export CSV des lignes sélectionnées. Les comptes conservent leurs périmètres côté serveur.

Les dossiers ramassage/retour/tournée/réclamation affichent leur progression et se rouvrent depuis leur URL. Les listes disposent de recherche, filtre d’état et pagination sur les éléments chargés. La création d’une commande est organisée par origine, destinataire et encaissement ; les erreurs restent visibles dans le formulaire. Les fenêtres prennent en charge Échap et la navigation clavier. L’interface mobile dispose d’une navigation dédiée, de cartes colis et de champs de saisie adaptés ; le portail stock/règlements partage la même présentation.

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
3. Le magasinier imprime bon et ticket, contrôle chaque SKU/code-barres et sa quantité pour STOCK, puis scanne le tracking : PICKED_UP. Les réservations sortent physiquement une seule fois. Un dépôt direct reste possible hors demande active.
4. Chaque colis attendu est scanné dans le container de sa ville avant fermeture. Le scan donne IN_TRANSIT. Excel, fermeture et départ physique restent séparés.
5. L’agence réceptionne au scan (AT_AGENCY), prépare une tournée, scanne chaque remise au livreur (OUT_FOR_DELIVERY), puis confirme le départ. Chaque arrêt a un résultat avant clôture.
6. Livrer exige réceptionnaire et COD exact. Un report exige une date future, un échec un motif. Déroger à un report/limite d’essais exige un motif responsable audité.
7. Le retour suit son propre dossier. La réception isolée n’ajoute jamais de stock vendable ; le scan de réception d’un container inclut le contrôle et sa décision. L’inspection autorise stock conforme, remise au marchand ou nouveau tracking lié à l’ancien.

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

Dans GitHub Codespaces, le serveur détecte le lien HTTPS du port à partir des variables de l’environnement Codespaces si PUBLIC_BASE_URL est vide ou conserve la valeur locale du fichier exemple. Le démarrage affiche `Browser origin` : c’est l’origine exacte autorisée pour les formulaires et les tickets. Une URL publique explicitement configurée reste prioritaire. Aucun en-tête Host/X-Forwarded-Host reçu du navigateur ne détermine cette autorisation. Le proxy Codespaces peut réécrire Origin vers localhost : cette variante est acceptée uniquement pour le Codespace et le port courants, avec X-TransitFlow-Origin égal à l’origine publique, l’en-tête anti-CSRF habituel et aucune métadonnée Fetch indiquant un autre site. Aucun joker CORS ni acceptation générale de localhost n’est ajouté. Une origine refusée est journalisée sans données de connexion.

Si un serveur déjà démarré répond « Origine non autorisée », l’arrêter avec Ctrl+C puis le relancer avec l’origine exacte copiée depuis la barre d’adresse de l’application, sans chemin ni paramètres :

```bash
PUBLIC_BASE_URL="https://votre-application.example" npm start
```

Recharger ensuite l’application. Modifier le fichier .env ou un export dans un autre terminal ne change pas la configuration d’un processus déjà démarré.

```bash
npm run check
```

La CI exécute aussi `npm run test:browser` : formulaires réels des deux sources, voiture personnelle, scan produits, collecte de réapprovisionnement, réception avec écarts, inventaire validé, quarantaine, journal stock, container/XLSX, agence, livraison/refus, retour/inspection, caisse et support. Elle contrôle SQLite et les espaces des onze rôles. Un second parcours vérifie les tickets 100 × 100 mm (PDF à deux pages), les retours ville, la réintégration stock, la remise marchand et les écrans mobiles. Captures desktop/mobile et résultats : artefact browser-evidence. Playwright est installé uniquement pour la CI, hors application.

## Architecture et migration

| Module dans src/ | Responsabilité |
| --- | --- |
| server.mjs, auth.mjs, access.mjs | HTTP, comptes, sessions révocables et permissions |
| db.mjs, workflow-db.mjs | Schéma, migration transactionnelle et contrôle FK |
| logistics.mjs | Agences, FIFO, préparation, containers et XLSX |
| labels.mjs, ticket.mjs | Lots de tickets 100 × 100 mm par marchand et source |
| custody.mjs, network-schema.mjs, return-network.mjs | Dernière position, retours ville, réceptions et remises marchands |
| pickups.mjs, delivery.mjs | Collectes, véhicules, arrivées, tournées et tentatives |
| returns.mjs, claims.mjs | Retours, inspection, échanges et service client |
| cash.mjs, merchant-portal.mjs | Remises, tarifs, relevés et ajustements |
| workflows.mjs, workflow-shared.mjs | Pilotage, notifications et contrôles partagés |

L’interface principale utilise public/app.js, operations.js, workflows.js et workflow-forms.js. Le portail détaillé utilise merchant.js.

La migration conserve commandes, utilisateurs, stock, événements et relevés. Elle transforme les anciens transporteurs multi-villes en agences et élargit les rôles sans supprimer les références utilisateurs. Plusieurs sociétés indépendantes dans une base sont refusées atomiquement. Sauvegarder avant mise à niveau.

## Limites

Les parcours sont exécutables ; l’application n’est pas certifiée prête pour une exploitation à grande échelle. La [suite du périmètre](docs/ROADMAP.md) comprend connecteurs partenaires réels, banques, signature/photo/OTP, approvisionnement SKU, multi-hubs, multi-cartons/livraison partielle, fiscalité, MFA/récupération, sauvegardes et charge. Les frais spéciaux de retour/stockage/ramassage utilisent un ajustement motivé ; aucun contrat d’un autre opérateur n’est appliqué automatiquement.
