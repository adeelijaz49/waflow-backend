# Integration backlog — what needed (and still needs) edits to EXISTING files

The first build (2026-10-11) was done under *don't touch existing code*, so this list recorded everything that needed an existing-file edit. The wiring phase (2026-10-12, "finish the entire thing") then did the P1/P2 items below as small, guarded, fail-open hunks (listed in `README.md`, "Existing-file edits"). Status: **DONE** = shipped behind the per-merchant flag, with the one-line note of how; **OPEN** = not done, with the reason. Priorities: **P1** = needed before Arabic is used with real customers at scale; **P2** = completes spec coverage; **P3** = nice to have / hygiene. Decision ids (G1-G10, D1-D5) are the owner-delegated decisions of the wiring phase.

## A. Sending the Arabic version from the existing send paths

| # | Pri | Status | Item |
|---|---|---|---|
| A1 | P1 | **DONE** | Promotions (dashboard, AI Mode, MCP, GPT Actions all call `ops.sendPromotion`): per-customer seam `shared/localization/legacySenders.js` inside the existing loop; Arabic customers get an approved + reviewed Arabic version (promotion-linked via `LocalizedTemplate.linkedPromotionId` + `shop_now` button, or entry-node-linked), everybody else the unchanged English message; plan/report endpoints; test send via `POST /api/localization/promotions/:id/test-send` (the legacy `sendTestMessage` and AI Mode/MCP/GPT test sends stay English by decision). |
| A2 | P1 | **DONE** | Automated Flows: ~8 lines in `utils/flowScheduler.js processEnrollment` call `flowBridge.sendLocalizedFlowMessage` (flag first, English entry node must be approved, `{service}` resolved lazily). The Arabic rows carry `workspaceId`. The English engine's missing `workspaceId` was **not** fixed (see I1). |
| A3 | P2 | **DONE** (partly out of scope) | Loyalty reminders (`loyalty_reminder` / `loyalty_reminder_balance` library use cases), bulk consent requests (`welcome_optin`), referral link text, booking confirmed / cancelled / rescheduled / declined notices, order summary + pay link (`createOrder`) and `sendUtilityMessageWithConsentAsk` via `legacySenders.js` / `utilitySend.js` / a `localized` option; booking confirmation outside the 24 h window falls back to an approved + reviewed UTILITY Arabic template. Payment and booking *reminders* have no English sender, so there is nothing to wire. |
| A4 | P2 | **DONE** | Branching follow-ups: `handleMessageNodeTap` calls `followUpSender.sendLocalizedFollowUp` (reviewed, issue-free, not-stale Arabic text from `LocalizedFlowNode`; language = the customer's; no bilingual follow-ups; a failed Arabic send is a failed row, no English resend). The hub flows tab lists every flow plus the promotions that have a custom entry message but no flow (`GET /flows/promotion-trees`), so follow-ups of a promotion sent from the Promotions screen are reachable too. |
| A5 | P3 | OPEN | **Referral reward notices**: no sender exists in English either; a notifier design (poll `ReferralReward{status:'issued'}` + the friend's `Voucher`, claim-then-send collection, 24-hour-window aware) is in the audit notes. New product behaviour - owner decision (G10). |
| A6 | P2 | **DONE** | The shopping journey after the first tap (catalogue, cards, variants, cart, checkout, pay link, confirmations, points and booking summaries): not ~40 call-site edits but one outbound localiser called from both `waPost` functions (`shared/localization/outbound.js` + `journeyMatcher.js`, 86 draft entries in `catalog/journey.json`); only whole-message matches of a catalogued English shape are replaced, anything else is sent untouched. |

## B. Customer data & forms

| # | Pri | Status | Item |
|---|---|---|---|
| B1 | P2 | **DONE** | The sidecar `CustomerLanguage` stays the store (no change to `Customer`); the existing customer profile shows/edits it (`app-customer-language-field`, `GET|PUT /api/localization/customers/:id/language`) and the existing CSV import wizard maps a `language` column (`ar`/`en`/`Arabic`/`English`, flagged workspaces only). |
| B2 | P1 | **DONE (global)** | `toWesternDigits` / `toWesternNumerals` before the existing phone, price and OTP-code regexes; BOM-less UTF-8 / Windows-1256 CSV decoding (`importDecode.prepareUploadBuffer`); Arabic header aliases as a fallback only when no English alias matched. Changes only inputs that failed or were wrong before; fuzz-proven identical otherwise. |
| B3 | P2 | **DONE** | Optional Arabic name/description on the existing product/service forms and CSV imports (draft only); the journey, notices and order summary use the merchant's **reviewed** Arabic names via `resolveItemNames`/the outbound name map (`LOCALIZATION_NAME_POLICY=human` widens to merchant/CSV drafts, never AI). |
| B4 | P1 | **DONE (flagged workspaces only)** | One-word / missing WhatsApp profile names: `nameGuard.oneWordLastname` gives a single-space last name in `shared/inbox.js`, `shared/referrals.js`, `shared/instagram.js` and `ops.createCustomer`; unflagged workspaces keep today's behaviour exactly. |

## C. Webhook, consent & status

| # | Pri | Status | Item |
|---|---|---|---|
| C1 | P1 | **DONE** | STOP/START/YES/NO replies and the bot replies of the existing handlers: via the outbound localiser (A6); the Arabic-keyword hook of the first build is unchanged. |
| C2 | P2 | OPEN | `message_template_status_update` webhook events are dropped by `/webhook`; status is polled (10 min while pending). An accelerator must not trust the payload (no `X-Hub-Signature-256` check exists) - re-read from Graph by id. Out of scope (G10). |
| C3 | P2 | **DONE (global)** | `handleStatusCallbacks` stores `CampaignMessage.errorCode` (String) when a failed callback carries `errors[0].code`; shown in the Arabic campaign recipients view and the legacy send report. |
| C4 | P2 | Documented | `LOCALIZATION_DISABLED=1` also switches off typed-Arabic handling except the exact Arabic opt-out keywords (compliance). The keyword hook is not gated by the per-merchant flag. An Arabic opt-out *button* tap still reaches the existing `optout_` handler. |

## D. Public pages

| # | Pri | Status | Item |
|---|---|---|---|
| D1 | P2 | **DONE** | The English `/pay/:id` and `/payment-result` pages show an Arabic switch link for flagged workspaces (`pages/switchLink.js`, third argument of `pageShell`); referral and Instagram links 302 to wa.me, so there is no page to link from (`?lang=ar` opens the Arabic landing page). |
| D2 | P3 | OPEN (nothing to translate) | There is no opt-in page, booking-confirmation page or customer-facing terms/privacy page (consent happens inside WhatsApp; legal documents are merchant-facing, English drafts behind login). Arabic legal text must come from the owner's lawyer, never machine-translated. `/payment-cancelled` stays English (decision). |

## E. Existing frontend (Phase 5 territory — not authorised)

The existing dashboard, Inbox, AI Mode, Promotions, Customers, Settings pages remain English/LTR (~1,470 hard-coded strings, 39 physical-direction CSS declarations, `index.html lang="en"`, `AppCurrencyPipe` fixed to `en-US`, `DialogService` English defaults, 38 raw backend status renders). The new `/arabic/inbox` and `/arabic/ai-mode` are parallel fully-localised pages; Smart Insights in Arabic appear only on `/arabic/ai-mode`. The menu entry "Arabic" is visible to all merchants (same precedent as Instagram/Referrals/Usage pages); non-enabled merchants see a "not switched on" card.

**DONE in the wiring phase (the spec section 4 composer/viewer items, as Arabic *controls* on English screens, flagged merchants only):** Promotions - Language panel in the launch area (live plan, counts per language, reasons for English fallbacks, selection shortcuts, Arabic preview and test send), confirm-dialog language note, entry-message panel and per-node strips in the conversation viewer; loyalty-reminder and Settings consent-request language notes; Flows - per-flow Arabic chip and read-only language matrix; Customers/Products/Services/Imports - the language and Arabic-name fields of B1/B3. Per decision G7 the existing composer has **no** per-send language selector (default = each customer's own language, shortcuts, link to `/arabic/campaigns/new`). The translated dashboard itself stays gated.

## F. Platform & operations

| # | Pri | Status | Item |
|---|---|---|---|
| F1 | P1 | OPEN (owner) | **Set `INTERNAL_ADMIN_USER` / `INTERNAL_ADMIN_PASSWORD` in Azure** (needed for `/internal-admin-localization`; the CLI script is the fallback). |
| F2 | P1 | OPEN (facts) | **WhatsApp account facts** (live read-only audit of the production WABA): business verification is `rejected` and the phone tier is `TIER_250` (≈250 unique customers per 24 h outside the service window); 15 of 250 template slots used; the legacy `utils/whatsapp.js#listTemplates()` reads only the newest 100 templates (no paging) - add cursor paging before the account approaches 100. New submissions stop at `LOCALIZATION_TEMPLATE_CEILING` (default 90). |
| F3 | P1 | OPEN (owner go-ahead) | **Controlled live probe** (writes to the production WABA): submit 3 throwaway templates + 1 self-addressed test message to confirm Arabic examples, direction marks (LRM/RLM) in text/parameters, UTILITY→MARKETING re-classification of the Arabic opt-in and rendering on iOS/Android (protocol in `META-REALITY.md`). Until then no direction marks are submitted and send-time LRM wrapping is off - **no Arabic Meta template has been proven live**. |
| F4 | P2 | OPEN | Entitlements/credit and AI-prompt metering aren't wired into **any** sender (English or Arabic); the Arabic sender and Arabic AI Mode are unmetered like their English counterparts. |
| F5 | P2 | OPEN | CI runs no tests/lint (backend and frontend). Add a job with a MongoDB service container + dummy env (see `README.md`, Testing) and `npm run check:i18n`. Out of scope for the wiring phase (G10). |
| F6 | P2 | OPEN (owner) | Verify whether the Meta app is subscribed to `message_template_status_update` / `template_category_update` (dashboard); decide if the webhook accelerator (C2) is wanted. |
| F7 | P3 | OPEN | Voice input for AI Mode: options, accuracy, cost and data-residency are in `VOICE-INPUT-OPTIONS.md`; **not built** (spec: propose only). |

## G. Security findings noticed during the audit (outside this build, but important)

1. `waflow-backend/.claude/settings.local.json` is **tracked in git and contains a literal Meta/WhatsApp Graph bearer token** — rotate the token and untrack the file.
2. `POST /send-message` (server.js) is unauthenticated and sends WhatsApp text/images from the platform number.
3. `POST /webhook` has no `X-Hub-Signature-256` verification; `GET /payment-cancelled?phone=` is unauthenticated and has side effects (clears carts, sends a WhatsApp message).
4. `cors()` is open to every origin; no `trust proxy` (so `req.ip` is the proxy address behind Azure); `mcp/oauth.js` interpolates request values into HTML unescaped; `AdminAuditLog.action` is a closed enum.
5. The 5 existing AI Mode chat tests, `orders.test.js` and 39 other test files delete rows and call real services — never run them against the shared database (the build's regression harness, kept outside the repository, ran them on a throwaway DB with dummy credentials; see `README.md`, Testing).

## H. Compliance-review follow-ups (2026-10-12)

The independent security review led to six compliance rules that are enforced and tested inside the localisation code (the UTILITY floor, same-phone opt-out, template-level stop, referral-page privacy, inert test sends, log-before-mutate for staff flag changes — see `README.md`, "Compliance rules the code enforces").

| # | Pri | Status | Item |
|---|---|---|---|
| H1 | P1 | **DONE (global)** | The `STOP` / `optout_` branches of `server.js` and the Arabic hook now opt out **every** customer record of the same workspace with the same normalised phone (`samePhone.optOutSamePhone`, one `ConsentEvent` per record logged first), which also protects the existing English senders. **Residual (P2):** a record created *after* the opt-out is not opted out (the Arabic planner/sender excludes it, the English senders do not); and `Customer.phone` still has no `(workspaceId, phone)` index, so each STOP runs an exact-spellings query plus a bounded fallback scan (capped at 20,000 customers, at most one scan per number per 60 s) - add the index in `models/Customer.js` if workspaces grow. |
| H2 | P2 | OPEN | **Compound index on `Customer (workspaceId, firstname, lastname, _id)` for Cosmos DB.** The deterministic name sort of the Arabic customer/language list needs it; without it the list falls back to the single-field `{ firstname: 1 }` sort (looser tie order; the page never fails). `models/Customer.js` is an existing file. |
| H3 | P2 | OPEN | **Erasure parity.** `LocalizedSend.phone` and (new) `LocalizedLegacySend.phone` keep the recipient number, exactly like `CampaignMessage` / `WhatsAppMessage` / `ConsentEvent`; the internal-admin erasure tool anonymises only the `Customer` record. If the lawyers want the number gone everywhere, the tool must also blank `phone` on those collections (`LocalizedSend.phone` is required, so write a placeholder such as `erased` rather than unsetting it; `LocalizedLegacySend.phone` is optional). Campaign documents themselves hold only counts. |
| H4 | P3 | OPEN | **Customer-page language precedence is `?lang`, then the stored customer language, then `Accept-Language`** (Instagram links: caption language before `Accept-Language`; referral links: the referrer's language as a last resort). The spec lists the stored customer language first; `?lang` goes first so the visible switch works. Confirm with the owner; flipping it is a small change in `pages/index.js#decidePageLanguage`. |
| H5 | P1 (legal) | OPEN | **A typed Arabic yes/no counts as consent within 24 h of ANY consent ask** unless another pending flow waits on that phone (`inboundHook.js hasPendingConsentAsk`, 24 h window; a typed reply carries no reference to the ask). Buttons (`consent_yes_<id>` / `consent_no_<id>`) are exact; a typed opt-out is always honoured. The lawyer should confirm that a typed word is acceptable evidence, or require the button tap. |
| H6 | P2 | **DONE** | Frontend follow-ups for the compliance rules (the `category_floored` warning, the readable `template_unusable:<code>` message, UTILITY offered only for the four transactional use cases). |

## I. Findings and limits of the wiring phase (new)

| # | Pri | Status | Item |
|---|---|---|---|
| I1 | P1 (owner decision) | OPEN (G6: report only) | **IB-13 - English Automated Flow rows lack `workspaceId`.** `utils/flowScheduler.js` creates `FlowEnrollment` and the flow `CampaignMessage` without `workspaceId` (the schema allows it) and the flow triggers query all tenants, while `handleStatusCallbacks`, `correlateClick` and `handleMessageNodeTap` filter by the webhook's workspace. Consequence, very likely today for English flows: no delivery/read ticks on flow messages, a button tap on a scheduler-sent flow message finds no row (no branching follow-up, no click), workspace-scoped enrollment lists miss the rows. Reproduced in the acceptance suite (a tap on the English scheduler-sent entry message sends no follow-up; Arabic rows carry the workspace and work). Not verified against production data. Fix = add `workspaceId: flow.workspaceId` to the enrollment and message creates (and scope the trigger queries), plus `scripts/backfill-workspace-id.js` (one-time, safe to re-run, covers `FlowEnrollment` and `CampaignMessage`) for old rows. English behaviour change => owner decision. |
| I2 | P3 | OPEN (existing defect) | `inbox.updateMessageStatus` is dead code: in `handleStatusCallbacks` the `continue` after `if (!cm) continue;` skips it for every status whose wamid is not a `CampaignMessage`, so manual WhatsApp Inbox sends never get delivery/read ticks (English or Arabic). |
| I3 | P3 | OPEN (existing defect) | The English pay-later button label "Reserve, Pay in Person" (`server.js`, 22 characters) is over WhatsApp's 20-character limit; the Arabic label is 18. Left alone (English unchanged). |
| I4 | P2 | OPEN (G9) | The fixed default flow templates (win-back, post-purchase, points nudge, no-show) have no Arabic overlay; an Arabic flow = a flow that sends a Promotion (the hub tells merchants). |
| I5 | P3 | OPEN (G8) | Carousel promotions are English-only (reported in the plan as `carousel_english_only`). |
| I6 | P3 | OPEN | **Entry-variant staleness gate:** an approved + reviewed Arabic flow entry template keeps sending after the English entry message is edited (only follow-ups are gated by a source hash). |
| I7 | P3 | OPEN (G7) | No per-send language override in the existing promotion composer; English-only / Arabic-only / bilingual sends use `/arabic/campaigns/new`. |
| I8 | P3 | OPEN | The price slot of an Arabic flow entry message is filled by the English formatter ("45.00 SAR"); the journey, notices and promotion sends use "45.00 ر.س". |
| I9 | P3 | OPEN | Typed opt-out edge cases: an Arabic digit *before* the keyword (`١ إلغاء`) and Latin `stop!` with punctuation are not recognised by the existing exact English `STOP` branch (the hook takes Arabic text or direction-marked Latin only). A missed opt-out is the worse error: consider widening. |
| I10 | P2 (legal) | OPEN | The Angular catalogues flag **no** string `needsLegalApproval`, although the AI notice (`ai.notice`) and the AI Mode disclaimer (`aimode.disclaimer`) need the lawyer (spec section 4: "wording approved by our lawyer"). The server catalogue flags 17. Flag the two in `catalogs/meta/ai.json` / `meta/aimode.json` (`"needsLegalApproval": true`) so the review tab counts them. |
| I11 | P3 | OPEN | The Arabic month names and currency symbols used in session texts (`senderValues.js`: `MONTHS_AR`, `ر.س`, `د.إ`) live in code, not in the review export; the native reviewer never sees them. |
