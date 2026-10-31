# TransitFlow — Gestion d’une société de livraison

TransitFlow gère **une seule société de livraison** et son réseau d’**agences / hubs par ville**. Les marchands sont les clients de cette société. Un partenaire local est enregistré comme une agence de destination, pas comme une société indépendante pouvant s’inscrire sur la plateforme.

Version 0.5 : prototype fonctionnel, avec préparation warehouse, ramassage au scan et containers par ville. Les relevés marchands, versements suivis en interne et vues de stock de la version 0.4 sont conservés.

## Organisation

- Configuration initiale unique de la société et de son administrateur.
- Connexion par **email + mot de passe**, sans code société ni inscription multi-sociétés.
- Rôles `ADMIN`, `OPERATIONS`, `DRIVER`, `MERCHANT`, `FINANCE`.
- Une agence / hub par ville, interne ou partenaire : nom, ville, opérateur, contact et coût de livraison.
- Exemple : **Agence Tanger**, opérateur local, **20 MAD par colis livré**. Ce coût est distinct du tarif facturé au marchand.
- Ajout des villes et modification des tarifs par l’administrateur. Les commandes utilisent les villes configurées et sont automatiquement rattachées au hub de destination.

## Parcours physique d’un colis

1. **Commande marchand** : un colis `EXTERNAL` sera reçu du marchand ; une commande `STOCK` contient les produits à préparer depuis son stock en warehouse.
2. **Bon de préparation** : bon de livraison pour un colis externe, ou bon stock avec SKU, quantités et emplacements. Imprimer le ticket 100 × 150 mm, avec destinataire, adresse, téléphone, tracking, Code128 et QR.
3. **Préparation** : coller le ticket sur le colis. Les produits d’un bon stock sont réservés en FIFO dès la création ; le stock physique n’est pas encore sorti.
4. **Ramassage** : scanner le tracking ou l’ID dans `Préparation & ramassage`. Le colis devient `PICKED_UP`. Pour une commande stock, ce scan confirme la sortie physique des réservations, dans la même transaction. Un colis externe ne prélève aucun stock. Un nouveau scan du même ramassage ne fait pas une deuxième sortie.
5. **Bon d’envoi par ville** : ouvrir un container pour l’agence. Il prend un instantané des colis ramassés encore disponibles pour cette destination ; une sélection explicite est aussi possible via API.
6. **Tri au scan** : scanner chaque colis avant de le placer dans le carton/container de sa ville. Contrôle de la ville, de l’agence, du ramassage et de l’appartenance au lot. Une autre ville, un doublon, un colis non ramassé ou déjà réservé à un autre container sont refusés. Affichage `Attendus / Scannés / Restants`.
7. **Fermeture** : possible uniquement quand tous les colis attendus sont scannés. L’Excel contient exclusivement ce container. Son téléchargement ne confirme pas un départ physique.
8. **Départ** : après remise physique au transport, l’opérateur confirme le départ. Le container devient `SHIPPED`, ses colis `IN_TRANSIT`. Le tarif agence du container est conservé comme instantané.
9. **Suivi** : l’agence peut transmettre ses événements API après le départ, avec une clé limitée à ses colis. Un adaptateur au logiciel réel du partenaire reste nécessaire.

Un colis ramassé après l’ouverture appartient à un prochain lot. Pour reconstituer un lot avant départ, l’opérateur peut annuler son bon avec un motif puis ouvrir un nouveau container ; les colis sont libérés et les mouvements de stock restent enregistrés. Un envoi déjà expédié ne peut pas être annulé de cette manière.

## Espace marchand et finance

`/merchant.html` donne accès aux livraisons d’hier, des dernières 24 heures ou d’une date, aux relevés et à l’inventaire détaillé du marchand : SKU, quantités physiques/réservées/disponibles, lots, emplacements et allocations.

Les commandes stock ne peuvent réserver que les produits appartenant au marchand authentifié. Une rupture annule toute la création et toutes les réservations de la commande.

Le statut de livraison, l’encaissement COD et le versement marchand sont distincts. La comptabilité confirme le COD, configure les tarifs marchands, génère un relevé journalier, le valide puis enregistre une référence de versement. Ces relevés sont des documents de rapprochement interne ; ils ne déclenchent pas de virement bancaire et ne constituent pas des factures fiscales.

## Démarrage local

Prérequis : **Node.js 22.13+**, **Python 3** dans `PATH` pour XLSX. Aucune installation npm n’est nécessaire.

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
# Mettre cette valeur dans SESSION_SECRET de .env.
npm start
```

Ouvrir `http://localhost:3000`, configurer la société une seule fois, se connecter puis ajouter les villes dans **Agences & hubs**. L’administrateur crée les marchands, les utilisateurs et le stock. Tous les rôles utilisent le même site ; le livreur dispose d’une vue mobile.

```bash
npm run dev
npm run check
```

La base locale est `data/delivery.sqlite`. Le fichier `.env` et les données ne sont pas versionnés. Pour le QR des tickets, définir `PUBLIC_BASE_URL` sur l’origine réelle ; activer `COOKIE_SECURE=true` derrière HTTPS.

## Architecture

| Fichier | Responsabilité |
| --- | --- |
| `src/server.mjs` | Serveur HTTP, configuration unique, sessions, commandes, permissions, import et COD |
| `src/logistics.mjs` | Agences, préparation, FIFO, ramassage, containers, scans, Excel et départ |
| `src/db.mjs` | Schéma SQLite et migration transactionnelle des anciennes bases |
| `src/merchant-portal.mjs` | Stock marchand, périodes Maroc, tarifs, relevés et versements |
| `src/domain.mjs` | Statuts, transitions et normalisation des villes |
| `src/ticket.mjs` | Ticket Code128 / QR et suivi public limité |
| `src/excel.mjs`, `scripts/excel.py` | Import CSV et lecture/écriture XLSX sans dépendances |
| `public/app.js`, `public/operations.js` | Interface principale, ramassage et tri par ville |
| `public/merchant.js` | Portail marchand avec stock et relevés |

## Migration depuis la version 0.4

La migration conserve les commandes, utilisateurs, marchands, stock, événements, tarifs et relevés. Elle renomme les anciennes tables/colonnes de sociétés et partenaires vers le modèle société unique / agences. Un ancien transporteur couvrant plusieurs villes est décliné en agences par ville. Les anciens exports restent en base comme archives.

La base refuse une migration contenant plusieurs sociétés indépendantes, ou plusieurs agences historiques pour une même ville, au lieu de fusionner ou supprimer des données. Toute la migration est transactionnelle. Utiliser une sauvegarde et une base dédiée à la société. Les colonnes historiques `slug` et `plan` restent internes pour la compatibilité des bases, sans sélection de société ni abonnement dans le produit.

## Vérification et limites

`npm run check` vérifie la syntaxe et les tests API/domaine/migration : société unique, permissions marchand/livreur, stock FIFO et annulation, ramassage sans double sortie, mauvais container, doublons, colis manquants, instantanés de tarifs, Excel, départ, événements agence, relevés et migration sans perte.

Le prototype n’a pas de connecteur réel à un partenaire, de preuve signée de remise, d’application scanner matérielle spécifique, de rapprochement comptable agence complet, de paiement bancaire automatique, de MFA, de récupération de compte ou de sauvegardes gérées. Le scan utilise une douchette clavier avec Entrée ou la saisie du tracking/ID ; le scan caméra n’est pas implémenté. Les reprises/retours au stock et les règles avancées multi-colis restent à compléter avant exploitation réelle.
