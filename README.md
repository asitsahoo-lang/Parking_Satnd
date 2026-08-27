# Digital Parking Ticket System — Backend

Thin sync/auth layer for the offline-first Flutter parking app.
Node.js + Express + MongoDB Atlas. No separate website — the customer's QR
lands on a page served directly by this same server (`/t/:ticketId`).

## What this backend does (and doesn't do)

- Agents/owner log in with a **loginId + PIN** → get a JWT.
- Agents create tickets **offline on the phone first**; this backend is only
  contacted (a) when a ticket is created while online, or (b) via the
  **`/api/tickets/sync`** batch endpoint once the phone regains signal.
- Every ticket's QR is signed with **HMAC-SHA256** so it can't be forged.
- Closing a ticket **auto-calculates the fee** (hourly rate card, configurable).
- Closed tickets get a `deleteAfter` date; a **MongoDB TTL index** deletes them
  automatically once the retention window passes — no cron job required.
- Owner gets a `/api/dashboard` aggregate endpoint for the in-app fl_chart views.

## 1. Install

```bash
cd parking-backend
npm install
cp .env.example .env
```

Edit `.env`:
- `MONGO_URI` — your MongoDB Atlas free-tier connection string
- `JWT_SECRET` / `QR_HMAC_SECRET` — set to long random strings (different from each other)
- `RATE_PER_HOUR`, `MIN_CHARGE_HOURS`, `GRACE_MINUTES` — your rate card
- `RETENTION_HOURS` — how long closed tickets stay before auto-purge (default 48h)

## 2. Create the owner account

```bash
npm run seed:owner
```

Uses `SEED_OWNER_NAME` / `SEED_OWNER_PIN` from `.env`. Login afterwards with
`loginId: "owner"` and that PIN. **Change the PIN via your own flow after first login** —
there's no PIN-change endpoint yet; simplest is to re-run the seed script with
a new `SEED_OWNER_PIN`, or add one later (see "Not yet built" below).

## 3. Run

```bash
npm run dev      # nodemon, local development
npm start        # plain node, production
```

Health check: `GET /health`

## 4. Deploy (Render / Railway)

1. Push this folder to a Git repo.
2. Create a new Web Service on Render or Railway, point it at the repo.
3. Set the same environment variables from `.env` in the platform's dashboard
   (never commit `.env`).
