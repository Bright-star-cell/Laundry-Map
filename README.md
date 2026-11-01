# Laundry Map

Laundry Map is a multi-persona laundry marketplace pilot for Karu and Mararaba, Nasarawa State. The repository is an npm-workspaces monorepo with a Next.js PWA, an Express/Socket.IO API, PostGIS, and Redis.

## Run Locally

Requirements: Docker Compose v2 and a Codespaces-compatible Node 22 container.

```sh
cp .env.example .env
docker compose --profile development up --build
```

The development container installs workspace dependencies and starts the API on port 4000 and PWA on port 3000. PostgreSQL/PostGIS and Redis start with health checks; the initial schema and Karu/Mararaba partner records are loaded into a new database volume. In GitHub Codespaces, reopen the repository in its dev container and use the forwarded port 3000.

For host-based development with Node 22 installed, start only PostgreSQL and Redis with `docker compose up -d postgres redis`, copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env.local`, then run `npm ci` and `npm run dev`. `npm run typecheck`, `npm test`, and `npm run build` check both workspaces.

Local Compose values are for development only. Replace `JWT_SECRET` with a randomly generated secret of at least 32 characters and configure provider secrets before accepting real payments. Paystack is initialized by the application; payment is considered complete only after a valid signed webhook with the expected amount and NGN currency. Flutterwave webhook confirmation is supported, but a Flutterwave checkout-initialization endpoint is not included.

## Production Containers

The `api` and `web` services are in the `production` profile. To run those images with the local database and Redis for a staging smoke test:

```sh
docker compose --profile production up --build api web postgres redis
```

Do not expose the Compose database credentials or development JWT fallback to the internet. Production deployments should provide managed PostgreSQL with PostGIS and Redis, TLS, a strong secret manager-backed `JWT_SECRET`, provider webhook secrets, backups, monitoring, and an HTTPS origin through environment configuration. Set `DATABASE_SSL=true` when the PostgreSQL provider requires TLS.

## Partner Provisioning

Public registration creates customer accounts only. Vendor and courier accounts are provisioned by operations with the backend CLI. Supply `PARTNER_ROLE`, `FULL_NAME`, `EMAIL`, `PHONE` and a secret `PASSWORD` of at least 12 characters in the environment. For vendors also supply `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `LATITUDE`, and `LONGITUDE`; the service prices default to the pilot catalog in naira and can be overridden with `WASH_AND_FOLD_PRICE_NAIRA`, `DRY_CLEANING_PRICE_NAIRA`, and `IRONING_PRICE_NAIRA`.

```sh
npm run provision:partner -w @laundry-map/backend
```

Use a secret manager or an interactive shell to set the password. Never commit credentials or place them in shell history. Seeded demo vendor accounts are directory records only; create operational accounts with this command.

## Order Lifecycle

Orders are locked with `SELECT ... FOR UPDATE` during transitions. Vendor acceptance is limited to the two-minute window beginning at payment confirmation. Courier assignment is atomic; the assigned courier can record pickup, laundromat arrival, and the return leg. Delivery requires the customer’s six-digit code. The API stores a one-way verification hash and a separately authenticated-encrypted copy so the customer can retrieve the code after sign-in; access to `JWT_SECRET` therefore requires the same care as other encryption keys.

Socket.IO authenticates with the API JWT. Clients may subscribe only to orders visible to their account. Courier location sharing is opt-in in the PWA and broadcasts validated coordinates to subscribed order clients. The service worker caches same-origin app assets and keeps API requests network-only.

## Main API

- `POST /api/auth/register`, `POST /api/auth/login`
- `GET /api/vendors?latitude=8.9912&longitude=7.6031`
- `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `PATCH /api/orders/:id/status`
- `POST /api/payments/initialize`, `POST /api/payments/paystack/webhook`, `POST /api/payments/flutterwave/webhook`
- `GET /api/vendor/orders`, `POST /api/vendor/orders/:id/accept`
- `GET /api/courier/jobs`, `POST /api/courier/jobs/:id/accept`, `POST /api/courier/jobs/:id/complete`
- `GET /health/live`, `GET /health/ready`

All amounts are integer kobo in the database and NGN in checkout. Order prices are looked up server-side from each vendor’s catalog; client-submitted unit prices are ignored.
