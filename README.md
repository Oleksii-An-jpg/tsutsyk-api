<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

```bash
$ npm run generate:typings
```

```bash
$ cloud-sql-proxy tsutsyk-live:europe-west4:tsutsyk


## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

```bash
$ gcloud app deploy --project=tsutsyk-live
```

## Orders

The API owns the whole life of an order: pricing it, opening the monobank
invoice, hearing back from the bank, and everything a customer does with it
afterwards. The storefront sends a product id and a quantity; it never sends an
amount, and it never talks to monobank itself.

### Flow

1. `placeOrder` prices the basket from the server-side catalogue
   (`src/orders/catalogue.ts`), writes the order, then opens a monobank
   invoice for it. The order is written *first*: a monobank call that succeeds
   but whose answer we never see still has somewhere to land.
2. The order number is the invoice's `reference`, so every callback carries it
   home. It is eight characters from an alphabet with no `0`, `O`, `1` or `I`,
   because customers read it aloud.
3. The buyer pays on monobank's hosted page and comes back to
   `redirectUrl?order=<id>`.
4. monobank POSTs each status change to `/payments/monobank/webhook`, which
   verifies the `X-Sign` signature over the raw body before believing a word of
   it. That callback is the only trustworthy signal that a payment happened —
   the buyer coming back to `redirectUrl` means only that they came back.

### What a customer can do

| Operation | What it is for |
| --- | --- |
| `getProducts` | The catalogue, priced by the same code that charges for it |
| `placeOrder` | Buy — requires an account and an address |
| `getMyOrders` / `getOrder` | Their orders, with the full timeline |
| `getOrderTracking(id, phone)` | Follow an order without getting into the account |
| `retryOrderPayment` | A fresh invoice after one expired or failed |
| `refreshOrderPayment` | Ask monobank what really happened |
| `updateOrderDelivery` | Correct the address, until it ships |
| `updateOrderContact` | Correct the phone or email |
| `cancelOrder` | Call it off — refunded through monobank if it was paid |
| `orderUpdates(orderId)` | Live status over the websocket |

### No guest checkout, and no order without an address

`placeOrder` requires a Firebase ID token and a `delivery` block. Both are
deliberate, and they are the same decision: an order we cannot deliver, or
whose customer we cannot reach, is not an order — it is money we have to give
back. Guest checkout could take that money and, since `updateOrderDelivery`
needs ownership, could never finish the order without the sign-in it was meant
to avoid.

The sign-in costs the buyer nothing they were not going to spend: a Tsutsyk is
unusable without an account — claiming the unit, seeing it on the map, the
alert radius — so this only moves a step they take anyway to where it also
solves the address.

The contact of record is the account's own verified phone and email, falling
back to the delivery phone: the address may be a relative's, but the person we
call about the order is the person who placed it.

Every mutation needs a token and ownership of the order. `getOrderTracking`
and `orderUpdates` are the two deliberate exceptions — for the customer locked
out of their account — and both answer with the thin tracking view: status,
payment status, tracking number, never contact details.

### Payment statuses

`PaymentStatus` mirrors monobank's invoice status; `OrderStatus` is ours.
`nextOrderStatus` is the only place the two meet, and it is conservative in
both directions: a `success` only pays an order still waiting for money, so a
late webhook cannot drag a shipped order backwards, and a `reversed` refunds
the order whatever it was doing.

Two things monobank's own docs force:

- **Ordering.** Delivery order is not guaranteed — a `success` can arrive
  before the `processing` that preceded it. The payload with the greater
  `modifiedDate` wins, so that field decides which status is current, not
  arrival order.
- **`expired` sends no webhook.** It is the one status that never calls back,
  so an abandoned invoice is only observable by polling
  `GET /api/merchant/invoice/status`. `refreshOrderPayment` is the customer's
  way to do that, and `reconcilePendingPayments` — half-hourly, 25 orders at a
  time, and only for orders older than the invoice window — is the safety net.
  Set `ORDERS_RECONCILE_CRON=false` to stand it down.

Redeliveries are idempotent: the same status writes nothing new, and
fulfilment is guarded on the order actually advancing, so a retry cannot fire
a confirmation twice.

### Cancelling

An unpaid order withdraws its invoice (`/invoice/remove`) so an abandoned
payment page cannot be paid after the fact. A paid one is refunded in full
(`/invoice/cancel`). monobank answering `processing` rather than `success` is
not a loss: the order is cancelled and the `reversed` webhook finishes the job.

### Configuration

See `.env.example`. The two that matter: `MONOBANK_ACQUIRING_TOKEN`, and
`API_PUBLIC_URL` so the invoice carries a callback URL monobank can reach.
A **test** token from api.monobank.ua gives a full sandbox — no terminal, no
approval, and a payment page that accepts any Luhn-valid card number.

Without a token the API still runs; the order mutations answer 503 and the
reconcile job stands down.

### Testing locally

monobank cannot POST to `localhost`, so expose the API first:

```bash
ssh -R 80:localhost:3000 nokey@localhost.run    # prints an https URL
```

then start it with `API_PUBLIC_URL=https://<tunnel-host>` so invoices carry a
callback URL that reaches your machine.