4. Build command: `npm install` — Start command: `npm start`.
5. Set `MONGO_URI` to your Atlas cluster (whitelist `0.0.0.0/0` in Atlas
   Network Access, or the platform's static egress IPs if available).
6. Once deployed, run the owner seed once via the platform's shell/console,
   or temporarily add a one-off script/job — `npm run seed:owner`.

## API Reference

All authenticated routes need `Authorization: Bearer <token>`.

### Auth

| Method | Route | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/api/auth/login` | none | `{ loginId, pin }` | Returns `{ token, user }` |
| GET | `/api/auth/me` | any | — | Current user info |
| POST | `/api/auth/agents` | owner/manager | `{ name, loginId, pin, role? }` | Create agent account |
| GET | `/api/auth/agents` | owner/manager | — | List all staff |
| PATCH | `/api/auth/agents/:id/deactivate` | owner | — | Disable a login |

### Tickets

| Method | Route | Auth | Notes |
|---|---|---|---|
| POST | `/api/tickets` | agent+ | Create ticket while online |
| POST | `/api/tickets/sync` | agent+ | **Batch upsert** — flush the offline queue (array of tickets) |
| GET | `/api/tickets?status=OPEN&page=1&limit=50` | agent+ | List/filter |
| GET | `/api/tickets/:id` | agent+ | Fetch one (pickup scan) |
| PATCH | `/api/tickets/:id/payment` | agent+ | `{ paymentStatus, paymentMethod }` |
| PATCH | `/api/tickets/:id/close` | agent+ | `{ paymentMethod?, markUnpaid?, exitTime? }` — auto fee calc |
| PATCH | `/api/tickets/:id/reopen` | owner/manager | `{ reason? }` |

**Create ticket body:**
```json
{
  "ticketId": "uuid-generated-on-device",
  "plateNumber": "OD02AB1234",
  "ocrRawText": "OD02AB1234",
  "ocrConfidence": 0.94,
  "photoBase64": "...",
  "entryTime": "2026-08-26T10:15:00Z",
  "paymentStatus": "PENDING",
  "paymentMethod": "NONE",
  "deviceId": "agent-phone-01"
}
```

**Sync body (array — this is what the phone sends once it's back online):**
```json
{
  "tickets": [
    { "ticketId": "...", "plateNumber": "...", "photoBase64": "...", "entryTime": "...", "status": "OPEN", ... },
    { "ticketId": "...", "status": "CLOSED", "exitTime": "...", "exitAgentId": "agt01", ... }
  ]
}
```

### Dashboard (owner/manager only)

| Method | Route | Notes |
|---|---|---|
| GET | `/api/dashboard?from=&to=` | Totals, revenue, per-agent breakdown |
| GET | `/api/dashboard/audit/:ticketId` | Full status-change history for one ticket |

### Public (no auth)

| Method | Route | Notes |
|---|---|---|
| GET | `/api/public/verify/:ticketId?sig=...` | JSON signature check |
| GET | `/t/:ticketId?sig=...` | **Customer-facing HTML page** — what the QR code points to |

## QR code contents

Encode this JSON (or a compact string) in the QR via `qr_flutter`:
```json
{ "ticketId": "uuid...", "sig": "hmac-hex..." }
```
The customer's camera should point at:
```
https://your-backend-url.com/t/<ticketId>?sig=<sig>
```
so a plain QR scan opens the ticket page with zero app install.

## Fraud / reuse prevention

- QR signature is HMAC-SHA256, verified server-side — can't be guessed or edited.
- `status` field blocks re-closing: closing an already-`CLOSED` ticket returns
  `409` with who closed it and when.
- Only `owner`/`manager` roles can reopen a closed ticket (`PATCH .../reopen`),
  and it's logged in the audit trail.

## Offline-first sync design

- Every ticket's real primary key is `ticketId`, a **UUID generated on the
  device** at creation time — not the MongoDB `_id`. This means agents never
  collide creating tickets independently offline.
- `POST /api/tickets/sync` is a **batch upsert**: new `ticketId`s are inserted,
  existing ones are merged (open→closed transitions and payment updates are
  applied; already-closed tickets are never silently reopened by a sync).
- Phone-to-phone sync (Bluetooth/Nearby Connections) happens entirely on-device
  in Flutter — this backend only sees the *result* once any one phone reaches
  the internet and calls `/sync`.

## Auto-purge (TTL)

`Ticket.deleteAfter` is set only when a ticket is closed
(`now + RETENTION_HOURS`). A MongoDB TTL index
(`{ deleteAfter: 1 }, { expireAfterSeconds: 0 }`) sweeps and deletes those
documents automatically — no scheduled job needed. **Note:** MongoDB's TTL
monitor runs about once a minute, so deletion isn't instant to the second.

⚠️ If you want historical revenue reports to survive past the retention
window, snapshot dashboard aggregates elsewhere (e.g. a daily rollup
collection) before purge — the raw ticket disappears permanently once TTL
fires.

## Real-time UPI payment (Razorpay)

At exit, instead of the agent self-reporting "cash collected", they can
generate a live Razorpay UPI QR for the auto-calculated fee. The customer
scans it with **any** UPI app (Google Pay, PhonePe, etc — not just
Razorpay's). The moment Razorpay confirms the payment, it calls our
webhook, which closes the ticket automatically — no agent tap required.

### Endpoints

| Method | Route | Notes |
|---|---|---|
| POST | `/api/tickets/:id/upi/create` | Generates a single-use dynamic QR for the current fee. Returns `{ qrImageUrl, qrId, amount, expiresAt }` |
| GET | `/api/tickets/:id/upi/status` | Poll this every ~2s while the QR is on screen. Returns `{ upiStatus, ticketStatus, paymentStatus }` — once `ticketStatus` flips to `"CLOSED"`, payment is confirmed |
| PATCH | `/api/tickets/:id/upi/cancel` | Agent backs out (customer wants cash instead) — releases the lock so manual close works again |
| POST | `/api/webhooks/razorpay` | Razorpay calls this directly — not for your app to call |

### Setup

1. In your Razorpay Dashboard, go to **Settings → API Keys** and copy your
   Key ID / Key Secret into `.env` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
   Use **test mode** keys (`rzp_test_...`) while developing.
2. Go to **Settings → Webhooks → Add New Webhook**.
   - **Webhook URL**: `https://<your-backend-url>/api/webhooks/razorpay`
   - **Active events**: check `qr_code.credited` (that's the only one this
     backend acts on — everything else is acknowledged and ignored)
   - Razorpay generates a **webhook secret** when you save this — copy it
     into `.env` as `RAZORPAY_WEBHOOK_SECRET`.
3. **Local development**: Razorpay needs a public HTTPS URL to call your
   webhook, so `localhost` won't work directly. Use a tunnel:
   ```bash
   ngrok http 5000
   ```
   Then use the `https://xxxx.ngrok-free.app/api/webhooks/razorpay` URL in
   the Dashboard while testing. Once deployed to Render/Railway, switch the
   webhook URL to your real domain.
4. Test with Razorpay's **test UPI apps** (available in test mode) or a
   real small-amount payment once you're on live keys.

### Why a webhook instead of just polling Razorpay directly

Polling Razorpay's API from the backend would work too, but the webhook is
push-based — payment confirmation reaches us in roughly 1-3 seconds instead
of however long a poll interval is, and it doesn't require us to babysit an
in-memory timer per open QR. The Flutter app still polls, but it's polling
*our own* `/upi/status` endpoint (cheap, no external call) — the webhook is
what actually updates the ticket the instant money moves.

### Idempotency & safety notes

- `handleRazorpayWebhook` checks `ticket.status === "CLOSED"` before acting,
  so a retried webhook delivery (Razorpay does retry on non-2xx responses)
  never double-closes or double-logs a ticket.
- The webhook signature is verified via HMAC-SHA256 against the raw request
  body — a request without a valid `x-razorpay-signature` header is
  rejected with 400 before any ticket is touched.
- While a UPI QR is `CREATED` (active) for a ticket, manual close via
  `PATCH /:id/close` is blocked with a 409 — this prevents an agent from
  marking cash-paid while a UPI payment might complete seconds later,
  which would otherwise risk double-crediting or a confusing audit trail.
  Cancel the QR first if the customer changes their mind about payment method.

## Not yet built (flag if you want these next)

- PIN change / forgot-PIN flow
- Push notifications (e.g. "ticket synced", "payment pending reminder")
- Rate-card slabs (currently flat hourly, see `src/utils/fee.js`)
- Photo storage offload to S3/Cloudinary (currently base64 in MongoDB —
  fine for a free-tier prototype, but will eat your Atlas storage quota
  faster; ok for the "no separate backend" constraint you set)

## Project structure

```
parking-backend/
├── server.js                  # entry point
├── src/
│   ├── app.js                 # Express app assembly
│   ├── config/db.js           # Mongo connection
│   ├── models/
│   │   ├── User.js
│   │   └── Ticket.js
│   ├── middleware/auth.js     # JWT guard + role guard
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── ticketController.js
│   │   ├── dashboardController.js
│   │   └── publicController.js
│   ├── routes/
│   │   ├── authRoutes.js
│   │   ├── ticketRoutes.js
│   │   ├── dashboardRoutes.js
│   │   └── publicRoutes.js
│   └── utils/
│       ├── hmac.js            # QR signing/verification
│       ├── fee.js             # auto fee calculation
│       └── seedOwner.js       # creates the owner account
├── .env.example
└── package.json
```
