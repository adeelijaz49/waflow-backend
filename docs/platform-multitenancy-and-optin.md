# One app for many customers, and opt-in buttons

Two changes that ship together:

1. **One deployment, many customers.** WaFlow staff (the *super admins*) create customers inside the app. Each customer has its own
   customers, products, services, promotions, flows, inbox, settings and (later) its own WhatsApp number. Today everything runs on the
   shared WaFlow number.
2. **Opt-in before any promotion.** A promotion can carry its own quick-reply buttons (Opt in / Opt out / Interested / None). A tap is
   recorded as consent, with evidence, in an append-only log. A promotion marked *Consent request* is the only kind that may be sent to
   people who have not answered yet.

Decisions behind it (owner, 2026-10-26): one app and one deployment; the pilot customer uses the shared number for now and its own
number is entered later, per customer, in the app; a customer must opt in before any promotion (merchants capture numbers at the till
without consent); a message that Meta has not approved is submitted automatically, the merchant is told, the send is blocked, and when
it is approved they are told they can send; English only for now.

> **Read section 7 (runbook) before pushing.** The change adds new files that the server requires. A file that is missing from the
> commit either stops the app from starting or - worse, because the app starts - breaks something only when it is first used (sign-in,
> a typed STOP). Section 7 has `node scripts/check-requires.js`, which finds every such file, the push order and the smoke test after
> the deploy.

---

## 1. Customers (tenants) and super admins

* A customer is a `Workspace`. Every business collection is filtered by `workspaceId`. The oldest workspace is the *platform default*
  (the live demo): it receives everything the system cannot attribute to a customer, exactly as before.
* **Super admins** are the people whose verified login contact (email or phone, as stored on their `User`) is listed in
  `SUPER_ADMIN_CONTACTS`. The setting is read when the app starts (Azure restarts it when you save the setting), so a contact that is
  removed loses the access at the first request after that restart; the `User` is also re-checked in the database on every
  `/api/platform` call and on every request made inside a customer. Empty list = nobody is a super admin.
  Write the contacts exactly as the person signs in: an email (capitals do not matter) or a phone number **with its country code**
  (only the digits count: `0501234567` will not match a login that was made with `966501234567`). Separate entries with a comma,
  semicolon or new line - **a space is not a separator**, so two emails separated by a space are one entry that matches nobody.
  Quotes around an entry, and invisible characters (zero-width spaces and direction marks that copying from a web page or a chat can bring
  along), are ignored. An entry that does not look like an email address or a phone number is written to the log at
  start-up, masked (for example `d***@e***`), and the log also says how many super admins are configured
  (`[startup] platform super admins configured: 1`): check that line after changing the setting.
  **Login stays passwordless** (WhatsApp code or email link): WaFlow has no passwords, so there is nothing to set or store.
  A person who signs in by phone *and* by email is two users: list both contacts, or only the one they really use.
* **Platform area** (`/platform` in the app, visible to super admins only): list and search customers; **+ Add a customer** (name, how
  the owner signs in: phone or email + contact, optional owner name, currency, default country code; the button in the dialog is
  *Create customer*); customer detail (owners and members, counts, rename, add person, WhatsApp number card, and a *Recent staff
  activity* card with the last 25 audit rows of that customer).
  Creating a customer makes the workspace, the owner login (a `User` plus an owner `Membership`, so the owner's first login lands
  directly in the customer), the settings and the subscription. **Nothing is sent to the owner**: the screen tells the admin what to
  tell them (open WaFlow and sign in with the contact they were given). The screen shows that contact **masked** (last four digits or
  `a***@d***.com`), so keep the full contact yourself to pass it on. The owner then accepts the legal terms on first login as usual.
* **Enter a customer** (act-as): *Enter* swaps the browser to an 8-hour token with no membership row (so the customer's team list and
  seat count are untouched). A banner reads "You are viewing X as a super admin" with *Back to Platform*. While inside, the person
  cannot use `/api/platform` except to exit, cannot accept the customer's legal terms, and cannot enter another customer. The token is
  re-validated against the allowlist on every request.
* **Audit log** (`PlatformAuditLog`, append-only at schema level): every create, rename, add person, WhatsApp number change, verify,
  enter and exit, **and every change made while inside a customer** (`act_as_write`: method and path, never the body). The row is
  written *before* the change; if it cannot be written the change is refused (503 / 500). Each row also keeps the `X-Forwarded-For`
  header as received (`forwardedFor`; behind Azure's front end `ip` is the front end itself, and the real client address is the last
  entry of `forwardedFor`). Contacts are masked, tokens never appear. Reading inside a customer is not logged.
* `ALLOW_SELF_SERVE_SIGNUP=false` makes a login with no membership and no invite answer 403 "Ask your administrator to invite you."
  (super admins and invitees still get in). Default `true` = login is also signup, as before. **Recommended: set it to `false` before the
  first customer is invited**, otherwise anybody who finds the sign-in page can create a workspace of their own.
* `GET /api/auth/me` now also tells the app `superAdmin`, `canManageWhatsApp` (may this session manage the WhatsApp token and template
  cards? the very rule the WhatsApp routes enforce: platform staff for the platform's account, the owner of a customer for its own
  account) and, inside a customer, `actingAs`.