The unit tests cover the parts worth trusting — pricing, ownership, the
out-of-order webhook rules, refunds — against an in-memory Firestore, so
`npm test` needs neither credentials nor the emulator.

## Air raid alerts

While a tracker's oblast is under an air raid alert, that tracker is asked to
report its position every minute instead of every five. This is the feature the
landing page calls *Розуміє тривогу*.

### How a tracker is told anything

There is exactly one channel from us to a device, and it is the response to the
device's own fix:

```
POST /tracker/:tsutsykId/location
Content-Type: application/json

{ "sessionId": "walk-1", "lat": 50.4501, "lng": 30.5234, "battery": 82 }
```

```json
{
  "locationId": "H7xk...",
  "reporting": { "intervalSeconds": 60, "reason": "air_raid" },
  "airRaid": "active"
}
```

**The firmware must treat `reporting.intervalSeconds` as the delay before its
next fix.** Nothing else in this repository can change a device's behaviour, so
a unit that ignores this field simply does not have the feature.

The downlink rides on the uplink deliberately. A Cat-1 modem's power budget is
dominated by radio time, so an answer to a request the tracker was already
making is free, while polling a config endpoint or holding MQTT open is not.
The cost of that choice is latency: an alert raised at T reaches a device at
its next check-in, so worst case a tracker keeps the slow cadence for one
normal interval after the sirens start. Cutting that would mean paying for a
connection the device holds open, which is the wrong trade for a collar.

`reason` is advisory — useful for a log or an LED — and is one of `normal`,
`air_raid` or `low_battery`. `airRaid` carries the raw status:
`active`, `partly`, `no_alert` or `unknown`.

Errors follow the same rule as monobank's webhook: `503` means retry this fix,
`4xx` means the device sent something wrong and retrying will not help. While a
fix is failing the device keeps whatever cadence it already has.

### Where the alert state comes from

