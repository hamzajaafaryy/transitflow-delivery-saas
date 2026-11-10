# TransitFlow V2

Le [Master Spec](../TRANSITFLOW_MASTER_SPEC.md) définit le métier. Le [suivi de vérification](../VERIFICATION.md) distingue les parcours vérifiés, ceux qui restent à exercer et les dépendances de déploiement.

## Lancer la Preview isolée

Sur Linux ou dans un Codespace, depuis la racine du dépôt et sur la branche `transitflow-v2-foundation` :

```bash
npm ci --prefix v2/api
npm ci --prefix v2/web
npm run build --prefix v2/api
NEXT_TELEMETRY_DISABLED=1 npm run build --prefix v2/web
node v2/preview/run.mjs
```

Node.js 22.13+ et Python 3 sont nécessaires. Ouvrir l’URL imprimée. Dans **Codespaces**, ouvrir le port **3200** via l’onglet **Ports**, visibilité **Private**. Le serveur imprime trois connexions synthétiques (exploitation, agence et marchand) et un code de réception à tester. Les identifiants sont aléatoires à chaque démarrage. Seuls des exemples fictifs sont créés. Ctrl+C ferme l’API, le web et la base de cette session.

Le PostgreSQL embarqué est réservé à la vérification Linux x64/arm64. Pour utiliser un serveur local à la place, fournir `TF_MIGRATION_DATABASE_URL` vers un cluster de test sur loopback, avec un compte capable de créer une base et un rôle de test. Le script crée une base unique et la supprime à l’arrêt. Exposer uniquement le port web sur un réseau de revue authentifié. Les ports API et PostgreSQL restent internes.

## Serveurs et migrations hors Preview

- Appliquer les migrations ordonnées avec `TF_MIGRATION_DATABASE_URL=… node v2/api/scripts/migrate.mjs` sur une base V2 dédiée. Le compte de migration est distinct du compte de service.
- Créer un rôle LOGIN dédié à cette seule base, lui accorder `transitflow_v2_runtime` et l’accès à la base. Configurer `TF_DATABASE_URL` avec ce rôle. L’API refuse un rôle propriétaire ou ayant les droits de mutation des preuves. La base doit rester sur un réseau privé et utiliser TLS lorsque le client quitte l’hôte.
- Générer une clé de 32 octets via un gestionnaire de secrets pour `TF_DATA_KEY` (64 caractères hex). Définir `TF_APP_ORIGIN` à l’origine HTTPS exacte du web. `TF_API_URL` à la compilation de Next.js désigne l’API privée. Les sessions sensibles nécessitent TOTP.
- Pour le premier Admin et l’unique Developer, transmettre un JSON conforme à `accountInput` via stdin à `node v2/api/scripts/provision.mjs`, avec URL de migration et clé dans l’environnement. Champs obligatoires `login`, `name`, `password`, `role`, `totpSeed`. Le secret doit être provisionné dans l’application d’authentification du compte via un canal privé. Le endpoint standard ne permet pas de créer ces deux rôles.
- `GET /api/v2/health/live` et `GET /api/v2/health/ready` distinguent vie et accès PostgreSQL.

## Webhook partenaire

Le Developer configure une clé aléatoire par agence et ses correspondances dans **Intégrations**. Le partenaire envoie `POST /api/v2/partner/{agencyId}/events` avec `id`, `trackingCode`, `externalStatus`, `occurredAt` (ISO 8601). L’en-tête `X-TF-Timestamp` contient les secondes Unix actuelles. `X-TF-Signature` vaut `sha256=` suivi de HMAC-SHA256 hexadécimal des cinq valeurs séparées par un saut de ligne, dans cet ordre : timestamp, id, code en majuscules, statut externe exact, date ISO exacte. Tolérance de cinq minutes. Réutiliser le même identifiant pour réessayer un même événement. Le statut non mappé renvoie 202 et reste disponible au Developer. La référence n’est recevable que pour un envoi de l’agence.

## Vérification

```bash
npm run check --prefix v2/api
TF_MIGRATION_DATABASE_URL=… node --test v2/api/tests/operations.integration.mjs
NEXT_TELEMETRY_DISABLED=1 npm run build --prefix v2/web
NODE_PATH=/path/to/playwright/node_modules node --test v2/preview/browser.test.mjs
```

Pour les tests navigateur, installer Chromium via Playwright ou définir `CHROMIUM_EXECUTABLE_PATH` vers le Chromium du runner.
