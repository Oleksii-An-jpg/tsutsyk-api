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
| `placeOrder` | Buy, signed in or as a guest |
| `getMyOrders` / `getOrder` | Their orders, with the full timeline |
| `getOrderTracking(id, phone)` | Follow an order without an account |
| `claimOrder` | Attach a guest order to an account after signing in |
| `retryOrderPayment` | A fresh invoice after one expired or failed |
| `refreshOrderPayment` | Ask monobank what really happened |
| `updateOrderDelivery` | Correct the address, until it ships |
| `updateOrderContact` | Correct the phone or email |
| `cancelOrder` | Call it off — refunded through monobank if it was paid |
| `orderUpdates(orderId)` | Live status over the websocket |

Guest checkout is deliberate: asking somebody to register before they have
decided to buy loses the sale. A guest order carries the phone number from the
contact or delivery details, and `claimOrder` matches on it — compared on the
last nine digits, so `+380671234567` and `0671234567` are the same customer.
An order placed with no contact details at all is claimable by whoever holds
the order number, which travels only through monobank's redirect.

Mutations other than `placeOrder` need a Firebase ID token and the caller must
own the order. `getOrderTracking` and `orderUpdates` are the two deliberate
exceptions, and both answer with the thin tracking view — status, payment
status, tracking number — never with a customer's contact details.

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
