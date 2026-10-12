'use strict';
// Arabic landing page for Instagram tracking links (/t/:code, the link in a post's bio
// or caption). The shared interstitial / click / redirect flow lives in landing.js; this
// file supplies what is specific to Instagram promotions:
//   * the read-only lookup that ties a code to its workspace (for the rollout flag) and,
//     for the page only, to its post (the existing recorder answers null when the link
//     or the post is missing);
//   * the Arabic prefilled WhatsApp text, which keeps the Latin `Code: IG-XXXXXXXX` line
//     shared/instagram.js's inbound detection matches (/code:\s*(IG-[A-Z0-9]{8})/i).
// There is no customer behind a tracking link, so only ?lang= and Accept-Language decide
// the language.
const catalog = require('../catalog');
const { detectLanguage } = require('../languageDetect');
const layout = require('./layout');
const { planLanding, codeToken } = require('./landing');

const GROUPS = ['common', 'instagram'];

async function loadTrackingContext(deps, code) {
  const { TrackingLink, InstagramPost } = deps.models;
  const link = await TrackingLink.findOne({ code }).select('workspaceId instagramPostId').lean();
  if (!link) return { workspaceId: await deps.oldestWorkspaceId(), getLanding: async () => ({ valid: false }) };
  const workspaceId = String(link.workspaceId);
  // One read serves both the language decision (caption) and the page (name), and is
  // taken at most once per request.
  let postRead = null;
  const readPost = () => {
    if (!postRead) {
      postRead = link.instagramPostId
        ? Promise.resolve(InstagramPost.findOne({ _id: link.instagramPostId, workspaceId }).select('name caption promotionCode').lean())
        : Promise.resolve(null);
    }
    return postRead;
  };
  return {
    workspaceId,
    // An Arabic caption means the audience reads Arabic (META-REALITY section 11). The
    // prefilled "Code: IG-..." text is never consulted: it is English for everybody.
    getContentLanguage: async () => {
      const post = await readPost();
      return post && post.caption && detectLanguage(post.caption).language === 'ar' ? 'ar' : null;
    },
    getLanding: async () => {
      const post = await readPost();
      return { valid: !!post, post };
    },
  };
}

// The promotion name is merchant-written free text: single line, shortened, and any
// "code:" inside it removed, so the first "Code:" in the message is always the real one
// (the inbound regex takes the first match).
function promotionName(post) {
  return layout.cleanText(String((post && post.name) || '').replace(/code\s*:/gi, ' '), 80);
}

// Arabic sentence (Latin names are protected from reordering by the catalogue's LRM
// wrapping), then the Latin token on its own line, exactly like the referral text.
function instagramPrefill(result) {
  const post = (result && result.post) || {};
  const name = promotionName(post);
  const sentence = name
    ? catalog.t('ar', 'pages.instagram.prefill', { name })
    : catalog.t('ar', 'pages.instagram.prefillGeneric');
  const token = codeToken(post.promotionCode);
  return token ? `${sentence}\nCode: ${token}` : sentence;
}

function planTracking(req, deps) {
  return planLanding(req, deps, {
    groups: GROUPS,
    basePath: (code) => `/t/${encodeURIComponent(code)}`,
    loadContext: loadTrackingContext,
    record: (d, args) => d.recordTrackingClick(args),
    defaultMedium: undefined,
    prefill: instagramPrefill,
    titleKey: 'instagram.title',
    explainKey: 'instagram.explain',
    notFoundBodyKey: 'instagram.notFound.body',
    introHtml: async () => '',
    offerHtml: (landing) => {
      const name = landing.post ? layout.cleanText(landing.post.name, 120) : '';
      return name ? layout.fill('common.offer', { offer: layout.bdi(name, 120) }) : '';
    },
  });
}

module.exports = { planTracking, loadTrackingContext, instagramPrefill, promotionName };
