# Périmètre livré et travaux restants — v0.8

## Disponible

Société unique ; onze rôles ; agences par ville ; commandes externes/stock FIFO ; tickets et bons ; collecte avec ramasseur/véhicule personnel ; réception warehouse ; containers/Excel/départ ; arrivée agence ; tournées/tentatives ; motifs/report/dérogation ; perte/dommage/colis retrouvé ; retours/inspection/restock/remise marchand/nouvel envoi/échange ; réclamations/pièces privées ; notifications ; COD déclaré/remis/rapproché ; frais agence retenus ; tarifs/relevés/ajustements/dettes ; sessions révocables et audit ; catalogue marchand ; collecte de réapprovisionnement SKU ; réceptions multi-cartons/partielles avec écarts ; scan des produits par SKU/code-barres ; quarantaine d’approvisionnement et preuves de traitement ; comptages de lots avec validation responsable ; journal immuable des mouvements et soldes de migration.

Le [cadrage métier](OPERATIONS_MAROC.md) décrit les cas et sources. Les tests API et parcours Chromium de la CI sont reproductibles.

## Intégrations et preuves

- Adaptateur réel par partenaire : authentification, modèle Excel, API sortante, retries et conflits. Le webhook générique n’établit pas de connexion commerciale.
- Paiement bancaire/carte réel et import de relevés : les références actuelles sont déclaratives et rapprochées manuellement.
- Signature, photo, GPS ou OTP de remise : preuve actuelle nominative/référence et historique seulement.
- SMS/WhatsApp/email/push : notifications actuelles dans l’application.

## Cas physiques avancés

- Picking groupé par vague, emplacement/lot scanné, dates d’expiration, planification des inventaires tournants et suivi des écarts récurrents ; actuellement contrôle produit/quantité et comptage explicite par marchand/emplacement.
- Unification de la quarantaine d’approvisionnement avec les produits endommagés en retour ; actuellement deux dossiers séparés, sans double remise en stock.
- Plusieurs cartons/commande, livraison partielle, échange simultané au pas de porte ; actuellement colis livré entier et remplacement après contrôle du retour.
- Transferts multi-hubs, transporteurs intermédiaires et circuit de collecte multi-boutiques optimisé ; actuellement une mission par point.
- Optimisation/GPS, mode hors ligne, caméra ; actuellement ordre d’arrêts et douchette clavier.
- Compte polyvalent ramasseur/livreur et remplacement de conducteur après départ.

## Finance et contrats

- Frais automatiques de ramassage, stockage, échec, retour, poids/volume, zones et commissions conducteur ; actuellement livraison et ajustements motivés.
- Partie double, fiscalité et règles de clôture à valider avec un professionnel.
- Paiement entrant d’une dette marchand, avances et garanties ; actuellement report sur les relevés suivants.
- Remboursement effectif destinataire et preuve de décaissement : l’ajustement ne réalise pas de remboursement bancaire.
- Contrepassation d’une remise rapprochée/relevé validé : les documents restent figés, corrections par ajustements et contrôle comptable.

## Production

Sauvegardes et restauration, migrations sur copie anonymisée, supervision/alertes, charge/concurrence, MFA, invitation/récupération, rotation secrets, conservation des pièces et revue des accès ; validation des contrats/données personnelles/documents ; accessibilité complète et tests sur imprimantes/douchettes réelles.

Ces éléments restent hors du périmètre livré. L’interface ne les simule pas comme des services connectés.
