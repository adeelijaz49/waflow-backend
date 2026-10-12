'use strict';
// The flow the two Arabic link pages share: referral links (/r/:code, /c/:code) and
// Instagram tracking links (/t/:code). The English handlers answer both with an
// instant 302 to wa.me and record the click on that very request. The Arabic variant
// (spec §3.5) shows a short right-to-left page first, with one big button:
//   GET /r/CODE              -> the page. READ-ONLY: no click is recorded, so link
//                               previews, crawlers and people who just look cost nothing.
//   GET /r/CODE?lang=ar&go=1 (the button) -> the click is recorded by the SAME exported
//                               function the English handler calls (the counters are never
//                               reimplemented) and the visitor is redirected to wa.me with
//                               an Arabic prefilled text that still carries the Latin
//                               `Code: <TOKEN>` line the inbound detection needs.
// The commit happens after the language decision, never before (R7 §1.5 rule 4): once
// the click is recorded the English handler must not run (it would record it again),
// so every failure from there on is answered with an Arabic error page, never next().
// The tap needs nothing but the code's workspace (for the flag); everything the page
// itself shows (promotion, the merchant's business name...) is loaded lazily, by the page
// only. A page never shows personal data of whoever shared the link (referral.js, PRIVACY).
const layout = require('./layout');
const { fallThrough, page, isPlausibleCode, readAttribution, isGoRequest, rebuildWaLink, decidePageLanguage } = require('./index');

function notFoundPage(cfg, switchHref) {
  return layout.messagePage({ titleKey: 'common.notFound.title', bodyKey: cfg.notFoundBodyKey, switchHref });
}

function errorPage(switchHref) {
  return layout.messagePage({ titleKey: 'common.error.title', bodyKey: 'common.error.body', switchHref });
}

function unavailablePage(switchHref) {
  return layout.messagePage({ titleKey: 'common.unavailable.title', bodyKey: 'common.unavailable.body', switchHref });
}

// The side-effecting half: runs only when the plan is committed.
async function recordAndRedirect(req, deps, cfg, code, attribution, switchHref) {
  const result = await cfg.record(deps, {
    code,
    source: attribution.source,
    medium: attribution.medium || cfg.defaultMedium,
    ip: req.ip || (req.socket && req.socket.remoteAddress),
    userAgent: req.headers && req.headers['user-agent'],
  });
  if (!result) return page(404, notFoundPage(cfg, switchHref));
  // The business WhatsApp number could not be resolved (the English handler shows its
  // generic "link not found" here): say so honestly, and let the visitor retry.
  const target = rebuildWaLink(result.waLink, cfg.prefill(result, code));
  if (!target) return page(503, unavailablePage(switchHref));
  return { redirect: target };
}

// cfg: { groups, basePath(code), loadContext(deps, code) -> { workspaceId, getLanding(),
//          getHintLanguage? }, record(deps, args), defaultMedium, prefill(result, code),
//        titleKey, explainKey, notFoundBodyKey, introHtml(landing) (async), offerHtml(landing) }
// getLanding() -> { valid, ...whatever introHtml / offerHtml need }; called by the page only.
async function planLanding(req, deps, cfg) {
  const code = req.params.code;
  if (!isPlausibleCode(code)) return fallThrough('bad_code');
  const decision = await decidePageLanguage({ req, deps, groups: cfg.groups, loadContext: () => cfg.loadContext(deps, code) });
  if (decision.language !== 'ar') return fallThrough(decision.reason);

  const attribution = readAttribution(req);
  const base = cfg.basePath(code);
  const switchHref = `${base}${layout.queryString({ lang: 'en', src: attribution.source, medium: attribution.medium })}`;

  // On the tap the recorder is the authority (it answers null for a link that went stale
  // since the page was shown), so the page's own validity check is not repeated.
  if (isGoRequest(req)) {
    return {
      commit: () => recordAndRedirect(req, deps, cfg, code, attribution, switchHref),
      onError: () => page(500, errorPage(switchHref)),
    };
  }
  const landing = await decision.ctx.getLanding();
  if (!landing.valid) return page(404, notFoundPage(cfg, switchHref));
  const continueHref = `${base}${layout.queryString({ lang: 'ar', go: '1', src: attribution.source, medium: attribution.medium })}`;
  return page(200, layout.landingPage({
    titleKey: cfg.titleKey,
    introHtml: await cfg.introHtml(landing),
    offerHtml: cfg.offerHtml(landing),
    explainKey: cfg.explainKey,
    continueHref,
    switchHref,
  }));
}

// A code token inside a prefilled message: ASCII letters, digits and dashes only.
function codeToken(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^A-Za-z0-9_-]/g, '');
}

module.exports = { planLanding, codeToken };
