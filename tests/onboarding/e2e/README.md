# Onboarding sandbox tooling (task I1b)

Everything in this folder is SANDBOX ONLY. It is never required by `server.js` or by the application, and every entry point
refuses to run unless all three guards hold (`sandbox.js`):

1. `MONGODB_URI` is `mongodb://127.0.0.1:27099/waflow_loc_test*` (the throwaway mongod),
2. the outbound proxy is the dead harness proxy (`HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:9`, `NODE_USE_ENV_PROXY=1`),
3. the working directory is a sandbox copy of the backend (`.../scratchpad/regress/...`), never the repo (its `.env` holds real credentials).

Run from a sandbox copy made with `node <scratchpad>/regress/make-after.mjs <sandbox dir> <fresh db name>`.

| file | what |
|---|---|
| `boot.js` | installs the fakes (Graph through an axios adapter bridge, Stripe through the `stripe` module constructor for ONE sandbox key, Resend through a stub of the `resend` module), sets the dummy environment (`ONBOARDING_FLOW=on`, checkout on, dummy keys), then requires the REAL `server.js` |
| `multiGraph.js` | several FakeGraph instances behind one Graph port, routed by the merchant token; the platform token (legacy senders) hits a recorder, so "nothing used the platform number" is assertable |
| `server.js` | the launcher: real app on `E2E_PORT` (3100) + the control endpoint on `E2E_CONTROL_PORT` (3199, 127.0.0.1) |
| `control.js` | the control endpoint: Graph scenarios / template statuses / display-name decisions / token revocation, a fresh "target" fake for the next connect, signed Stripe and Meta webhooks, sweep, e-mail failure injection, whitelisted env switches (legacy send policy ...), call logs, DB counters, forged-role tokens, `{sandbox:true, db}` on `/__control/health` |
| `seed.js` | seeds an EMPTY database with the 13 workspaces of DF section 9 through the real modules and the real HTTP surface; writes ids, tokens and the per-workspace fake options to a JSON file |
| `dump-contract.js` | seeds a fresh database, calls every GET and the key POST answers per workspace, writes the JSON bodies to a directory and scans them for secrets |

Typical browser-test session: `node tests/onboarding/e2e/seed.js` (writes `E2E_SEED_FILE`), then
`E2E_SEED_FILE=... node tests/onboarding/e2e/server.js` against the SAME database (the launcher rebuilds one fake WhatsApp
account per seeded connection, token revocation of W6 included). The seed refuses a database that already has workspaces:
use a fresh database name per run (no deletes, ever).
