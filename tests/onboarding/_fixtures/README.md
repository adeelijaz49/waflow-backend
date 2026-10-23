# Onboarding test fixtures (no network, no DB)

```js
const { createFakeGraph, createFakeStripe, createFakeSend, fixedClock, fakeRandom,
        signedEvent, makeSubscription, makeInvoice, makeCheckoutSession } = require('../_fixtures');
```

## fakeGraph (Meta Graph, HTTP port)
```js
const g = createFakeGraph({ wabaId: 'W1', phoneId: 'P1', nameStatus: 'PENDING_REVIEW', tier: 'TIER_250' });
const meta = createMetaGraphClient({ http: g.http, appId: g.ids.appId, appSecret: g.ids.appSecret });
await meta.exchangeCode('CODE');            // any fresh non-empty code works once (options.code pins one)
g.scenarios.codeExpired();                  // next exchange -> 400 code 100
g.scenarios.token190();                     // every merchant-token call -> 190/463 (until g.reset())
g.scenarios.register133016();               // next register -> 400 133016
g.scenarios.rateLimited(4);                 // or 17; {match:'getWaba', times:2, status:429}
g.scenarios.networkDrop({ code: 'ETIMEDOUT' });   // rejects { code, message }
g.scenarios.permissionMissing(200);         // next merchant call
g.scenarios.finishOnlyWaba();               // no phone numbers; g.addPhone() restores one
g.scenarios.nameStatusMissing();            // name_status silently absent
g.scenarios.fieldRejected('name_status');   // 400 code 100 naming the field (field negotiation)
g.failNext('createTemplate', { code: 100, subcode: 2388024, message: 'dup' }, { times: 2 });
g.on({ name: 'getWaba' }, (call) => ({ status: 200, data: { id: call.id } }));
g.setTemplateStatus('welcome', 'ar', 'REJECTED', 'INVALID_FORMAT');  g.setVerification('pending');
g.setTier('TIER_2K');  g.setHealth('BLOCKED');  g.setPhone({ status: 'PENDING' });
g.calls[0]  // { name, method, path (no version), params, data, authorization (raw), token, tokenKind, status }
g.assertNeverUsedToken(g.ids.platformToken);  g.assertMerchantTokenOnly(g.ids.merchantToken);
g.assertNoLeak([code, pin, g.ids.merchantToken], logLines);   // only the secrets you pass; see below
g.assertNoForeignCalls();                   // paging.next must stay on graph.facebook.com
g.webhook.sign(rawBody) / g.webhook.envelope(field, value) / g.session('FINISH_ONLY_WABA')
```
Endpoint names for `failNext`/`on`/`callsTo`: exchange, debugToken, getPhone, listPhones, register, subscribe,
listSubscribed, unsubscribe, getWaba, getBusiness, setDisplayName, createTemplate, listTemplates, deleteTemplate,
sendMessage, requestCode, verifyCode, listClientWabas.
`assertNoLeak` ignores the protocol-mandated places only (code in the exchange, pin in register, token in
Authorization / access_token, input_token); anything else, or any `extra` log line, containing a secret fails.

## fakeStripe
```js
const s = createFakeStripe({ shape: 'current' /* or 'basil' */ });
const sess = await s.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: 'p', quantity: 1 }], success_url: 'https://x.test' });
const { subscription } = s.completeCheckout(sess.id, { businessName: 'Acme' });
const { payload, body, header } = s.signedEvent({ type: 'invoice.paid', object: makeInvoice({ subscription: subscription.id }) });
supertest(app).post('/stripe-billing-webhook').set('stripe-signature', header).set('content-type', 'application/json').send(body);
s.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' }, { times: 2 });
makeSubscription({ shape: 'basil', status: 'past_due' });   // period on items; invoice.parent.subscription_details
```
Use `TEST_WEBHOOK_SECRET` as the endpoint secret under test; `signedEvent({ ..., timestamp })` makes a stale delivery.

## fakeResend, clock, random
```js
const mail = createFakeSend({ failFirst: 1, failWith: { statusCode: 503 } });  // send() -> { id } | rejects
mail.sent[0].html;  mail.assertEscaped([userInput]);  mail.assertNoLeak([token]);  mail.findPhoneLike();
const clock = fixedClock('2026-10-15T09:00:00Z');  clock.now() /* Date */; clock.advance(60000); clock.ms();
const rnd = fakeRandom({ sequence: [482913] });  rnd.randomInt(100000, 1000000);  rnd.randomBytes(16);
```
All tokens, codes and secrets in these fixtures are dummy values. Run:
`MONGODB_URI=mongodb://127.0.0.1:1/waflow_unit_guard npx jest tests/onboarding/unit/fixtures --runInBand`
