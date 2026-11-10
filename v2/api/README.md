# TransitFlow V2 API — initial bootstrapping

Requires Node.js 22+. From this directory:

```sh
npm install
npm run check
npm run build
npm start
```

Health endpoint: `GET /api/v2/health/live`.

This is a deliberately minimal NestJS + Fastify bootstrapping skeleton. It is **not** an authenticated business API. Do not expose customer, financial or scan endpoints until server-side authorization, tenant scoping, DB grants, migrations and integration tests are complete.

Next tasks: validated config, database connection with least-privilege role, session authentication and authorization guards, transaction-safe scan service, tests, CI.
