# Arabic localisation for KSA (Phases 0–4)

Built 2026-10-11/12 from the owner's requirements PDF ("Arabic Localisation for KSA"). **Phase 5 (a fully right-to-left dashboard) is gated and was NOT built** — everything new is language-ready so it can follow.

The brief was: *build it in separate files, don't touch existing code, don't break anything.* So the feature lives in **new files** (sidecar collections, new routers, new services, a new lazy Angular area `/arabic`) plus a handful of additive hooks. English stays the default and is unchanged for every merchant who doesn't switch Arabic on.

## What merchants get

| Spec phase | Where | What |
|---|---|---|
| 0 Foundation | `waflow-frontend/src/app/i18n/*` | language files (en/ar, 16 namespaces), locale formatting (SAR, Western digits, Gregorian dates), bidi helpers, `dir="auto"` / LTR phone directives, `lang`/`dir` on every hub page, a build check that fails on hard-coded strings in the new areas |
| 1 Customer-facing | `/arabic/customers`, `/arabic/templates`, `/arabic/catalog`; Arabic customer pages | per-customer language (+source, CSV import), per-language template variants with their own Meta approval and native-review status, Arabic opt-in/opt-out keywords and buttons, Arabic payment/referral/Instagram-link pages, Arabic product/service names |
| 2 Campaigns & flows | `/arabic/campaigns`, `/arabic/flows`, `/arabic/captions` | language selector (each customer's own / English / Arabic / bilingual), fallback preview before sending, per-language counts, AI translate + "Make this Saudi-friendly" (drafts only), RTL/bilingual WhatsApp previews, per-language approval badges, Arabic Instagram caption preview |
| 3 Inbox | `/arabic/inbox` | fully labelled Arabic inbox (auto-direction bubbles, Arabic-aware search, status values through keys), staff helpers "Translate" and "Reply in Arabic" (always confirmed) |
| 4 AI Mode | `/arabic/ai-mode` | Arabic/Gulf/mixed understanding, replies in the user's language, RTL chat, deterministic Arabic confirmation cards, localised Smart Insights; evaluation set + report in `AI-MODE-EVAL.md` |
| Cross-cutting | `/arabic/review`, `scripts/i18n-review*`, `/internal-admin-localization` | draft/reviewed workflow, CSV export/import for the native reviewer, unreviewed-string counts, per-merchant flag |

## Turning it on for a merchant

The feature is **off for everyone** until Waflow staff switch a merchant on (`LocaleSettings.arabicEnabled`, spec §8). Until then `/arabic` shows a "not switched on yet" card and every `/api/localization/*` route except `/settings` answers `402 ARABIC_NOT_ENABLED`.

1. Staff page: `https://<backend>/internal-admin-localization` (HTTP Basic with `INTERNAL_ADMIN_USER` / `INTERNAL_ADMIN_PASSWORD` — **these must be set in Azure**; if they are not, use step 2).
2. CLI: `node scripts/localization-flag.js list | status <workspaceId> | enable <workspaceId> --notes "KSA pilot" | disable <workspaceId>` (uses `MONGODB_URI` from `.env`; writes `LocaleSettings` + `LocalizationAdminLog`; never deletes).

Emergency switch: `LOCALIZATION_DISABLED=1` turns every localisation behaviour off without a redeploy (typed-Arabic keyword handling included, except the exact opt-out keywords — see `INTEGRATION-BACKLOG.md`).

## Architecture in one page

```
Angular  /arabic  (lazy)  ──►  /api/localization/*  (requireAuth + per-merchant flag)
   hub shell + 10 tabs          overview · customers · templates · campaigns · catalog · inbox · ai-mode · flows · captions · review
                                (API groups: customers · templates · campaigns · ai · catalog · inbox · ai-mode · flows · review · settings)
   i18n catalogues              services in shared/localization/*, models in models/Locali*.js + CustomerLanguage …
public pages  /pay /r /c /t ──►  routes/localization/pages.js  (mounted BEFORE the existing handlers; next() unless Arabic applies)
WhatsApp webhook  ───────────►  localization.handleInbound()  (one hook after the Inbox hook; returns false = existing flow continues)
scheduler  ──────────────────►  shared/localization/scheduler.js  (SchedulerLock; template status polling + resuming stuck campaigns)
```

* **Sidecar collections** (no existing model changed): `CustomerLanguage`, `LocaleSettings` (the flag + merchant defaults), `UserLocalePreference`, `LocalizedTemplate` (variants per language, each with Meta status + review status), `LocalizedCampaign`, `LocalizedSend` (one row per recipient — unique per campaign/customer so a retry can never double-send), `ProductTranslation`, `LocalizationAdminLog`.
* **One WhatsApp door**: everything the feature sends goes through `shared/localization/transport.js` (`LOCALIZATION_SEND_MODE=dry_run` = nothing leaves the process).
* **Never silently wrong**: a customer only receives a variant that is Meta-APPROVED **and** (for Arabic/bilingual) marked *reviewed* by a native reader. If it isn't, the plan shows the fallback/blocked count *before* sending and the merchant must acknowledge it.
* **AI is advisory**: translate / Saudi-friendly / reply-in-Arabic return drafts with the AI notice; nothing is applied or sent automatically; AI text is saved as `draft`.
* **Consent is compliance-critical**: marketing only to opted-in customers (`canSendMarketing`, using the *effective* category - Meta's report **and the UTILITY floor**, see below); the opt-out button is in the message's language; Arabic opt-out keywords are honoured immediately (normalised: tashkeel/tatweel/alef variants/Arabic-Indic digits).
* **Fail open**: every hook/middleware that sits in an existing flow catches its own errors and falls through to the existing behaviour.

## Compliance rules the code enforces (each one is pinned by tests)

1. **The UTILITY floor (consent rule).** A merchant must not be able to bypass marketing consent by labelling a marketing message UTILITY. Only the *transactional* use cases `payment_reminder`, `booking_confirmation`, `booking_reminder` and `order_confirmation` can ever be UTILITY. For every other use case (`promotion`, `comeback`, `loyalty_reminder`, `points_balance`, `points_expiring`, `referral_invite`, `referral_reward`, `greeting`, `welcome_optin`, `custom`, and anything unknown) the **effective category is MARKETING** - for audience eligibility, planning *and* sending - whatever category was requested and whatever Meta reports (`variants[].metaCategory` is still stored as reported). The list lives once, in `shared/localization/category.js`; `campaignPlanner.effectiveCategory()` applies it, the sender re-evaluates it on the freshly read template before **every** recipient (a use case edited mid-run tightens the rest of the run), and templates create / update / library-copy store MARKETING for those use cases (corrected, never rejected - the returned template carries the stored value; a legacy row that still says UTILITY is validated, shown and submitted to Meta as MARKETING). A plan for a non-transactional template that is stored as UTILITY, or that Meta reports as UTILITY, carries the warning `category_floored {useCase}` (the floor acted). `welcome_optin` keeps its documented consent-request exemption: it needs the opt-in **and** decline buttons, never goes to opted-out customers and is not re-sent within 7 days (the exemption is decided by the use case and is never gained mid-run).
2. **Same-phone opt-out.** `Customer.phone` is not unique and the existing opt-out paths (the `STOP` / `optout_` branches of `server.js` and the Arabic inbound hook) update only the *first* customer whose stored phone equals the sender's number, so a second record of the same person (`+966...` next to `966...`) would keep receiving. In a campaign, a recipient is excluded - and counted under `skipped.optedOut`, stored as `skipped_opted_out` with `errorCode opted_out_same_phone` - when **any** customer record of the same workspace with the same *normalised* phone is opted out (any stored format matches: `966...`, `+966...`, `00966...`, spaced, Arabic-Indic digits). Resolved with **one bulk read per audience** (the workspace's opted-out phones), not one per recipient; the sender re-checks it for every recipient with that list refreshed at most once a minute. Deliberately simple: only an *opted-out* sibling excludes (a sibling that merely lacks consent does not). It applies to the localised campaign planner/sender (and `sendSingle`); the existing English senders are not covered - see backlog H1.
3. **A template-level Meta failure stops the campaign.** Meta errors `132000`, `132001`, `132012`, `132015`, `132016`, `132018` mean the template or its parameters are unusable for everybody. After **3 consecutive** such answers the run ends: no further Meta call, the recipients not reached stay `queued`, and the campaign is closed as `failed` (nothing was sent) or `partial` with `lastError = template_unusable:<code>`. Rate-limit codes keep their back-off; any other outcome (a success, a recipient-level failure) resets the streak; recipients skipped without a Meta call neither count nor reset it.
4. **Public referral pages show no personal data of the referrer.** The Arabic `/r/:code` and `/c/:code` interstitial used to say "{referrer's first name} invited you" to anyone holding the link. It now shows only the business context - the merchant's business name (`Settings.merchantName`, else the workspace name unless it is the auto-generated "<x>'s Workspace"), the promotion name and the merchant-written friend-reward text - and the referrer's customer record is never read for the page. The referrer's stored *language* is still used, never displayed, as a last-resort hint for the page language.
5. **Test sends are inert.** The opt-out button of a template test-send carries the payload `l10ntest_optout`. The old `optout_test` was a *real* opt-out of whoever tapped it (both the existing handler and the Arabic hook dispatch on the `optout_` prefix).
6. **Staff flag changes are logged first.** `/internal-admin-localization` (and the CLI `scripts/localization-flag.js`) write the `LocalizationAdminLog` row **before** changing the flag (log-before-mutate, like `shared/consent.js`); if the row cannot be written the flag is left untouched and the operator gets a "nothing was changed" page. If the flag change itself fails after its row was written, the page says so (the row records the *attempt*; check the workspace page for the real state before retrying).

## Existing-file edits (all additive)

`server.js` (22 lines: 1 require, 3 try/catch-wrapped mounts — `/api/localization`, the customer-pages router before `/pay`, `/internal-admin-localization` — the webhook hook after the Inbox hook, the scheduler start) · frontend `app.routes.ts` (+1 lazy route `/arabic`) · `app.ts` (+1 menu entry "Arabic") · `package.json` (+`check:i18n`, `prebuild`).

## Environment variables (all optional unless noted)

| Variable | Default | Purpose |
|---|---|---|
| `LOCALIZATION_DISABLED` | off | `1` = kill switch for every localisation behaviour |
| `LOCALIZATION_SEND_MODE` | off | `dry_run` = log/record sends instead of calling WhatsApp (local verification) |
| `LOCALIZATION_TEMPLATE_CEILING` | `90` | stop submitting new template versions when WhatsApp reports this many templates (hard limit is 250; the legacy `listTemplates()` only reads 100) |
| `LOCALIZATION_WRAP_PARAM_LRM` | off | `1` = wrap Latin/number template *parameter values* in LRM at send time (off until a controlled Meta probe confirms it) |
| `LOCALIZATION_SCHEDULER_INTERVAL_MS` | `600000` | template-status polling / stuck-campaign recovery interval |
| `LOCALIZATION_ALLOW_DRAFT_PAGES` | allow | `0` = serve Arabic customer pages only when their copy is *reviewed* |
| `LOCALIZATION_AI_MODEL` | `claude-sonnet-5` | model for the AI helpers |
| `LOCALIZATION_AI_EFFORT` | `low` | thinking effort for the AI helpers (translate / Saudi-friendly / reply-in-Arabic) |
| `LOCALIZATION_DEBUG` | off | `1` = extra debug logging from the inbound WhatsApp hook (logs the last 4 digits of the phone number and the rewritten YES/NO/number token, nothing else) |
| `ANTHROPIC_API_KEY` | — | needed by the AI helpers and Arabic AI Mode (without it they answer 503 `AI_UNAVAILABLE`) |
| `INTERNAL_ADMIN_USER` / `INTERNAL_ADMIN_PASSWORD` | — | **required in Azure** for `/internal-admin-localization` |

## Native review (spec §8)

Every Arabic string starts as **draft**. Three places hold strings: the Angular catalogues (`src/app/i18n/catalogs/ar` + `meta`), the server catalogue (`shared/localization/catalog/*.json`) and per-merchant data (template variants, product names — reviewed inside the UI). Export for a spreadsheet and import back:

```
# screen text (frontend repo)
node scripts/i18n-review.mjs export --out review.csv      # key,english,arabic,status,reviewer,reviewed_at,needs_legal,notes
node scripts/i18n-review.mjs import --in review.csv --dry-run
node scripts/i18n-review.mjs summary --write              # refreshes the counts shown in /arabic/review

# server-sent messages (backend repo)
node scripts/i18n-review.js export --out backend-review.csv
node scripts/i18n-review.js import --in backend-review.csv --dry-run
```

Changed text never becomes "reviewed" by itself — only a row that says `reviewed` with a reviewer name does. Consent/opt-out/AI-notice strings are flagged `needsLegalApproval` (the owner's lawyer must approve them; never machine-translate legal text).

## Testing

* **Unit tests** (no database, no network): `MONGODB_URI=mongodb://127.0.0.1:1/waflow_unit_guard npx jest tests/localization --runInBand` (the dead URI is a safety net — never run the *existing* suite against the shared database: it deletes rows and calls real APIs).
* **Integration tests** (`tests/localization/integration/*.itest.js`) write real documents, so they run only against a throwaway local MongoDB, with dummy credentials and no network. Jest's default `testMatch` does not match `*.itest.js`, so `npm test` never runs them. Safe recipe (what the build used):
  1. Start an empty throwaway MongoDB on `127.0.0.1:27099` (for example `mongod --dbpath <empty temp dir> --port 27099 --bind_ip 127.0.0.1`).
  2. Copy the backend to a scratch folder **without** `.env`, `.wa-token-cache.json`, `.claude/` and `uploads/`; link or install `node_modules` there and add a dummy `.env` (every value fake) so no real credential is ever loaded.
  3. From that copy, with the network dead and WhatsApp sends in dry-run:

     ```
     HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost NODE_USE_ENV_PROXY=1 \
     MONGODB_URI=mongodb://127.0.0.1:27099/waflow_loc_test LOCALIZATION_SEND_MODE=dry_run AUTH_TEST_MODE=true \
     npx jest --runInBand --forceExit --testMatch "**/*.itest.js"
     ```

     `_guard.js` makes every integration test refuse to run unless `MONGODB_URI` is `mongodb://127.0.0.1:27099/waflow_loc_test*`. `englishUnchanged.itest.js` is a characterisation test (English behaviour identical with and without the localisation hooks): it needs a fresh, empty database name on every run and `ENG_GOLDEN_FILE` pointing at a recorded golden file (see its header; the golden is large and kept out of the repository).
* **Frontend**: `npx ngc -p tsconfig.app.json --noEmit`, `node scripts/check-i18n.mjs`, `npx ng test --no-watch --include "src/app/{i18n,pages/localization}/**/*.spec.ts"` (run from PowerShell on Windows).

References such as "R5 §6 IB-3" or "F5 §1" in these documents point at the build's working audit notes (`R1`–`R9` reconnaissance, `F1`–`F5` follow-ups), which are kept outside the repository; every conclusion that matters is restated in the page that cites it. The only follow-up written up as a repository document is `VOICE-INPUT-OPTIONS.md`.

See `INTEGRATION-BACKLOG.md` for what needs edits to existing files, `VOICE-INPUT-OPTIONS.md` for the (unbuilt) voice-input proposal, `META-REALITY.md` for what the live WhatsApp audit proved, `GLOSSARY.md` for the Arabic terminology/tone/orthography decisions, and `AI-MODE-EVAL.md` for the Arabic AI Mode evaluation.
