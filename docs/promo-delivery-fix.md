# Promotion delivery fix (WhatsApp 24-hour window)

## The problem it fixes

WhatsApp only delivers a free-form (interactive) message to a customer who has written to the business number in the last
24 hours. Meta does **not** refuse an out-of-window interactive message when it is posted: it answers HTTP 200 with a message id,
then about a second later reports `failed` / error `131047` ("Re-engagement message") through the status webhook. The old
`sendPromotion` only reacted to a thrown error, so it counted such a message as "sent", never reached its template fallback, and the
dashboard said "Sent N WhatsApp messages successfully!" for messages that could never arrive.

## What it does now

| Situation (cash promotion with something to show) | Message sent |
| --- | --- |
| Customer wrote to the business in the last 23 h | the same chat-style (interactive) message as before |
| Customer wrote longer ago, or never | the approved template `waflow_promo_v2` (works at any time) |
| Template refused (e.g. paused, not approved) for an outside-window customer | nothing more is sent; the row and `errors[]` carry Meta's reason and code (a chat-style message would only be accepted and refused again, hiding the reason) |
| Points promotion, custom entry-message promotion, demo customer, Arabic customer | unchanged |

* "Wrote to the business" = a stored inbound `WhatsAppMessage` (every inbound type: text, button taps, replies, media), matched on the
  phone number's digits (`+61 4..`, `0061 4..`, `61 4..` all match WhatsApp's digits-only `from`), scoped to the promotion's workspace.
  The last hour of the window counts as closed. A number stored in local form (`04..`) never matches and is treated as outside the
  window, which is the safe side because the template reaches the customer either way.
* If the lookup itself fails, every customer takes the previous path (nothing is blocked).
* `sendTestMessage` (the "Show Test Message" button) follows the same rule.
* A refused send now records and reports **Meta's own reason and code** (for example `(#133010) Account not registered`,
  code `133010`) on the `CampaignMessage` row and in `errors[]`, instead of `Request failed with status code 400`.
* `GET /api/promotions/:id/delivery[?sinceSeconds=N|since=ISO]` summarises the `CampaignMessage` rows (written at send time, updated by
  the status webhook): accepted, delivered, read, waiting, refused (immediately vs after acceptance), how many went as a template, and the
  reasons in plain language. The Promotions screen shows "WhatsApp accepted N", then "Result of this send" (delivered / waiting / refused,
  checked 3 s, 10 s and 25 s after a send), and lists the reasons under the Campaign Report when messages failed.

The response of `sendPromotion` itself is unchanged (`sentCount` still means "accepted by WhatsApp").

## Kill switch

`PROMO_DELIVERY_FIX=off` (also `0`, `false`, `no`) restores the previous behaviour exactly: no inbound lookup, chat-style message for
everyone, bare error text, no error code on the row. Default: on. The English-unchanged characterisation suites run with it off.

## Not covered (by design)

* Points promotions have no template, so they still only reach customers inside the window (a refusal now shows Meta's reason).
* Only the first item of the promotion appears in the template (it has one product slot); the chat-style message lists several.
* Other session-message senders (consent asks, utility notices, flow follow-ups) assume a closed window is a thrown error and were not changed.
* No automatic retry when a webhook reports `131047`; no new database index (the lookup uses the existing `workspaceId` index; add
  `{ workspaceId: 1, phone: 1, direction: 1, receivedAt: -1 }` on `whatsappmessages` if a workspace ever stores very many inbound messages).
* The inbound webhook attributes messages to the oldest workspace (single-workspace webhook), so a promotion of any other workspace
  sees no inbound history and always takes the template path.

## Files

`shared/promoWindow.js`, `shared/promoDelivery.js`, hunks in `shared/operations.js` (`sendPromotion`, `sendTestMessage`), the
`/:id/delivery` route in `routes/promotions.js`, a comment in `models/CampaignMessage.js`. Tests: `tests/promoWindow.test.js`,
`tests/promoDelivery.test.js`, `tests/localization/integration/promoWindowRouting.itest.js` (throwaway database only).
