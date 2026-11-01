# Laundry Map

**Neighborhood laundry, from pickup to doorstep.**

Laundry Map is a multi-persona laundry marketplace for a pilot in the Karu and Mararaba corridor of Nasarawa State, Nigeria. Customers choose local laundry services and arrange pickup and delivery. Vendors accept and process orders. Couriers handle both delivery legs with live order tracking.

This repository is an npm-workspaces monorepo. It includes a Next.js Progressive Web App, an Express and Socket.IO API, PostgreSQL with PostGIS, Redis, Docker Compose, and a GitHub Codespaces development container.

> **Deployment status:** This is a pilot application codebase, not a turnkey public-production deployment. The Compose `production` profile is for local or staging smoke tests and includes development database credentials and a development JWT fallback. Review [Production Readiness](#production-readiness) before deploying to real users.

## Contents

- [Capabilities](#capabilities)
- [System Architecture](#system-architecture)
- [Order Lifecycle](#order-lifecycle)
- [Technology and Repository Layout](#technology-and-repository-layout)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Personas and Workflows](#personas-and-workflows)
- [API Reference](#api-reference)
- [Real-Time Events](#real-time-events)
- [Data and Performance](#data-and-performance)
- [Security and Payments](#security-and-payments)
- [Testing and Quality](#testing-and-quality)
- [Partner Provisioning](#partner-provisioning)
- [Production Readiness](#production-readiness)
- [Current Boundaries](#current-boundaries)

## Capabilities

- Customer, vendor, and courier workspaces in one responsive PWA.
- Wash & Fold, Dry Cleaning, and Ironing services with vendor-specific catalog pricing.
- Nearby vendor search using PostGIS geography and Karu/Mararaba pilot seed data.
- Transactional order creation, status history, server-calculated commission, and row-locked state transitions.
- Paystack checkout initialization with signature-verified payment webhooks; Flutterwave signature verification for payment confirmation.
- Two-minute vendor acceptance window, first-come courier assignment, dual-leg routing, and customer delivery-code verification.
- JWT-authenticated Socket.IO events with Redis adapter support for multi-instance fan-out.
- Opt-in courier location sharing, network-only API requests, and an offline-resilient PWA shell.
- Partner account provisioning through an operations CLI; public registration is customer-only.

## System Architecture

```mermaid
flowchart LR
  subgraph Clients[Client applications]
    Customer[Customer PWA]
    Vendor[Vendor workspace]
    Courier[Courier workspace]
  end

  subgraph Application[Application services]
    Web[Next.js App Router]
    API[Express REST API]
    Realtime[Socket.IO]
  end

  subgraph Data[Data services]
    DB[(PostgreSQL + PostGIS)]
    Cache[(Redis)]
  end

  Paystack[Paystack]
  Flutterwave[Flutterwave]

  Customer --> Web
  Vendor --> Web
  Courier --> Web
  Web -->|HTTPS JSON and JWT| API
  Web <-->|JWT-authenticated events| Realtime
  Realtime --- API
  API -->|Transactions and geospatial queries| DB
  API <-->|Socket.IO adapter and pub/sub| Cache
  Paystack -->|Signed webhook| API
  Flutterwave -->|Verified webhook| API
```

The API owns validation, pricing, authorization, order transitions, and payment confirmation. PostgreSQL is the source of truth. Redis distributes Socket.IO events between API instances; it is not the order database. The browser never determines an order's final price or payment state.

### Request and Event Flow

1. A customer selects a vendor and services in the PWA.
2. The API validates the request, reads prices from that vendor's catalog, and creates the order and item rows in one database transaction.
3. The customer is redirected to Paystack checkout. A browser redirect alone does not mark the order paid.
4. The provider webhook is signature-checked; the reference, amount, and NGN currency are verified before payment and order state are updated transactionally.
5. The vendor receives a real-time paid-order event and has two minutes to accept.
6. A courier claims an eligible dispatch. The same courier handles pickup and return; authenticated status and location events are sent to authorized order subscribers.
7. The courier completes delivery only after validating the customer's six-digit code.

## Order Lifecycle

```mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> DRIVER_ASSIGNED_FOR_PICKUP: paid, vendor accepted, courier claims
  DRIVER_ASSIGNED_FOR_PICKUP --> PICKED_UP: courier confirms pickup
  PICKED_UP --> AT_LAUNDROMAT: courier confirms handoff
  AT_LAUNDROMAT --> PROCESSING: vendor starts care
  PROCESSING --> READY_FOR_DELIVERY: vendor marks ready
  READY_FOR_DELIVERY --> DRIVER_ASSIGNED_FOR_DROPOFF: assigned courier starts return
  DRIVER_ASSIGNED_FOR_DROPOFF --> DELIVERED: valid customer OTP
  CREATED --> CANCELLED
  DRIVER_ASSIGNED_FOR_PICKUP --> CANCELLED
  PICKED_UP --> CANCELLED
  AT_LAUNDROMAT --> CANCELLED
  PROCESSING --> CANCELLED
  READY_FOR_DELIVERY --> CANCELLED
  DRIVER_ASSIGNED_FOR_DROPOFF --> CANCELLED
  DELIVERED --> [*]
  CANCELLED --> [*]
```

State transitions are checked in application code and performed under `SELECT ... FOR UPDATE`, preventing concurrent requests from advancing the same order twice. Paid-order cancellation is rejected until an operations-managed refund is available. The acceptance deadline starts when payment is confirmed, not when an unpaid order is first created.

## Technology and Repository Layout

| Area | Implementation |
| --- | --- |
| Web | Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, Lucide icons |
| API | Node.js 22, Express 4, TypeScript, Zod |
| Real time | Socket.IO with Redis adapter |
| Persistence | PostgreSQL 16, PostGIS, parameterized SQL, `pg` connection pool |
| Authentication | bcrypt password hashing and signed JWTs |
| Local infrastructure | Docker Compose, PostGIS and Redis health checks |
| Development environment | GitHub Codespaces dev container with Docker-in-Docker feature |

```text
.
├── .devcontainer/
│   └── devcontainer.json
├── backend/
│   ├── db/                 # Initial schema and pilot seed data
│   └── src/                # Auth, API, orders, lifecycle, provisioning CLI
├── frontend/
│   ├── app/                # Customer, vendor, courier PWA
│   └── public/             # Manifest, icons, service worker
├── docker-compose.yml      # Development and production profiles
├── package.json            # npm workspace scripts
└── README.md
```

## Quick Start

### GitHub Codespaces

Open the repository in a Codespace and reopen it in the configured dev container. It starts PostgreSQL/PostGIS, Redis, and the development app service. The app container installs dependencies and runs both workspaces.

For local Docker Compose development:

```sh
cp .env.example .env
docker compose --profile development up --build
```

Open the forwarded **3000** port for the PWA. The API listens on **4000**. PostgreSQL and Redis are available on **5432** and **6379** for local tools. Compose waits for both data services' health checks before starting the application.

### Host-Based Development

Requirements: Node.js 22 (the workspace supports Node.js 20.11 or later) and Docker Compose v2.

```sh
docker compose up -d postgres redis
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
npm ci
npm run dev
```

The backend loads `backend/.env`; Next.js loads `frontend/.env.local`. To stop the data services, run `docker compose down`. The named database volume persists across restarts. Initialization scripts run only when PostgreSQL creates a new, empty data directory.

> `docker compose down -v` deletes the persistent database and Redis volumes. Use it only when you intentionally want to erase local data and reload the seed.

### Workspace Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and web development servers concurrently |
| `npm run typecheck` | Typecheck both workspaces |
| `npm test` | Run backend order-state-machine tests |
| `npm run build` | Build backend and Next.js frontend |
| `npm run provision:partner -w @laundry-map/backend` | Create a vendor or courier account |

## Configuration

Compose reads the root `.env`. For direct host development, use the backend and frontend env examples in their respective workspaces.

| Variable | Used by | Description |
| --- | --- | --- |
| `JWT_SECRET` | API, Compose | Signing and OTP-encryption key; use a random secret of at least 32 characters. The Compose fallback is development-only. |
| `JWT_EXPIRES_IN` | API | JWT lifetime; defaults to `12h`. |
| `WEB_ORIGIN` | API | Allowed browser origins; comma-separated values are supported. |
| `DATABASE_URL` | API | PostgreSQL connection string. Host default: `postgres://laundry:laundry@localhost:5432/laundry_map`. |
| `DATABASE_SSL` | API | Set to `true` when the PostgreSQL provider requires TLS. |
| `REDIS_URL` | API | Redis connection string. Host default: `redis://localhost:6379`. |
| `NEXT_PUBLIC_API_URL` | Web | Public API origin; defaults to `http://localhost:4000`. |
| `PAYSTACK_SECRET_KEY` | API | Paystack secret used for checkout initialization and webhook signature verification. |
| `FLUTTERWAVE_SECRET_HASH` | API | Expected Flutterwave webhook `verif-hash` value. |

Do not commit `.env` files, production keys, credentials, or customer data. The committed examples contain only local development values or empty provider secrets.

## Personas and Workflows

### Customer

- Browse nearby laundromats and current service pricing.
- Select Wash & Fold, Dry Cleaning, or Ironing.
- Enter pickup and delivery addresses; location coordinates are requested only after tapping **Use my location**.
- Pay through Paystack and follow payment state, order history, courier location, and the delivery code.

### Vendor

- Sign in with an operations-provisioned vendor account.
- Receive a paid order with a server-issued two-minute acceptance deadline and an audio alert.
- Accept the order, move it through processing, and mark it ready for delivery.

### Courier

- Sign in with an operations-provisioned courier account.
- Claim a paid, vendor-accepted dispatch; assignments are atomic and first-come.
- Navigate the customer-to-laundromat pickup leg and the laundromat-to-customer return leg.
- Optionally share live location; confirm final delivery with the customer's six-digit code.

## API Reference

All routes are served from the API origin. Routes marked **JWT** require `Authorization: Bearer <token>`.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /health/live` | Public | Process liveness |
| `GET /health/ready` | Public | PostgreSQL and Redis readiness |
| `POST /api/auth/register` | Public | Register a customer |
| `POST /api/auth/login` | Public | Authenticate a customer, vendor, or courier |
| `GET /api/vendors?latitude=...&longitude=...` | Public | Find nearby active vendors and services |
| `POST /api/orders` | Customer JWT | Create order with server-side catalog pricing |
| `GET /api/orders` | Customer JWT | List customer's orders and timeline |
| `GET /api/orders/:id` | Participant JWT | Read an order visible to the caller |
| `PATCH /api/orders/:id/status` | Participant JWT | Request a role-authorized lifecycle transition |
| `POST /api/payments/initialize` | Customer JWT | Initialize Paystack checkout |
| `POST /api/payments/paystack/webhook` | Paystack signature | Verify and confirm a Paystack payment |
| `POST /api/payments/flutterwave/webhook` | Flutterwave hash | Verify and confirm a Flutterwave payment |
| `GET /api/vendor/orders` | Vendor JWT | List paid vendor orders |
| `POST /api/vendor/orders/:id/accept` | Vendor JWT | Accept within the response window |
| `GET /api/courier/jobs` | Courier JWT | List eligible and assigned jobs |
| `POST /api/courier/jobs/:id/accept` | Courier JWT | Claim an available dispatch |
| `POST /api/courier/jobs/:id/complete` | Assigned courier JWT | Verify OTP and complete delivery |

Order creation accepts `vendorId`, pickup/delivery addresses and coordinates, and `items` containing a `service` and integer `quantity`. Any client-supplied price is not used. Values are validated at the API boundary.

## Real-Time Events

Socket.IO connects to the API origin with the JWT in the handshake auth payload:

```ts
io(API_URL, { auth: { token } });
```

| Direction | Event | Payload / behavior |
| --- | --- | --- |
| Client to server | `order:subscribe` | Order ID; joins only if the caller is an authorized participant |
| Client to server | `driver:location` | `{ orderId, latitude, longitude }`; courier-only, validated and persisted as the latest point |
| Client to server | `health:ping` | Acknowledges an authenticated WebSocket round trip with a server timestamp |
| Server to client | `order:created` | Newly paid order available to its customer or vendor |
| Server to client | `order:status` | Status or payment-state update for authorized order participants |
| Server to client | `vendor:accepted` | Vendor acceptance event for the order room |
| Server to client | `dispatch:available` | Signals courier clients to refresh eligible jobs |
| Server to client | `driver:location` | Latest courier coordinates for subscribed order clients |

The Redis adapter allows Socket.IO events to cross API instances. If long-polling is enabled behind a multi-instance load balancer, configure sticky sessions; alternatively, use a WebSocket-only transport where supported.

## Data and Performance

```mermaid
erDiagram
  USERS ||--o{ ORDERS : places
  USERS ||--o{ ORDERS : fulfills
  USERS ||--o| VENDORS : operates
  VENDORS ||--o{ ORDERS : receives
  VENDORS ||--o{ VENDOR_SERVICE_PRICES : offers
  ORDERS ||--|{ ORDER_ITEMS : contains
  ORDERS ||--o{ ORDER_STATUS_HISTORY : records
  ORDERS ||--o{ PAYMENTS : has
  ORDERS ||--o{ COURIER_LOCATIONS : tracks
```

- Monetary values are stored as integer kobo; API catalog prices are loaded from `vendor_service_prices` and totals are calculated server-side.
- Vendor locations and order addresses use PostGIS `GEOGRAPHY(POINT, 4326)`. A GIST index supports nearby vendor lookup.
- Orders, order items, history, payment confirmation, and courier assignment use PostgreSQL transactions where consistency matters.
- Common customer, vendor, courier, payment, and history access paths have dedicated indexes. Vendor search returns at most 30 results; order queues are capped at 100.
- The PostgreSQL pool is capped at 20 connections per API instance. Account for the aggregate pool size when scaling instances against a managed database's connection limit.
- Courier location sharing upserts one latest point per courier/order pair and removes it when delivery completes; the application does not retain a growing breadcrumb trail.
- Redis is used for Socket.IO fan-out. PostgreSQL remains authoritative for orders, payments, vendor catalog, and order history.

These are implementation choices, not benchmark claims. Measure query plans, pool saturation, event latency, and API response times with pilot traffic before setting performance targets.

## Security and Payments

- Passwords are hashed with bcrypt; request bodies and coordinates are validated with Zod.
- JWT authentication and role checks protect REST routes and Socket.IO subscriptions. Order-room membership is checked against the database.
- Helmet, CORS allowlisting, and API rate limiting are enabled.
- Paystack signatures use HMAC-SHA512 and constant-time comparison. Flutterwave's configured `verif-hash` is also checked with constant-time comparison.
- Confirmations require a matching initialized provider reference, exact amount, and NGN currency. The payment row and order's paid state are updated in one transaction.
- Delivery codes are generated with a cryptographically secure random source. The database stores a bcrypt verification hash and a separately AES-GCM-encrypted copy so the customer can retrieve the code after signing in. The encryption key is derived from `JWT_SECRET`; protect and rotate that key accordingly.
- API requests are not cached by the service worker. Courier coordinates require an explicit user action in the PWA and are available only to authorized order participants.

Never treat the frontend redirect, a client event, or a provider response shown in the browser as proof of payment. Configure provider webhooks to reach the deployed API over HTTPS.

## Testing and Quality

```sh
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run build
```

## System Test Scores & Quality Metrics

**Verification timestamp:** `2026-11-01T13:56:43Z` · **Runtime:** Node.js 22 · **Environment:** local single-process test container. There were no earlier score reports in the repository; this section records the first full backend/PWA/API/WebSocket test run.

| Area | Metric | Result | Verification |
| --- | --- | --- | --- |
| Complete suite | Tests passed | **10 / 10 (100%)** | Passing ✅ |
| Backend unit | Order lifecycle tests | **2 / 2** | Passing ✅ |
| Backend API/WebSocket | HTTP and authenticated Socket.IO integration tests | **4 / 4** | Passing ✅; HTTP health, input validation, and WebSocket ping. These tests do not require a database. |
| Frontend/PWA | Component and service-worker tests | **4 / 4** | Passing ✅; server-rendered customer home plus install, activate, offline fallback, and API-cache bypass. |
| Instrumented coverage | Lines / branches / functions | **51.82% / 72.22% / 48.77%** | Measured with Node's test coverage. Includes the source modules loaded by this suite and test files; it is not full repository coverage. |
| API latency | `GET /health/live`, 10 sequential local requests | **p50 7.53 ms / p95 42.52 ms** | Measured in the final `npm test` run; local only, not a production benchmark. |
| WebSocket latency | Authenticated Socket.IO ping/ack RTT | **1.43 ms** | Measured in the final `npm test` run over a local WebSocket connection. |
| PWA HTTP latency | 10 requests per route: `/`, `/manifest.json`, `/sw.js` | **p50 3.48 ms / 1.32 ms / 1.28 ms** | All returned HTTP 200; final-build localhost measurements. |
| Lighthouse performance (simulated) | Performance score | **Not measured** | No browser or Lighthouse runner was available. HTTP timing is not a Lighthouse score. |
| PostgreSQL/PostGIS/Redis | Database-backed integration | **Not run** | Docker and database services were unavailable; payment persistence and live Redis adapter behavior remain unverified. |
| Type safety | `npm run typecheck` | **Pass** | Backend and frontend checks completed without errors. |
| Production build | `npm run build` | **Pass** | Backend compiled; Next.js production build completed and statically generated `/` (22.6 kB route, 124 kB first-load JS). |
| Dependency audit | `npm audit --omit=dev` | **3 advisories** | 1 moderate (Next.js), 2 high (PostCSS and Zod); review and upgrade deliberately. |

Run the score-producing checks with `npm test` and `npm run test:coverage`. The test framework is Node's built-in `node:test` with `tsx`; Jest and PyTest are not configured in this repository. API tests cover HTTP contracts and an authenticated WebSocket acknowledgement, but they do not replace database/payment-provider end-to-end tests. Do not treat the localhost latency measurements as service-level objectives.

## Partner Provisioning

Public sign-up creates customer accounts only. Vendor and courier users are created by operations with the backend CLI. Run it from a securely configured shell after the database is available:

```sh
npm run provision:partner -w @laundry-map/backend
```

Required environment variables:

| Variable | Requirement |
| --- | --- |
| `PARTNER_ROLE` | `VENDOR` or `COURIER` |
| `FULL_NAME` | 2-120 characters |
| `EMAIL` | Valid email; normalized to lowercase |
| `PHONE` | Nigerian international format: `+234` plus 10 digits |
| `PASSWORD` | 12-72 characters; provide through a secret manager or secure prompt |

For `VENDOR`, also provide `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `LATITUDE`, and `LONGITUDE`. Service prices default to the pilot catalog in naira and can be overridden with `WASH_AND_FOLD_PRICE_NAIRA`, `DRY_CLEANING_PRICE_NAIRA`, and `IRONING_PRICE_NAIRA`. The command hashes passwords and creates the user, vendor, and catalog rows transactionally.

The seeded `.example` vendor accounts populate the local directory only; they are not operational login accounts. Do not put partner passwords in committed files or shell history.

## Production Readiness

Before a public launch:

- Replace all Compose defaults with secret-managed credentials; use a strong unique `JWT_SECRET` of at least 32 characters.
- Use managed PostgreSQL with PostGIS and Redis, private networking, TLS, backups, restore drills, and monitored resource limits.
- Set `DATABASE_SSL=true` when required by the database provider and configure the public HTTPS origin in `WEB_ORIGIN` and `NEXT_PUBLIC_API_URL`.
- Configure Paystack and/or Flutterwave webhook secrets and verify provider-side webhook delivery and retry behavior in a staging environment.
- Add a production migration runner and migration history. The current SQL files are PostgreSQL image initialization scripts and execute only for a newly initialized data volume.
- Add structured logs, metrics, tracing, alerting, an incident process, and tested backup/restore procedures.
- Review privacy, data retention, customer support, refunds, payment reconciliation, vendor onboarding, and Nigerian legal/regulatory requirements for the operating model.
- Configure reverse-proxy WebSocket support and sticky sessions if Socket.IO polling is enabled across multiple API instances.
- Complete security review and load testing; the project does not publish an SLA or performance benchmark.

The Compose `production` profile builds production-mode containers for local/staging verification, but it still uses the local database credentials and development JWT fallback unless overridden. Do not expose it publicly as-is.

## Current Boundaries

- Paystack checkout initialization is implemented. Flutterwave webhook verification is implemented, but Flutterwave checkout initialization is not.
- Refund execution and reconciliation workflows are not implemented. A customer cannot cancel a paid order through the lifecycle endpoint.
- There is no public vendor/courier registration, admin dashboard, automatic courier dispatch algorithm, geocoding provider, or address autocomplete.
- Database schema/seed scripts are bootstrapped by the PostGIS container on an empty data volume; they are not a general-purpose migration system.
- The application has unit coverage for the order state machine, but no database, payment-provider, Socket.IO, or browser end-to-end test suite yet.

See [LICENSE](LICENSE) for license terms.