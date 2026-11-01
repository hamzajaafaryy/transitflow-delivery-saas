# Cadrage métier — livraison au Maroc

Recherche consultée le 31 octobre 2026. Sources officielles publiques, sans accès aux logiciels internes. Les conditions commerciales d’un opérateur ne constituent pas une norme sectorielle.

## Sources et enseignements

| Source primaire | Observation utile |
| --- | --- |
| [Cathedis, FAQ](https://cathedis.ma/shortcodes/) | Distingue livraison créée, demande de ramassage par boutique/date/point et bon de collecte. Décrit tickets d’incident, lien facultatif à une livraison, états nouveau/en cours/résolu/clôturé et rapports de retours de fonds. |
| [Sendit, services](https://www.sendit.ma/nos-services/) | Collecte marchand ou fournisseur, demandes suivies, stockage, injoignable et réexpédition de colis annulés/retournés à d’autres clients. Retour physique et retour de fonds sont distincts. |
| [Chrono Diali](https://www.chronodiali.ma/) | Demandes de collecte, agences, suivi, étiquettes, retours à l’expéditeur, fonds et preuves de livraison. Mentionne espèces et carte à la livraison. |
| [Cathedis, tarifs](https://cathedis.ma/nos-tarifs/) | Conditions de retour, stockage et fréquence de versement variables selon le pack : à paramétrer selon contrat. |

Aucun quota de retour, délai de versement ou seuil de gratuité de ces opérateurs n’est imposé au propriétaire de TransitFlow.

## Choix du projet

Une seule société et des partenaires sous forme d’agences/hubs, une agence par ville normalisée, coût agence distinct du tarif marchand : ces décisions viennent du besoin du propriétaire. Elles ne décrivent pas tous les modèles des entreprises citées.

Les responsabilités sont séparées : marchand annonce ; ramasseur collecte ; warehouse reçoit/prépare/trie ; agence/livreur distribue ; comptabilité rapproche/verse ; support traite les demandes et coordonne contacts/retours. Les contrôles ci-dessous sont des choix d’implémentation propres au projet.

Les onze rôles et leurs périmètres sont détaillés dans le README ; les permissions exécutables sont dans src/access.mjs. Un véhicule personnel appartient à son conducteur, et le démarrage d’une mission refuse un conducteur/véhicule déjà en mission active. Plusieurs missions planifiées restent possibles.

## Documents et preuves

| Document/action | Ce qu’il établit |
| --- | --- |
| Ticket et bon livraison/stock | Identité et préparation demandée ; pas une collecte |
| Demande/bon ramassage | Point, rendez-vous et liste annoncée |
| Scan marchand | Collecte effective, COLLECTED |
| Contrôle produits STOCK | SKU/code-barres, produit et quantité conformes avant sortie |
| Scan warehouse | Réception colis et sortie FIFO une fois le contrôle STOCK complet, PICKED_UP |
| Container/bon envoi + scans | Liste attendue et contenu contrôlé d’une ville |
| Fermeture, Excel et départ | Trois actions distinctes ; téléchargement sans départ fictif |
| Réception agence | Colis réellement arrivés et différence attendu/reçu |
| Tournée/tentative | Conducteur, résultat, motif ou réceptionnaire et COD déclaré |
| Retour/inspection | Mouvement physique puis décision sur la marchandise |
| Remise/rapprochement | Brut, frais retenus, net attendu, reçu et écart |
| Relevé marchand | Livraisons rapprochées, frais, ajustements, dette et référence de versement |

La preuve nominative/référence n’est pas une signature électronique, un OTP ou une preuve bancaire automatique.

## Matrice des cas

| Situation | Comportement livré |
| --- | --- |
| EXTERNAL | Aucun prélèvement SKU ; collecte ou dépôt direct |
| STOCK | Propriété marchand et FIFO ; toutes les lignes réservées ou rollback |
| Plusieurs produits | Interface et API jusqu’à 20 références distinctes ; allocations par SKU |
| Rupture | HTTP 409, aucune commande/réservation partielle |
| Annulation avant sortie | Réservations libérées sans fausse entrée physique |
| Autre ramasseur/client | Accès/scan refusé |
| Marchand absent/collecte partielle | Manquants motivés, FAILED/PARTIAL, nouvelle demande possible |
| Colis attendu encore chez marchand | Réception warehouse bloquée tant que la demande active le dit attendu |
| Double scan | Pas de deuxième sortie de stock ; doublon de tri refusé |
| Mauvaise ville/container | Scan refusé, liste attendue conservée |
| Container incomplet | Fermeture refusée, manquants visibles |
| Arrivée tardive avant départ | Prochain container ; lot existant figé |
| Annulation envoi avant départ | Lot libéré, ramassage et stock conservés |
| Mauvaise agence à l’arrivée | Lecture/scan refusés |
| Colis manquant à l’arrivée | Attendu/reçu visible ; aucun AT_AGENCY sans scan |
| Arrêt sans résultat | Clôture tournée refusée |
| Injoignable/adresse/refus | Motif tracé sans livraison fictive |
| Report | Date future ; nouvelle tentative anticipée seulement avec dérogation auditée |
| Limite de tentatives | Configurable ; défaut interne 3, sans prétendre à une norme marocaine |
| Livré/prépayé | Nom et COD exact ; zéro si prépayé |
| Perte/dommage | Incident motivé et retrait tournée ; indemnisation séparée |
| Colis retrouvé | Scan exact et motif avant reprise |
| Retour demandé | Dossier séparé, aucun stock ajouté |
| Retour reçu | Quarantaine logique jusqu’à inspection |
| Abîmé/incomplet | Pas de stock vendable ; écartement ou remise marchand |
| Stock conforme | Nouvelle entrée FIFO après contrôle ; double restock interdit |
| Retour EXTERNAL | Aucun SKU inventé ; remise marchand ou réexpédition |
| Réexpédition/échange | Nouveau tracking lié, remplacement réservé ; pas d’échange simultané au pas de porte |
| Retour après versement | Historique livré et relevé payé conservés, ajustement distinct |
| COD déclaré non remis | Aucun crédit marchand automatique |
| Agence retient les frais | Brut moins frais agence figés = net attendu |
| Caisse avec écart | DISPUTED et motif ; pas de COD confirmé avant rapprochement exact |
| Double remise | Unicité par reçu ; refus de répétition |
| Frais supérieurs au COD | Relevé signé, débit reporté, pas de virement négatif |
| Réclamation générale/colis/ramassage | Historique, pièces privées, priorité, objectif, interlocuteur |
| Note interne | Cachée marchand/conducteur, accès pièces contrôlé |
| Résolution contestée | Réouverture motivée avec historique |
| Déconnexion/désactivation | Révocation serveur, cookie précédent inutilisable |

Les frais spéciaux de ramassage/retour/stockage, quotas et indemnisations dépendent d’un contrat. Les montants exceptionnels passent actuellement par ajustement motivé.

## Argent

Montants persistés en centimes. Exemple propre au besoin : Tanger, COD 200 MAD, frais agence 20, tarif marchand 30 donne net agence attendu 180 et dû marchand 170, hors ajustement. Le livreur interne remet le brut sans commission déduite automatiquement.

Un rapprochement exact confirme le brut une seule fois. Une différence bloque la confirmation. Un remboursement après versement ne réécrit pas la période réglée : ajustement négatif et dette reportée. Sa référence unique empêche le doublon logiciel ; son décaissement effectif reste externe.

## Vérification et limites

Les tests API/domaine/migration contrôlent les permissions, la propriété des produits, la collecte, les scans, les retours, les pièces et la finance. Les parcours Chromium de CI traversent les formulaires jusqu’aux écritures SQLite, avec captures desktop/mobile et onze rôles.

Les banques/partenaires réels, la charge et les appareils physiques restent à valider. [Travaux restants](ROADMAP.md) : approvisionnement SKU, multi-hubs/multi-cartons, tournées optimisées, fiscalité, preuves signées, sécurité renforcée et exploitation supervisée.


## Contrôles warehouse ajoutés en v0.8

Ces règles sont des choix du produit, à adapter aux pratiques et contrats de la société :

- Approvisionnement marchand annoncé par SKU et cartons ; dépôt ou collecte avec ramasseur et véhicule. Aucun stock disponible avant réception réelle.
- Réceptions successives par bon, conformes séparés des endommagés, surplus motivés, clôture avec écarts et documents nominatifs/références de preuve.
- Contrôle SKU/code-barres et quantités de chaque commande stock avant le scan du colis ; départ et retour conservent les mouvements de leurs lots.
- Inventaire de lots d’un marchand/emplacement, soumis au responsable ; régularisation atomique rejetée si les lots/réservations ont changé ou si le comptage ne couvre pas les réservations.
- Quarantaine d’approvisionnement isolée du disponible ; décision responsable motivée pour levée, remise ou écart physique. Les dommages des retours colis restent dans leur dossier de retour.
- Journal de stock conservé, signé par acteur et source ; les anciens stocks ont un solde d’ouverture à la migration et non un historique inventé.
