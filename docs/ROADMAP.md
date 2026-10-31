# TransitFlow — suite du système d’une société de livraison

## Implémenté en v0.5

- Société unique, configuration initiale et connexion email/mot de passe.
- Agences / hubs par ville, internes ou partenaires, coût local indépendant du tarif marchand.
- Commandes externes et commandes stock, bons, tickets et réservation FIFO atomique.
- Scan ramassage avec sortie de stock, tri en containers par ville, contrôle des attendus/manquants/doublons, fermeture, Excel et confirmation de départ.
- Suivi agence entrant avec clé dédiée, contrôle des transitions et idempotence.
- Espace marchand, stock détaillé, relevés journaliers et suivi comptable des versements.
- Migration transactionnelle sans fusion de sociétés indépendantes.

## Opérations à compléter

- Réception à l’agence au scan, preuve de remise signée, écart départ/arrivée et transfert entre hubs.
- Comptes d’agence avec périmètre dédié, affectation des livreurs au hub et tournées.
- Retours au warehouse avec inspection et remise en stock, nouvelle tentative de livraison et échange.
- Bons de préparation groupés et picking multi-commandes ; plusieurs cartons physiques pour un envoi ; impression en lot.
- Intégrations officielles avec chaque opérateur : format Excel, webhooks/polling, authentification, retries et gestion des conflits.
- Lecture caméra en complément de la douchette clavier / saisie de tracking.

## Finance et exploitation

- Comptabilité complète des agences : COD détenu, frais dus sur livraisons, rapprochement des remises et règlements.
- Grand livre immuable et écritures de contrepassation, traitement des litiges et documents fiscaux adaptés.
- Stockage et migrations de production, sauvegardes/restaurations, observabilité et tests de charge.
- Authentification renforcée : MFA, récupération et révocation de sessions, invitations, limites de requêtes et audit indépendant.

Il n’existe pas de projet de vente d’abonnements SaaS ni d’inscription de sociétés indépendantes dans ce modèle produit. Chaque installation est dédiée à une seule société et à son réseau d’agences.
