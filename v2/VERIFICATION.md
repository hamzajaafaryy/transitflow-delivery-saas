# TransitFlow V2 · suivi du Master Spec

Le [Master Spec](TRANSITFLOW_MASTER_SPEC.md) reste intégral et prioritaire. Cette matrice documente l’état de vérification. Une ligne marquée **À valider** ne constitue pas une acceptation.

| Section | Parcours exercés sur PostgreSQL et API | À valider ou à compléter |
|---|---|---|
| 1. Identités | Sessions, TOTP, rôle restreint, marchand et agence de même ville isolés, Developer exclu de l’approbation Payé | Rotation et récupération des facteurs en exploitation, parcours livreur et organisation fine par département |
| 2. Commandes et scans | Commandes externe/stock, filtre et export, tickets 100×100, idempotence manuelle et journal | Matériel USB série et caméra sur appareils physiques, performance scanner en charge, documents multilingues et imprimante réelle |
| 3. Ramassage/envoi | Demande, affectation par zone, collecte, annulation avant collecte, clôture, ajout, départ, arrivée et verrouillage | Très gros imports/exports, workflows terrain avec livreur réel et modèles de partenaires |
| 4. Partenaire/custody | Webhook signé, inconnus conservés, replay de mapping, fonds et détenteur indépendants | Connecteurs sortants propres aux partenaires et contrats d’API réels, surveillance externe des pannes |
| 5. Stock | Manque de stock et blocage ticket, réapprovisionnement FIFO, déduction une fois, retour de stock unique | Tests de concurrence des ajustements et contrôle terrain de la quarantaine |
| 6. Retour Agence membership | XLSX, répétition active liée au bon, réimport après suppression, créateurs, chevauchements, code retiré, verrou et rapprochement | Mesures sur gros volumes et import des modèles de chaque agence |
| 7. Réception Retour Agence | Statut corrigé et rescan, concurrence, manuel confirmé, preuve, clôture et PDF | Appareils physiques, affichage photo révisé, PDF multipage à l’impression |
| 8. Retour Client | File, sélection, double exemplaire PDF, remise, confirmation par bon et interdiction de rouvrir après confirmation | Vérifier les variantes opérateur/clients sur plusieurs jours et les liens WhatsApp réels |
| 9. Finance | Crédit COD indépendant, refus, retrait marchand, remises partielles, restrictions et documents figés | Rapprochements bancaires réels, contrôle des corrections et dettes sur des historiques plus longs |
| 10. Réclamations | Réclamation après confirmation, doublon, privé, réponse, fermeture, trois réouvertures, calcul des pauses SLA | Charge et rééquilibrage >10 en exploitation, jours fériés configurés, attachements et flux temps réel en navigateur |
| 11. Sécurité/opérations | Rôle DB restreint, absence d’accès par ID, 2FA, CSRF, révocation, audit, 100 employés distincts en parallèle | Environnement HTTPS de revue, sauvegardes chiffrées 30/12 et restauration, surveillance externe, charge représentative avec volumes et actions multiples |
| 12. Acceptation | Builds Next/Nest, lockfiles, tests API/DB et test Chromium reproductible | Recette complète, validation métier, performances et déploiement de production |

## Mesures de développement

Sur un jeu fictif de petite taille, 100 employés distincts ont obtenu 100 réponses correctes sur la liste des commandes. Le p95 observé était **296,0 ms** à froid, connexions HTTP incluses. La cible de **200 ms** reste ouverte. Le script rapporte la mesure de chaque exécution.

## Décisions d’implémentation

- Next.js sert les interfaces et relaie la même origine vers Nest/Fastify. PostgreSQL reste la source d’état et de concurrence. Les petites tâches SLA et surveillance s’exécutent sous verrou PostgreSQL. Le déploiement distribué Redis/BullMQ reste à câbler.
- Le premier scan valide prend un verrou par agence pour sérialiser les Bons chevauchants. L’ordre parvient au warehouse dans la même transaction que le rapprochement et la file de remise ou la réintégration. La clôture fige les classifications visibles sur le bon. L’import XLSX déduplique le code et conserve les anomalies. L’empreinte canonique du contenu normalisé est limitée à l’agence.
- Les montants sont des centimes en base. Un bon de paiement agence cumule le COD brut des colis livrés choisis. Les tarifs livraison/refus et emballage marchand sont figés sur la commande pour le calcul marchand. Le Developer possède l’accès technique sans capacité de confirmer Payé.
- Le lecteur USB supporté dans le navigateur doit fonctionner en mode série avec terminaison CR/LF à 9600 bauds. Les caractères reçus par l’entrée clavier restent une saisie manuelle, y compris les douchettes clavier. La caméra utilise ZXing à la demande. La provenance client est auditée. Une attestation matérielle cryptographique exige un lecteur compatible et reste hors validation.
- Les pièces jointes sont des blobs PostgreSQL bornés et téléchargés via une route autorisée. Les justificatifs et journaux privés ne sont pas servis par Next.js statique. Les PDF de Preview utilisent des polices PDF standard, dont les jeux de caractères sont limités.
- Le calendrier ouvré applique le retour au GMT à partir du 20 septembre 2026, même si la base horaire du téléphone n’est pas à jour. Le manager renseigne les jours fériés. [Communiqué du gouvernement marocain](https://www.cg.gov.ma/fr/node/13036) Le compte Admin représente la direction pour la délégation des dossiers escaladés. Le support général applique affinité marchand, puis charge, puis dernière activité. Le retour marchand publie l’événement Reçu par client et attend la confirmation du marchand dans la même transaction.
- La Preview génère une base jetable et des comptes de démonstration aléatoires. Elle peut tourner dans un Codespace privé. L’exception de réécriture Origin est bornée au nom et au port 3200 de ce Codespace et exige un second en-tête de même origine.