* Security fixes that came with it:
  * the 10-minute *pre-login* token (issued to people in 2+ workspaces so they can pick one) used to be accepted by every `/api/*`
    route and made them run **unscoped**. `requireAuth` now refuses it (and any token whose workspace is not a real id); only
    `/api/auth/select-workspace` accepts it;
  * a request body can no longer carry `workspaceId`, `_id`, `isDemo` or a `$operator` key into the database (`middleware/sanitizeBody.js`
    on the data routes listed in `server.js` - not on the assistant, uploads, support, imports, legal and Instagram-media routes, which
    do not hand a body to the database as it is; `isDemo` switches the consent gate and the real-send guard off and is set by the seed
    script only);
  * an id sent in a request (a promotion's products and services, a flow's promotion and earlier flow, a message's promotion, its
    follow-up buttons and the slot a booking is moved to, a time slot's service, a referral's customers) must belong to the signed-in
    customer, otherwise 400/404 and nothing is written; deleting a message tree never reaches into another customer's;
  * search boxes (products, customers, inbox) treat what is typed as text, never as a pattern (a `(` used to be a 500, `.*` matched
    everybody);
  * the WhatsApp login code can be guessed 5 times per code, and now also at most 10 times per hour and 30 per day per number across
    all its codes (`shared/otpLockout.js`; the answer is 429 with `Retry-After`; counting is atomic, so parallel guesses cannot beat
    it). A code is usable for 5 minutes but its row is kept for 25 hours, because the lockout counts those rows. The email link is not
    affected. Trade-off: anybody can request codes for somebody else's number and burn the guesses, which locks that number's
    WhatsApp-code sign-in for up to an hour (the message says how long and to ask the administrator);
  * e-mail bodies HTML-escape names and messages typed by people (invite and support e-mails), subjects cannot carry a line break;
  * `GET /payment-cancelled?phone=` (a public link) only acts for a number that really has a cart waiting;
  * the WhatsApp template/token routes are for platform staff (or the owner of a customer's own account). While **no** super admin is
    configured, "platform staff" means the people of the oldest workspace, so nobody in a customer's workspace gets platform rights by
    default;
  * test messages ("Send test" on a promotion) are limited per customer per hour (`TEST_SEND_LIMIT_PER_HOUR`, default 30, 0 = no limit)
    and never go to the number of a customer of that workspace who opted out or was erased;
  * the webhook log no longer prints customers' phone numbers and words (see section 2);
  * `/internal-admin` pages HTML-escape stored values.

## 2. WhatsApp numbers

* **Shared number** (default): `WA_PHONE_ID` / `WA_TOKEN` / `WA_WABA_ID`. OTP login and team-invite messages **always** use it.
  `WA_WABA_ID` must be set to the platform's WhatsApp Business Account id: the code uses it to tell "a number added inside the platform's
  account" from "a number in the customer's own account", and to list the platform's templates.
* **A customer's own number**: Platform → the customer → *WhatsApp number* card. Fields: phone number id, optional WhatsApp Business
  Account id, access token (write-only: never shown again, never returned, stored encrypted and bound to that customer),
  *Verify and save* (read-only Graph checks of the number and the token), *Test connection*, *Use platform number*.
  A number added **inside the platform's own WhatsApp account** needs only its phone id (it rides on the platform token).
  Saving a token needs `WA_TOKEN_ENCRYPTION_KEY` (64 hex characters); without it the card answers "not set up on this server".
  The same phone number id cannot belong to two customers or be the platform's own number.
  The checks also read the number's **status**: Meta requires CONNECTED to send, so a number that is not CONNECTED (for example PENDING) is
  saved with a warning, not refused, and shown on the card with its status; sends from it fail with `133010` until it is connected
  (section 7, "A send fails with (#133010)"). The same status of the **shared** number is shown on the Platform screens.
  A check that Meta answers with "busy, try later" (5xx, 429, a throttling code) is **not a verdict**: it is reported as "could not
  check", nothing is saved and nothing is marked invalid. A finding that is not about the token (number not found, other account) is
  shown to the person but does not switch the customer's sending off; only "the token is not valid" does.
* **Fail closed**: a customer that has configured its own number never silently sends from the platform number. If its token cannot be
  read, is flagged invalid, or the number cannot be used, the send is refused with a plain message (HTTP 409
  `WHATSAPP_NUMBER_UNAVAILABLE`). *Use platform number* returns the customer to the shared number **and erases** the customer's saved
  phone number id, WhatsApp Business Account id and token: it is one-way (the screen says "Their saved token is removed"). To go back to
  its own number someone enters all three again, so keep the token somewhere safe before pressing it. (`whatsapp.enabled=false` switches
  the number off without erasing anything, but nothing in the app sets it: it is only possible by editing the database.)
* Which number does a send use? `utils/senderContext.js` carries "which customer is this work for" (set by `requireAuth` for every
  `/api/*` request, per inbound webhook event, and per flow sweep); `utils/waTenant.js` turns that into a phone id, a WABA and a token
  (60-second memo, cleared whenever a number is saved, verified or cleared). Template lists, creation and caches are per WABA.
  If the database cannot be read when the memo has run out (throttling), the entry that expired less than ten minutes ago keeps being
  used and the log says so (`[waTenant] ... could not be re-read`): one failed read does not stop every send of a customer. A number
  that was never read, or was just changed, or whose token the database now says is invalid, still fails closed.
  **An event that arrived on the SHARED number is answered from the shared number**, even if its customer has a number of its own by
  now (the customer's 24-hour conversation is with the shared number); one that arrived on the customer's own number is answered from it.
* **Inbound routing** (`shared/whatsappInbound.js`), per event: *R1* the event's `phone_number_id` is a customer's own number → that
  customer; *R2* (shared number) a status by its message id; a tap by `context.id` or by the id inside its button payload; text by the
  customer found by phone (several customers → the one messaged most recently within 72 hours, else the oldest); *R3* anything else →
  the oldest workspace (where such events always went; only an event attributed to another customer is logged). Meta batches several
  messages and statuses in one POST: each is routed on its own.
  If the lookup itself **keeps failing** (the database errors on three tries over about half a second - this also covers the lookup of
  the oldest workspace that starts every request) the event is *not* attributed to the oldest workspace (it may well be another
  customer's message): nothing is written (no inbox entry, no customer, no reply) and the log says so loudly (with the number masked).
  A typed **STOP / UNSUBSCRIBE or a tapped Opt Out button is still honoured**: the number is opted out in **every** customer that has
  it - those with a number of their own too, because nobody can tell which number it was meant for - and it is answered once, only if
  somebody really was opted out and the message came in on the shared number (a reply can only leave from there). Delivery updates
  that name their message (they find their customer by that message id) and template news (they work from the template name) do not
  need the oldest workspace and are still handled; an update that no message claims is ignored. The webhook has already answered Meta
  by then, so the person simply sends anything else again.
* **A request Meta did not sign** (no valid `X-Hub-Signature-256`: wrong, missing, or no `WA_APP_SECRET` to check it with) is handled
  up to **25 messages or template changes** (a template change counts as 5, because the server then asks Meta for the real status) and
  up to **500 delivery updates**; the rest is logged and left (`[webhook] N event(s) of a request without a valid signature were NOT
  processed`). The legacy handler read only the first message of a request, so these caps are far looser on purpose: a promotion to a few
  hundred customers produces delivery batches that big, and genuine traffic must still get through in a setup where the signature
  cannot be verified. They limit how much a forged request can multiply the database and WhatsApp work it costs, but a forged request
  can still make up to 25 STOP / START / Opt Out events take effect (and be answered): `WEBHOOK_SIGNATURE_MODE=enforce` closes that
  completely. A request that *is* validly signed is handled whole, however much Meta batched in it.
* **Typed STOP / START on the shared number** cannot say which business they mean, so **STOP** opts the phone out in **every customer
  that sends from the shared number**, with one ConsentEvent per customer and one reply. A customer with its **own** number is not
  touched by a STOP typed on the shared number, **except the customer the message is attributed to** (for example the only customer
  that has that phone), which is always processed; a STOP typed on its own number touches only that customer.
  **START** is the opposite kind of statement (it asks a business to message you): it applies **only to the customer the conversation
  is attributed to**, never to another business that a STOP opted out and never to a customer with its own number from the shared
  number (a START typed on a customer's own number applies to that customer). With `CONSENT_REQUIRE_SIGNATURE=on` a START that would
  re-opt someone in counts only when the webhook request was Meta-signed.
* Until a customer has its own number, someone who is not in any customer's list and writes to the shared number lands in the platform
  default workspace (as before).
* **Webhook signature** (`WEBHOOK_SIGNATURE_MODE`): `log` (default) checks `X-Hub-Signature-256` against `WA_APP_SECRET` and logs a bad
  one at most once a minute; `off` does not check; `enforce` answers **401 before anything is processed** for a request whose signature
  was not positively verified as valid: wrong, missing, or never checked (another capitalisation of the path, a form-encoded body, a
  text body). `enforce` does nothing without `WA_APP_SECRET` (the log says so at start-up).
  **Caution:** with `enforce` a wrong `WA_APP_SECRET` (a rotated or mistyped secret, or the secret of another Meta app) makes *every*
  WhatsApp message, tap and delivery update be refused with 401. Switch it on only after a few days in `log` mode with **no**
  `X-Hub-Signature-256 ... invalid` warnings in the log, and keep the old value to switch back. A value that is not `off`, `log` or
  `enforce` is reported at start-up and `log` is used. `WA_APP_SECRET` is read without leading or trailing spaces and new lines (a
  newline pasted along with the secret into the Azure setting would otherwise make every signature "invalid"). (The WhatsApp
  onboarding feature, which is off, has its own, narrower check: `ONBOARDING_WEBHOOK_SIGNATURE`.)
* **Logs**: an inbound message is logged as `Incoming <type> from ********1234 (<message id>)`, and a tapped button as `Button: <id> from
  ********1234`: customers' numbers show their last four digits only. `WEBHOOK_LOG_BODIES=on` (for a short while, while debugging) logs
  the whole message as before. Never leave it on: the log stream is kept and read by more people than the database is.

## 3. Opt-in buttons

* **Promotions screen**: a sixth start card *Ask customers to opt in* (or choose the purpose *Consent request* on a normal promotion).
  A consent request has no discount or product pickers, goes out as separate messages (never a carousel), and has its own message with
  0–3 quick-reply buttons. Each button has a label (25 characters) and an action: **Opt in**, **Opt out**, **Interested**, **None**,
  and, for the first three, an editable confirmation text (sent exactly as written; left blank, a standard reply is sent). The one-click
  *Opt-in request* preset is "Yes, send me offers" / "No thanks"; alternative pairs: "Yes, I'm in"/"No thanks", "Yes, include
  me"/"No thanks", "OPT IN"/"OPT OUT". Three suggested message bodies and writing guidance are built in.
* **Wording guard** (frontend `consent-wording.ts`): errors block saving (unreplaced `[placeholder]`, no Opt in button, label over 25,
  duplicate/empty labels, body over 1024 or starting/ending with a variable); warnings only advise. The merchant must tick an
  acknowledgement of **this exact wording**; changing any word, label, action or confirmation text - or the follow-up message under a
  *Send a message* button, at any depth - withdraws the tick, and a saved acknowledgement counts again on opening only if the saved
  wording still has the fingerprint that was acknowledged. The server stamps the time and the person and keeps that fingerprint
  (`Promotion.consentWordingAck`). (A message with no follow-ups has the same fingerprint as before follow-ups were included.)
* **A tap** (`shared/promoConsentTap.js`): the button payload is `promo:<promotionId>:<action>:<position>`, so editing the message later
  never changes what an old tap meant. The customer and the tenant come from the CampaignMessage found by the tapped message's
  `context.id` (when a tap carries no reply context, or its message id is unknown, the latest CampaignMessage of that promotion sent to
  the sender's own phone is used instead; the customer is always the one recorded on that message), the sender's phone must be that
  customer's phone, and the promotion in the payload must be the message's promotion. *Opt in* → `consent_given` with evidence, clears an earlier opt-out, sends the confirmation (an opt-in that
  WhatsApp stamped *before* the opt-out on record is a late or repeated delivery of an old tap and is ignored). *Opt out* →
  `consent_withdrawn` (always honoured, even if the promotion was deleted since), one short reply, and the same-number sweep.
  *Interested* → recorded, conversation opened, then the normal shop/book flow if the promotion has something to show. *None* → recorded
  only. Latest action wins; the log keeps all of them.
* **Evidence** (`ConsentEvent`, append-only by convention): UTC time of the tap, promotion id and name, the exact message text the
  customer saw (the approved version, rendered with their values), the button label, the button action, template name and version, our
  message id, the customer's own message id (unique: a redelivered tap is recognised and never written or answered twice), the signature
  verdict, and the person's words for START/STOP. `CONSENT_REQUIRE_SIGNATURE=on` applies an opt-in only when the webhook signature was
  valid - for the buttons of a consent request, for START after an opt-out, and also for the two older "yes" buttons (the bulk
  consent-request template button and the order / booking confirmation button, payload `consent_yes_<customer id>`); an opt-out always
  counts. **It needs `WA_APP_SECRET` set and `WEBHOOK_SIGNATURE_MODE` not `off`: otherwise no request is ever "valid" and EVERY opt-in
  tap and START is refused** (logged as `an opt-in tap was ignored`, nothing written, no reply). The app says so once at start-up
  (`[startup] CONSENT_REQUIRE_SIGNATURE is on but webhook signatures cannot be verified ...`): do not leave that line unanswered.
* **Who a consent request reaches**: never opted-out or erased customers, never customers who already opted in, never customers asked
  within `CONSENT_ASK_COOLDOWN_DAYS` (default 7); demo data is exempt. A customer is *claimed* (marked as asked) by one atomic update
  before the message goes out, so two requests running at the same moment cannot both ask the same person; a send that fails gives the
  claim back. With the cooldown set to `0` ("no cooldown") a person asked within the last minute is still skipped, for the same reason.
  Any other promotion cannot use this audience. Flows refuse a consent request (it is sent by hand to people who have not answered
  yet), when it is set up and again when the flow would send.
* **Audience filter** on the send panel: All / Opted in / Not yet responded / Opted out (a consent request defaults to *Not yet
  responded* and its *Opted out* option is disabled); rows that are not opted in carry a "No opt-in" tag and a warning explains what the
  server will skip.
* **START** from an opted-out customer is a **fresh opt-in** (`consent_given`, method `whatsapp_start_command`, source "START after
  opt-out", with the typed words and message id as evidence) for that customer only (see section 2) and clears the opt-out. A START from
  someone who never opted in nor out stays a "Got it" reply and never fabricates consent. (On the `Customer` document the method is
  stored as `whatsapp_button`: the log keeps the precise method.)
* **Reporting**: the Campaign Report of a consent request (or of a promotion with consent buttons) adds opt-ins, opt-outs, interested,
  other taps and the opt-in / opt-out rates (distinct customers, from the log, over delivered messages).
* **Customers page**: a Consent column (Opted in / Opted out / Not responded, date, source), a consent filter, a *Consent history* tab
  per customer, and *Export consent log (CSV)* (UTF-8 with BOM, spreadsheet formulas neutralised, this customer only, 50,000 rows at most).

## 4. Template approval ("block and notify")

Sending a promotion whose own message Meta has not approved no longer falls back silently to the default message.

1. The message is submitted to Meta automatically (versioned names `waflow_flow_<id>`, then `_v2`, `_v3`... when approved wording is
   edited: an edited message needs a new approval). Our own pre-checks say what is wrong before Meta does.
2. The send is **blocked** (HTTP 409 `template_not_approved`) and the screen says *your message is being sent to Facebook (Meta) for
   approval*; the intended recipients are remembered (`Promotion.sendRequest`). If the submission itself failed the screen says that
   instead, with the reason.
3. When Meta approves (webhook `message_template_status_update`, or the 5-minute sweeper, or a live check when the merchant presses
   Send again) the screen shows *approved — Review and send* with exactly those recipients selected.
4. A rejection shows Meta's reason. A message approved in another WhatsApp account (the customer later gets its own number) is
   submitted again, like a new one; one that Meta no longer lists after ten minutes goes back to "not sent for approval".
5. The screen checks every 60 seconds while a message waits; the server answers a check made in the last 20 seconds from memory (Meta
   rate-limits template reads per account, and the platform account is shared by every customer on the shared number). The webhook,
   the sweeper and the send gate always read fresh.

`PROMO_ENTRY_FALLBACK=on` restores the old silent fallback (ordinary promotions only; a consent request has no default message).

## 5. Flows and currency per customer

Every flow trigger query and the scheduler are scoped to the flow's workspace; the scheduler stamps `workspaceId` on every enrolment and
message it writes (delivery callbacks, reports and button taps look rows up by it), and each sweep runs in the flow's sender context.
Settings (currency, country code, cooldown) are per customer (`utils/settingsCache.js`, 5-minute safety expiry).
Old rows written without a workspace are tolerated for the ledger (no re-enrolment, cooldown intact); orders, customers and bookings
without a workspace are no longer seen by flows (in practice only simulated demo orders).

## 6. Environment variables

On / off settings accept `on`, `true`, `1`, `yes` and `off`, `false`, `0`, `no` (any capitals, spaces around are ignored); empty or unset
= the default below. **A value that is none of those is not obeyed: the default applies (for `ALLOW_SELF_SERVE_SIGNUP` it counts as `off`,
so a typo cannot leave sign-up open) and the log says so once at start-up** (`[env] NAME="flase" is not understood`), so a typo in a
safety switch is not silent. `WEBHOOK_SIGNATURE_MODE` reports its own unknown values (`[startup] WEBHOOK_SIGNATURE_MODE=... is not
understood`). `PROMO_DELIVERY_FIX` keeps its own, older rule (`off`, `0`, `false`, `no` turn it off).

| Name | Default | Meaning |
| --- | --- | --- |
| `SUPER_ADMIN_CONTACTS` | empty | Verified login contacts (emails and/or phone numbers with country code) of super admins, separated by comma, semicolon or new line (**not by spaces**: a phone number may contain them; quotes around an entry, and invisible characters that copying from a web page or a chat can bring along, are ignored). Emails are matched case-insensitively, phones by their digits. Empty = nobody. Read at start-up: **restart the app after changing it** (Azure does when you save the setting). The start-up log says how many are configured. |
| `WA_TOKEN_ENCRYPTION_KEY` | unset | 64 hex characters (or base64 of 32 bytes; the key may already exist for the onboarding feature - check before generating one). Required to **save** a customer's own WhatsApp token. **Never change or lose it**: every saved token is bound to it and would have to be entered again. Keep a copy somewhere safe. |
| `WA_WABA_ID` | existing | The platform's WhatsApp Business Account id. Must be set. |
| `ALLOW_SELF_SERVE_SIGNUP` | on | `off` / `false` = strangers cannot create their own workspace (a value that is not understood counts as `off`). Recommended `false` once customers are onboarded by staff. |
| `WEBHOOK_SIGNATURE_MODE` | log | `off` / `log` / `enforce` (see section 2, including the caution). Anything else is reported and means `log`. |
| `WA_APP_SECRET` | existing | App secret of the Meta app that owns the webhook; needed for any signature check (surrounding spaces and new lines are ignored). |
| `CONSENT_REQUIRE_SIGNATURE` | off | `on` = an opt-in tap or START counts only with a valid signature (opt-outs always count). **Needs `WA_APP_SECRET` and a signature mode other than `off`, or every opt-in is refused** (section 3). |
| `CONSENT_ASK_COOLDOWN_DAYS` | 7 | A customer asked within N days is skipped by another consent request (0 = no cooldown, except that a person asked within the last minute is still skipped). |
| `PROMO_ENTRY_FALLBACK` | off | `on` = old silent fallback for an unapproved custom message. |
| `TEMPLATE_APPROVAL_SWEEP` | on | `off` stops the 5-minute template-status sweeper (read at start-up). |
| `PROMO_DELIVERY_FIX` | on | Existing: `off` / `0` / `false` / `no` restores the pre-24-hour-window delivery behaviour. |
| `TEST_SEND_LIMIT_PER_HOUR` | 30 | "Send test" messages per customer per hour (0 = no limit). Counted per server instance and forgotten at every restart. |
| `WEBHOOK_LOG_BODIES` | off | `on` logs whole inbound messages (phone numbers and words). Debugging only. |

`AUTH_TEST_MODE` and `DEV_LOGIN_SECRET` must **not** be set in production (the first returns login codes in the response, the second is a
login bypass).

## 7. Runbook

### Before the push (backend first, then frontend)

1. **Write down what is live now**, before you commit anything: run `git log -1 --format=%h` in each repo (on 2026-10-26 the live
   commits were backend `3154dca` and frontend `c76674f`). That is what you go back to if you ever have to roll back (see *Roll back*).
2. **Rows without a workspace: check; the one-time backfill is recommended, and the deploy is safe without it.** A handful of rows in
   the live database were written before every row carried a workspace (counted read-only on 2026-10-26: customers 1 of 7, orders 3 of
   17, bookings 1 of 9, services 1 of 3, time slots 1 of 6,189, promotions 1 of 11, flow enrolments 3 of 3, campaign messages 2 of 88;
   no flow). Every screen, the webhook and the flows already ignore such a row at the previous release, and still do: nothing gets worse
   with this change, but those rows stay invisible (a customer without a workspace does not have its typed STOP recorded). One thing
   must be true, because the scheduler skips a flow without a workspace (with a warning every five minutes) and it would silently stop
   sending: `db.flows.countDocuments({ status: 'active', workspaceId: { $in: [null] } })` must be `0` (run it in the Azure portal →
   your Cosmos DB account → Data Explorer → the **Mongo shell**, not the filter box). To bring the other rows back, run the backfill
   once from the backend folder with a `.env` whose `MONGODB_URI` is the **live** database: `node scripts/backfill-workspace-id.js`.
   It **writes** (it stamps those rows with the oldest workspace; it is idempotent, deletes nothing and is safe with the old code), so
   read section 8 first; afterwards `db.customers.countDocuments({ workspaceId: { $in: [null] } })` and the same for `orders`,
   `bookings`, `services`, `timeslots`, `promotions`, `flowenrollments` and `campaignmessages` must be `0`.
3. **Stage everything that belongs to the change: the files that CHANGED and the NEW ones, and nothing else.** The new files are useless
   without the files that were already in git and were changed to use them, and the other way round, so "explicit paths" means: every
   changed file, the new files by name, and nothing that is not part of this change. The same commands work in PowerShell and Git Bash.
   Backend (in the backend folder):

```
git add -u
git add middleware/requireSuperAdmin.js middleware/sanitizeBody.js models/PlatformAuditLog.js routes/platform.js shared/crossWorkspaceOptOut.js shared/otpLockout.js shared/platformAdmin.js shared/platformStaff.js shared/promoConsentTap.js shared/templateApproval.js shared/webhookBudget.js shared/whatsappInbound.js utils/envFlag.js utils/escapeRegex.js utils/flowTriggers/scope.js utils/indexWatch.js utils/senderContext.js utils/waTenant.js
git add scripts/check-requires.js docs/platform-multitenancy-and-optin.md tests
git status
```

   `git add -u` stages the changed files that are already in git (61 when this was written). The 18 files on the second line are the new
   ones the server requires - some at start-up, some only when a feature is first used: without `shared/platformStaff.js` every
   `/api/auth/me` answers 500 and nobody can sign in; without `shared/crossWorkspaceOptOut.js` a typed STOP is not recorded; if the log
   says `[platform] routes not mounted`, `routes/platform.js` or `middleware/requireSuperAdmin.js` is missing (the app still starts
   without them). The third line adds this document, the checker and the tests (the `*.itest.js` ones are skipped by a plain
   `npx jest`). The last `git status` must show **nothing** under "Changes not staged" or "Untracked files" in the backend; if
   something is listed, it either belongs here or has to be understood first.
   Frontend (in the frontend folder):

```
git add src
git add -u -- . ":(exclude).gitignore"
git status
```

   `git add src` stages the 28 changed files and the 41 new ones: 18 that the app needs (`src/app/guards/platform-admin.guard.ts`,
   `src/app/shared/platform-api.service.ts`, `src/app/shared/message-node-editor/consent-wording.ts`,
   `src/app/pages/promotions/promotions-consent.css` and the 14 non-test files of `src/app/pages/platform-admin/`) and 23
   `*.spec.ts` tests (6 of them in `platform-admin/`, which holds 20 files in all). The second line catches a changed file outside
   `src`, if there is one. **Left out on purpose**, and the only things `git status` may still show afterwards: the modified
   `.gitignore` (it adds a `docs` rule that would hide a future docs folder) and the untracked `e2e/onboarding/` folder (other work,
   not part of this change).
4. **Prove the commit is complete.** Before committing, in the backend folder: `node scripts/check-requires.js`. It follows every
   `require` of `server.js`, the lazy ones inside functions included, and exits with an error when a required file is not in git
   ("REQUIRED BUT NOT IN GIT") or does not exist; it must end with `OK`. (It also checks that every
   `shared/localization/catalog/*.json` file, which the server reads at run time, is in git.) After committing, prove what was
   *committed* - not your working folder - in a **new, empty folder**. `git archive` only works inside the repository; `tar` is
   built into Windows 11 (PowerShell and Git Bash):

```
git archive -o ../backend-check.tar HEAD
mkdir ../backend-check
cd ../backend-check
tar -xf ../backend-check.tar
npm ci
node -e "process.env.AUTH_JWT_SECRET='x'; process.env.STRIPE_SECRET_KEY='sk_test_dummy_not_real'; require('./server'); ['./shared/platformStaff','./shared/crossWorkspaceOptOut','./shared/promoConsentTap','./shared/templateApproval','./utils/flowTriggers/scope','./utils/flowScheduler','./routes/platform','./middleware/requireSuperAdmin','./models/PlatformAuditLog'].forEach(m=>require(m)); console.log('complete'); process.exit(0)"
```

   The first command runs in the backend folder, the rest in the new one. The `node` line loads the files that `require('./server')`
   alone only loads when they are first used; it must print `complete` (the two dummy settings in it are only there because the new
   folder has no `.env`: without a Stripe key the server refuses to load at all, which says nothing about the commit). It also prints a
   few harmless "not set" notes and a failed connection to a local database that does not exist. **Do not copy `.env` into the new
   folder**: `require('./server')` connects to the database named in it. Use the `-o file.tar` form above, not a pipe: piping `git archive` into `tar` in PowerShell
   5.1 corrupts the stream. The frontend gets the same proof (a build of the working tree can pass while the commit lacks a file): the
   same `git archive -o ../frontend-check.tar HEAD`, `mkdir`, `cd`, `tar -xf`, then `npm ci`, and then, as a separate line (PowerShell
   5.1 has no `&&`), `npm run build`. The build includes the i18n check; the Promotions screen's consent styles live in their own file
   (`promotions-consent.css`) to stay inside the component-style budget.
5. **Order**: backend first. Wait until the deploy has finished and the smoke test below passes, then push the frontend (the new
   frontend needs the new backend: see *Roll back*).

### Azure settings (Environment variables), before or with the first deploy

1. `SUPER_ADMIN_CONTACTS` = the super admins' **login contacts**. Today: `adeelijaz49@gmail.com`. Adding Andrew later:
   `adeelijaz49@gmail.com,<andrew's login email>` (a comma, no space). Azure restarts the app when the setting is saved; the log then
   shows `[startup] platform super admins configured: 1` (or 2). WaFlow has no password: sign in with the emailed link.
2. `WA_WABA_ID` = the platform's WhatsApp Business Account id (check that it is already there).
3. `ALLOW_SELF_SERVE_SIGNUP` = `false` (recommended before inviting the first customer). A value that is not understood counts as `false`
   (sign-up stays closed) and the log says so: fix the spelling.
4. When the first customer gets its **own** number: first look in Azure whether `WA_TOKEN_ENCRYPTION_KEY` is **already set** (the
   WhatsApp onboarding feature uses the same setting). If it is, keep it and do not generate a new one - a new key would orphan every
   token saved under the old one. Only if it is missing, generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, store a copy somewhere safe, and never change it.
5. Leave `WEBHOOK_SIGNATURE_MODE` unset (= `log`) at first. Later: set `WA_APP_SECRET` (if it is not set), watch the log for
   `X-Hub-Signature-256` warnings for a few days, and only when there are none consider `enforce` (read the caution in section 2).
6. Make sure `AUTH_TEST_MODE` and `DEV_LOGIN_SECRET` are **not** present.

### Smoke test after the deploy (five minutes)

1. The log shows `MongoDB connected` and `[startup] platform super admins configured: N`, where N is the number of contacts you entered,
   and **none** of these lines: `[indexes] ...` (a unique rule is not enforced by the database: see section 8), `[env] ... is not
   understood` or `[startup] WEBHOOK_SIGNATURE_MODE=... is not understood` (a setting has a value nobody understands and its default -
   or, for sign-up, "closed" - applies: fix the spelling), `[startup] CONSENT_REQUIRE_SIGNATURE is on but ...` (every opt-in would be
   refused: section 3), `[platform] SUPER_ADMIN_CONTACTS: ... do not look like an email address or a phone number` (an entry of that
   setting is wrong: section 1).
2. Sign in as the owner with the email link. The **Platform** entry is in the menu; Settings still shows the WhatsApp token and template
   cards. `GET /api/auth/me` answers `superAdmin: true` and `canManageWhatsApp: true`. If the Platform entry is missing the contact does
   not match what is stored on the user: check the exact email (see section 1) and the start-up line above.
3. Sign in once by WhatsApp code too (the code check was rewritten): the right code opens the app and works once only.
4. Open Customers, Promotions and the Inbox of the existing business: everything is as before (nothing was deleted or moved).
5. Send a message to the shared WhatsApp number from a test phone: it appears in the Inbox. Reply `STOP` then `START`: the consent
   history of that customer shows both.
6. Platform → **+ Add a customer** (a test customer with a test email; *Create customer*) → sign in as that owner in a private window →
   they see an empty dashboard of their own and none of the first business's data. Leave the test customer (rename it "TEST - do not
   use"; nothing is ever deleted).

### Onboard a customer (pilot: MegaSun)

Platform → **+ Add a customer** → name, owner contact, currency, country code → *Create customer*. Tell the owner what the screen says
(the screen shows their contact masked, so keep the full one yourself to pass on). They open WaFlow, sign in with that contact (WhatsApp
code or email link) and accept the legal terms. To look over their shoulder: Platform → the customer → *Enter*; *Back to Platform*
leaves. Everything changed while inside is written to the audit trail and shows in the customer's *Recent staff activity* card (the
last 25 entries; the full trail is the `PlatformAuditLog` collection).
Until the customer has a number of its own it sends from the shared number. **The shared number must be able to reach the customer's
shoppers**: if it is still a Meta *test* number (only verified recipients can be messaged), the customer's promotions cannot reach real
shoppers until a real number is attached; do not promise otherwise.

### Give a customer its own WhatsApp number (where to enter MegaSun's number tomorrow)

Platform → the customer → **WhatsApp number** card: phone number id, WhatsApp Business Account id (leave empty only if the number lives
inside the WaFlow account), access token (leave empty only for a number inside the WaFlow account) → *Verify and save*.
`WA_TOKEN_ENCRYPTION_KEY` must be set first. **The token must be a permanent system-user token** generated for **WaFlow's Meta app**, with
`whatsapp_business_messaging` and `whatsapp_business_management`, and that system user must be assigned to the customer's WhatsApp
Business Account. *Verify* only reads the number, so it also passes for a messaging-only token or a temporary 24-hour token - which then
stops working (template submission needs the management permission, and once a token has expired that customer's sends fail until a new
token is saved; press *Verify* again to see it). Then, on the Meta side:

* the customer's WhatsApp Business Account must be **subscribed to WaFlow's Meta app**, so its webhooks reach `/webhook`
  (`POST https://graph.facebook.com/<version>/<customer WABA id>/subscribed_apps`): **the call subscribes the app that issued the token
  it is made with**, so make it with a token generated for WaFlow's own app; the webhook's own subscription must include the
  `messages` and `message_template_status_update` fields;
* a new WhatsApp Business Account starts **without WaFlow's standard templates** (promotion, loyalty reminder, win-back ...): nobody has
  to create them by hand - they are submitted to Meta automatically the first time they are needed, and each needs Meta's approval, so
  the first send of each kind is blocked until then (a promotion shows the "being sent to Facebook for approval" notice).
  Settings → WhatsApp Message Templates only *lists* them.

After saving, send a test message from the customer's Promotions screen. *Use platform number* reverts the customer to the shared number
and erases the saved number and token (section 2): entering them again is the only way back.

### Meta-side actions (cannot be done from the app)

* Subscribe the WaFlow Meta app to the webhook field `message_template_status_update` (otherwise approvals are found by the 5-minute
  sweeper, or when the merchant presses Send again).
* For every customer with its own number: subscribe their WhatsApp Business Account to WaFlow's app (above).
* Keep the shared number a real, registered number (not the Meta test number) before real shoppers are messaged.

### A send fails with "(#133010) Account not registered"

**What it means.** Meta's error table: *133010 - Phone number not registered on the WhatsApp Business Platform; register the phone number.*
Meta also says a business phone number "must have a status of connected" to send. The error is about the **sending** number, never about
the customer who should receive the message (recipient problems have other codes: `131026` not reachable on WhatsApp, `131030` not on the
test number's allowed list, `131047` the 24-hour window is closed). The Promotions screen shows Meta's words with one plain sentence under
them.

**1. Which number sent it?** Platform → the customer → *WhatsApp number* card. "Sending from: The shared platform WhatsApp number" means
the shared number: the card shows its status, and the Platform list shows a warning banner whenever there is a problem with the shared
number (it is not connected, or the platform token or phone number id cannot be read). An own number means that number (the last four
digits of its phone number id are shown). If another customer that uses the same sender fails too, it is the sender.

**2. Read the number's status** (read-only; the token goes only in the Authorization header, never in a URL, a chat or a ticket):

```
curl -s -H "Authorization: Bearer $TOKEN" "https://graph.facebook.com/v25.0/<phone number id>?fields=display_phone_number,verified_name,status,code_verification_status,name_status,platform_type,whatsapp_business_account"
```

Healthy: `status` CONNECTED and `code_verification_status` VERIFIED (a Meta *test* number legitimately reads `platform_type`
NOT_APPLICABLE). Meta requires CONNECTED to send, so `PENDING` means the number is not ready to send. Meta does not define PENDING for a
phone number: reading it as "not registered" is our inference, backed by the 133010 text and by the shared number reading PENDING /
NOT_VERIFIED on 25 October 2026 (until it reconnected) and again on 30 October 2026 (a merchant's opt-in send failed with 133010).

**The shared number** is Meta's free test number (a +1 555 number). On 2026-10-25 it was CONNECTED again after the owner generated an
access token in the Meta developer dashboard (the WaFlow app → WhatsApp → API Setup) and put it on the server; whether that or something
on Meta's side did the work is **not established** (Meta documents nothing about a test number leaving CONNECTED), and it was PENDING
again on 2026-10-30. Do **not** delete the test number or the app (Meta may not issue another). There is no documented reason to call
`/register` on it (it would spend one of the 10 tries per 72 hours and set a PIN). In order:

1. API Setup → *From* must be the test number: the phone number id on the server (`WA_PHONE_ID`, default ending 1618) and its account
   (`WA_WABA_ID`). If the dashboard shows other ids, Meta re-provisioned the number and the server settings are stale.
2. *To* → *Manage phone number list*: the phone that should receive the test (up to 5) must be on the list.
3. Generate the access token, then press *Send message* (the hello_world template) to that phone: this tests the number in Meta's own
   tool, outside WaFlow. It is a test, not a known repair.
4. Read the status (above), or press *Check again* on the Platform screen. CONNECTED means it worked; still PENDING: go to step 6.
5. Give the server a durable token: Business settings → Users → System users → a system user with the app and the WhatsApp account → a
   token with `whatsapp_business_management` and `whatsapp_business_messaging` and the longest expiry offered. A token from API Setup
   "expires quickly".
6. Still PENDING: open a Meta developer support ticket with the phone number id, the account id, the `fbtrace_id` of a failed send and the
   dates, and stop relying on the test number.

The test number can message only the people on its allow-list, so it cannot serve real customers. Also read the account's health
(`GET /<waba id>?fields=health_status`): when a BUSINESS-level entity reads BLOCKED, its `errors` array says why (for example that the
business is not verified or its profile is incomplete). That did not stop test-number sends on 2026-10-25, but fix it before real
shoppers are messaged, when the shared number should be a real, registered number with an approved display name.

**A customer's own number** (the fix is in the customer's Meta account):

1. Add the number (WhatsApp Manager → Phone numbers) with the display name customers should see. It must be able to receive an SMS or a
   call and must not be active in a consumer WhatsApp or WhatsApp Business app.
2. Verify it with the code: `code_verification_status` must read VERIFIED.
3. Register it for the Cloud API: `POST /<phone number id>/register` with `{"messaging_product":"whatsapp","pin":"123456"}`. The PIN has 6
   digits: the number's existing two-step PIN if it has one, otherwise the PIN you send **becomes** its two-step PIN (write it down).
   Token: `whatsapp_business_management` and `whatsapp_business_messaging`. At most 10 tries per number per 72 hours (then `133016`).
   Meta's registration page says a number can be registered only through the API; reports differ on whether WhatsApp Manager registers it
   by itself after the code, so go by the status read, not by the screen. A number added by Embedded Signup must be registered within 14
   days, or the signup repeated.
4. Read the status: CONNECTED. Then Platform → the customer → *Verify and save* / *Test connection*: both show the number's status, and
   a number that is not connected is saved with a warning, not refused.
5. The customer's own account needs its own approved templates (WaFlow submits its standard ones the first time they are needed), a
   payment method (the account's payment settings in Meta), and a token that belongs to the business that owns that account.

**What tends to fail next:** `131030` for a recipient who is not on the test number's allow-list; a template that does not exist or is not
approved in the sender's own account (`132001`, `132015`, `132016`); `131047` outside the 24-hour window; `131037` for a display name
that is not approved yet; `190` when a short-lived token expires (WaFlow then marks that customer's token invalid and stops its sends);
`131049` marketing limits per person; `131042` when the account has no payment method; and a new business account starts at 250 unique
recipients per day until it is verified.

### Roll back

* **Roll the frontend back first, or both together - never the backend alone.** The new frontend shows the Settings WhatsApp token
  and template cards only when `/api/auth/me` says `canManageWhatsApp: true`, which an old backend does not: after a backend-only
  rollback those cards disappear for everybody, the owner included. Also, a consent-request promotion or a message with consent
  buttons or 25-character labels that was saved before the rollback cannot be saved or edited by the old code (its schema does not know
  the new values: a validation error on save). Nothing in this change deletes data, and the old frontend simply does not show the new
  screens.
* **After a second customer exists**: do **not** roll the backend back at all. The old code gives every WhatsApp event to the oldest
  workspace, so the second customer's taps, delivery updates and STOP would land in the wrong business. Use the kill switches in
  section 6 instead (`PROMO_ENTRY_FALLBACK`, `TEMPLATE_APPROVAL_SWEEP`, `WEBHOOK_SIGNATURE_MODE=log`) or remove a contact from
  `SUPER_ADMIN_CONTACTS`. (*Use platform number* is **not** a temporary switch: it erases the customer's saved number and token, so it
  is a last resort that has to be undone by entering them all again.)
* **How**: take the commit ids you wrote down before pushing (section 7, step 1), or run `git revert --no-edit <the new commit>` in the
  repo and push the result - frontend first. Never rewrite history on the branch that Azure deploys from.

## 8. Data changes and indexes (verify once on Cosmos)

All additive. New: `PlatformAuditLog`; `Workspace.whatsapp.{tokenEncrypted (select:false), tokenKeyVersion, displayPhoneNumber, verifiedName,
tokenIsValid, tokenCheckedAt, enabled}` with a **partial unique index on `whatsapp.phoneId`**; `Promotion.{purpose (default 'standard'),
consentWordingAck, sendRequest}`; `MessageNode` template version/snapshot/lifecycle fields and consent button actions + `replyText`;
`CampaignMessage.{consentSnapshot, clickedButtonAction, lastTapWamid}` + index `{phone, createdAt}`; `ConsentEvent` evidence fields + a
**unique sparse index on `inboundWamid`** + compound indexes; `Customer` gains a single-field index on `phone`. The `Customer`
consent-method enum is unchanged (the precise method is on the `ConsentEvent`).

Mongoose builds indexes at start-up and does not fail the app if a build fails (Cosmos DB for MongoDB can refuse a unique or compound
index on a collection that already holds documents; it builds single-field indexes on existing data). The app now logs
`[indexes] <Model>: an index could not be built (...)` for Workspace, ConsentEvent, CampaignMessage and PlatformAuditLog. After the
first deploy confirm the indexes exist: Azure portal → your Cosmos DB account → Data Explorer → open the **Mongo shell** (not the filter
box of a collection), then:

```
db.workspaces.getIndexes()       // whatsapp.phoneId_1  (unique, partial: { whatsapp.phoneId: { $type: "string" } })
db.consentevents.getIndexes()    // inboundWamid_1  (unique, sparse), plus customerId_1_createdAt_-1,
                                 // workspaceId_1_type_1_createdAt_-1 and workspaceId_1_promotionId_1_type_1_createdAt_-1
db.campaignmessages.getIndexes() // phone_1_createdAt_-1
db.customers.getIndexes()        // phone_1
```

What a missing index means (the app keeps working in every case):

* `whatsapp.phoneId_1` (unique): the code checks for a duplicate itself, but two customers could be given the same phone number id at the
  same moment; inbound routing by phone number id assumes one customer per id.
* `inboundWamid_1` (unique): a redelivered **tap** is still recognised (the handler looks the message id up first), but a redelivered
  typed STOP / START has no unique guard and could be recorded twice.
* `phone_1_createdAt_-1` on campaign messages: the "latest message to this phone" lookups (inbound routing of a phone that belongs to
  two customers, tap fallback) sort without an index and may fail on Cosmos; the router retries, then treats the event as not
  attributable (see section 2).
* `phone_1` on customers: phone lookups are slower, nothing else changes.

If one is missing: the collections that already hold data (`workspaces`, `consentevents`, `campaignmessages`) are the ones Cosmos may refuse
its unique or compound indexes on. Create the index from the Azure portal (the collection's *Indexes* tab / Data Explorer) or with
`db.<collection>.createIndex(...)`; if Cosmos refuses the unique one on the non-empty collection, accept the code-level duplicate check
described above and carry on. (The compound indexes of `consentevents` serve the consent reports and lists; without them those screens
are slower, nothing is lost.)

The consent log, its CSV, a customer's consent history and the audit list are sorted by `_id`, the one field Cosmos always has an index
for (the Settings *recent consent activity* feed still sorts by `createdAt`, as it always did).

`node scripts/backfill-workspace-id.js` is a **one-time write migration**, not a check: it stamps every row that has no workspace with the
platform default workspace, in these collections only: Product, Service, TimeSlot, Customer, Booking, Order, Promotion, Flow,
FlowEnrollment, MessageNode, CampaignMessage, Settings and AiChatSession (idempotent, deletes nothing). It needs `MONGODB_URI` in a
`.env` on the machine that runs it. It also stamps the simulated demo orders that have no workspace, which makes them visible to flows
(sections 5 and 9 describe them as not picked up). Collections that were not part of it (ConsentEvent, WhatsAppMessage, points ledger,
referrals, vouchers) keep any rows without a workspace. In production there are a handful of rows without a workspace, for example a
customer whose STOP is not recorded until it is stamped (it was not recorded at the previous release either): running it once is
recommended but not required for the deploy (section 7, step 2, which also lists the checks to run afterwards).

## 9. Known limits

* Carts and a few pending-step maps are kept in memory keyed by phone, not by customer: a second customer must not use WhatsApp checkout
  payments yet.
* A typed Arabic STOP (Arabic is off for every merchant) and the Opt Out button apply to the customer the message was attributed to.
* Someone who is not a customer of anyone and writes to the shared number lands in the platform default workspace.
* `CONSENT_REQUIRE_SIGNATURE` and `WEBHOOK_SIGNATURE_MODE=enforce` are off by default: until they are on, the consent tap handler cannot
  tell a forged webhook from a real one.
* Simulated (demo) orders from before this change have no workspace and are not picked up by flows.
* A consent request is sent synchronously (about 300 ms per recipient inside one request): keep batches to a few hundred.
* Every template version (each edit) uses a slot of the WhatsApp account's template quota.
* A START typed by a customer who is already opted in still writes a `consent_reinstated` row.
* A person removed from a customer's team keeps a valid session for up to 30 days (the sign-in token is not checked against the team
  list on each request). Removing the membership does not end it, and nothing in the app can change a person's sign-in contact. The only
  immediate way to end it is to change `AUTH_JWT_SECRET` in Azure, which signs **everybody in every customer** out (they sign in again);
  otherwise it lapses on its own within 30 days.
* If the webhook is down for a few minutes and a customer's STOP and a later "Yes" tap are both redelivered at once, the tap is judged by
  Meta's own timestamp against the moment the STOP was processed; a tap that was made before that moment is ignored (logged only, no
  record, no reply) and the customer has to tap again. Ignoring a late tap is the safe direction: an old tap can never undo an opt-out.
* Anybody can request WhatsApp login codes for somebody else's number and use up its guesses, which locks that number's WhatsApp-code
  sign-in for up to an hour (the email link is unaffected).
* The "Send test" limit, the 60-second sender memo and the other small memories are per server instance and forgotten at a restart.
* Template status is read by paging through the account's whole template list; with many customers on the shared account each check
  makes more requests to Meta (the screen's 20-second memory and the 5-minute sweeper keep it modest).
* The consent-log CSV stops at 50,000 rows and does not say so in the file (the screen cannot read the server's truncation header).
* Opt-in logging is append-only by convention (the consent model has no update path), not enforced in the schema.
* When a consent request is sent, a customer whose "asked" marker could not be claimed is counted as "asked recently" whatever the reason
  (somebody else asked first, the person answered or was erased while the send was running, or the database failed for that one customer).
  Nothing is sent to them in any of those cases; only the explanation on the screen can be wrong after a database error.
* The two older "Yes" buttons (the bulk consent-request template button and the order / booking confirmation button, payload
  `consent_yes_<id>`) behave as they always did, now only with the signature rule added: they record `consent_given` without clearing
  an earlier opt-out (the customer stays opted out, although the reply says "You're subscribed!"), and a redelivered tap is recorded and
  answered twice. The buttons of a consent request (`promo:...`) have none of these limits.
* A forged request that is not signed (the default `log` mode accepts it) can still make up to 25 STOP / START / Opt Out events take
  effect and be answered per request, and 500 delivery updates be applied (section 2): `WEBHOOK_SIGNATURE_MODE=enforce` closes it.

## 10. Tests

Backend: unit suites (`npx jest`) and the database-backed `*.itest.js` suites, which run only against a throwaway MongoDB (the helper
refuses any other database name; they are skipped by a plain `npx jest`). New or extended suites: `platformAdmin`, `requireAuth`,
`senderContext`, `waTenant`, `whatsappInbound`, `promoConsentTap`, `templateApproval`, `consentCore`, `promoConsentOps`, `flowTenantScope`,
`settingsCacheTenant`, `otpLockout`, `emailEscaping`, `customFlowTemplate`, `envFlag`, `sanitizeBody`, `indexWatch`, `webhookBudget` (unit) and
`platformTenants`, `tenantSender`, `inboundRouting`, `consentCore`, `consentPromo`, `flowTenants`, `securityHardening` (integration,
several customers each; `securityHardening` also sweeps the data routes for cross-customer reads and writes, and covers the webhook
when a customer cannot be determined, the unsigned-request cap and the older opt-in buttons). Frontend: `ng test` (vitest); the one
failing default test (`app.spec.ts`, "should render title") predates this change.
The two *English unchanged* characterisation suites pin the English behaviour. Their stored results (the "golden" files) are **not in the
repository**: they are recorded from a checkout of the previous release (`ENG_RECORD=1`, written to the machine's temporary folder
unless `ENG_GOLDEN_FILE` names another place) and every run compares against them, with the approved differences below spelled out in
the suite. `englishUnchanged2` and `legacySenders` additionally pin the OLD behaviour by running with `PROMO_ENTRY_FALLBACK=on` and
`PROMO_DELIVERY_FIX=off`, so they do not exercise the new block-and-notify and 24-hour-window behaviour (`consentPromo`, `promoConsentOps`
and `promoWindow` do). The approved differences are: flow rows carry the workspace (so flow button taps, attribution and the enrolment
list now work for new rows), START after opt-out is a fresh opt-in, the unauthenticated `POST /send-message` is gone,
`GET /payment-cancelled` for a number with no cart sends nothing, an unapproved custom message is now blocked and submitted instead of
silently falling back to the default message, new optional fields in responses and documents, settings created by a read belong to their
workspace, and flows no longer pick up rows that belong to no customer.