[alerts.in.ua](https://alerts.in.ua)'s IoT endpoint,
`GET /v1/iot/active_air_raid_alerts_by_oblast.json`, which answers with 27
characters — one per oblast, positional, `A`/`P`/`N`. One poller serves every
tracker; per-device polling would buy nothing and spend rate limit. Requests are
conditional (`If-Modified-Since`), so a quiet country costs a 304.

`src/alerts/oblasts.ts` holds the position-to-oblast table. **It is the schema**
— the payload has no keys — and it is transcribed from the official client
library, with `oblasts.spec.ts` pinning it.

### What happens when the feed fails

This is most of the design, because a tracker that is quietly not accelerating
looks exactly like one in a quiet oblast.

- A reading older than `ALERTS_STALE_AFTER_MS` (3 min) stops being reported as
  fact. The oblast reads `unknown`.
- `unknown` is **not** `no_alert`. It never renders as "quiet" and it never
  accelerates a tracker — an alerts.in.ua outage must not put every device in
  the country onto the fast cadence at once.
- Staleness is asymmetric. A *raised* alert holds for `ALERTS_HOLD_MS` (10 min)
  past the freshness window before decaying to `unknown`, so losing the feed
  mid-alert does not withdraw the feature during the emergency it exists for.
- A malformed payload is discarded and the last good reading is kept to age out
  normally. A short string would mark the tail of the alphabet quiet, which is
  the one failure this feature cannot have, so it is a hard parse error.
- A `429` backs off for ten poll periods.

### Which oblast a tracker follows

The owner picks it: `updateTsutsyk(id:, alertRegionUid:)`, chosen from
`getAlertRegions`. Until they do, `alertRegion` is null and the tracker keeps
its everyday cadence.

It is not derived from the tracker's own coordinates, which would be the
obvious thing. Doing that properly needs oblast boundary polygons and a
point-in-polygon test; the cheap approximations (nearest centroid, bounding
boxes) are wrong near every oblast border, and a tracker silently following the
wrong region's sirens is worse than one that asks. Auto-detection is worth
doing with real boundary data — it is not worth guessing.

### The battery floor

Below `LOW_BATTERY_PERCENT` (15%) a tracker is not accelerated, alert or not,
and reports `reason: "low_battery"`. An alert can run for hours, and a device
still reporting every five minutes is worth more than one that reported every
minute until it died. A device that sends no battery reading at all is still
accelerated: the alert is certain, the flat battery is only a possibility.

### Configuration

`ALERTS_IN_UA_TOKEN` turns the feature on; request one at
[devs.alerts.in.ua](https://devs.alerts.in.ua). Without it the API runs exactly
as before, every oblast reads `unknown`, and no tracker is ever accelerated —
the same posture the orders module takes without a monobank token. The rest are
tuning knobs, documented in `.env.example`.

### Known gaps

- **The firmware is not in this repository.** The server side is complete and
  tested; whether a given unit honours `reporting.intervalSeconds` is a
  question for the device build.
- **Ingest is authenticated only by the tracker id in the path**, which matches
  the pre-existing `postLocation` mutation. The ids are unguessable, but they
  are printed on the unit as a QR code, so anyone who photographs a collar can
  write points for that dog. A per-device secret issued at provisioning time
  (`scripts/generate-batch.ts`) is the fix; this endpoint does not make the
  situation worse, but it does not improve it either.

## Push notifications

The API owns push, because the API is what learns things. A raised air raid
alert and a flat battery both happen whether or not anyone has the app open,
and this is the process that hears about them.

### Where a subscription lives

`pushSubscriptions`, one document per browser, keyed by a SHA-256 of the push
endpoint. The hash is doing two jobs: a Firestore document id may not contain
the `/` an endpoint URL is full of, and hashing makes re-subscribing
idempotent — browsers re-subscribe on their own schedule, and a subscription
that landed on a fresh document each time would leave the old one behind for
us to keep pushing at forever.

| Operation | What it is for |
| --- | --- |
| `getPushConfig` | The VAPID public key a browser needs to subscribe |
| `savePushSubscription` | Remember this browser. Requires auth |
| `deletePushSubscription` | Forget it. Requires auth and ownership |

The uid comes from the verified token, never from the client, so a
subscription can only be filed under the person who made it. `delete` checks
ownership for the mirror-image reason: the endpoint arrives from the client,
and without the check anyone holding someone else's endpoint could silence
them.

**The public key is served, not configured twice.** The storefront reads it
from `getPushConfig` rather than holding its own copy. A public key that does
not match the private key signing the send fails at the push service, per
device, with nothing in our logs to say why — so there is one copy of it.

### What gets sent

- **An air raid alert raised or lifted** in the oblast a tracker follows. The
  device already learns this — it is why the cadence changes — but until now
  nothing told the person, which is the half that matters at 4am.
- **A low battery**, the first time a tracker crosses `LOW_BATTERY_PERCENT`.

Both are edge-triggered, and both have to be, for the same reason in two
shapes. A tracker reports every five minutes, so warning on the *level* would
be twelve notifications an hour for as long as the battery stayed flat;
`batteryEdge` warns on the way down and re-arms only above
`BATTERY_RECOVERED_PERCENT` (25%), because a reading wobbling either side of a
single threshold would otherwise ring all afternoon. Coming off the charger is
not itself worth a notification — good news at 3am is still 3am.

The alert edge is detected in `AlertsService` and announced through
`onTransition`; `AirRaidNotifier` is what listens, looks up who is following
that oblast, and sends. The poller keeps knowing nothing about Firestore or
push, and nothing waits on a push service to finish a poll or answer a device.

Two rules that are load-bearing:

- **A restart is not a siren.** The first reading a process takes seeds the
  baseline silently. Without that, every deploy during an alert would
  re-announce it to a whole oblast.
- **Losing the feed is not an all-clear.** Transitions are emitted only for a
  poll that came back with data. A reading that decays to `unknown` because
  alerts.in.ua is unreachable announces nothing — saying "відбій" when we do
  not know is the one mistake this feature cannot make.

Dead endpoints prune themselves: a push service answering 404 or 410 means
that browser is gone for good, and the subscription goes with it. Any other
failure is a bad minute, not a dead browser, and the subscription stays.

### Configuration

`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` turn the feature on — generate a
pair with `npx web-push generate-vapid-keys`. Without them subscriptions are
still stored and every send is a no-op, so the toggle keeps working and
nothing has to be re-subscribed once the keys arrive.

Rotating the keypair invalidates every subscription already made: each one is
bound to the public key it was created with. Owners would silently stop
receiving notifications until they toggled them off and on again, so the keys
are worth keeping somewhere durable.

### Known gaps

- **The geofence is still client-side.** `alertDistanceMeters` is evaluated in
  the browser, against the owner's own position, by a component that only
  exists while the map is on screen — so "Цуцик забіг задалеко" can only reach
  someone already looking at it. Moving it into `recordSingleLocation` needs an
  anchor point on the tracker (the owner's phone is not something the API can
  see), and that is a product decision — a yard the dog leaves, or a distance
  from a person — not just a port.
- **Nothing pushes about orders yet.** The monobank webhook is the obvious
  place to announce a payment confirming or an order shipping, and it already
  runs server-side; it is just not wired to this.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
