'use strict';
// Reverse matcher for the shopping journey / bot replies (backlog C1, A6, B3; design D3 sections 4-5).
//
// The existing journey messages are English literals in server.js and utils/whatsapp.js. Instead of editing ~56 call
// sites, ONE outbound localiser (outbound.js) looks at the WhatsApp payload on its way out and, for an Arabic customer of
// a flagged workspace, recognises the English message by its SHAPE (the catalogue's own English template with typed
// placeholders) and renders the Arabic catalogue entry with the captured values.
//
// This file is PURE: no I/O, no clock, no globals except the per-call context used while a payload is being matched.
//   createMatcher(entries) -> { localize(payload, ctx), translate(keys, text, ctx), has(key) }
//   entries: Map(key -> { en, ar, status })   (journey.*, consent.*, inbox.* of the catalogue)
//   ctx:     { names: { name(kind, raw), byId(kind, id), description(kind, name, englishDescription) }, payUrl(url) }
//
// STRICTNESS (what makes this safe): a message is translated only when EVERY translatable field of the payload matches
// its shape. One drifted English string (or a button the shape does not know) keeps the WHOLE message English, never a
// half-Arabic one. Templates and merchant free text never match. localize() returns null for "send the original".
const { wrapLtr, needsLtrProtection } = require('./arabicText');
const { markAllowed, insideFormatting } = require('./sessionBidi');
const { LIMITS, charLength } = require('./metaConstraints');

// ---- placeholder types (by placeholder name, overridable per catalogue key) ----
const RE = {
  int: '\\d+',
  num: '-?\\d+(?:\\.\\d+)?',
  money: '(?:[$£€]-?\\d+\\.\\d{2}|-?\\d+\\.\\d{2} \\S+)',
  plural: 's?',
  text: '[\\s\\S]+?',
  line: '[^\\n]+?',
  url: '\\S+',
  desc: '(?:\\n\\n[\\s\\S]+)?',
};
const BY_NAME = {
  n: 'int', need: 'int', have: 'int', after: 'int', cost: 'int', remaining: 'int', points: 'int', stock: 'int', pts: 'num', pct: 'num', duration: 'num',
  s: 'plural', price: 'money', sale: 'money', base: 'money', subtotal: 'money', shipping: 'money', amount: 'money',
  product: 'name', service: 'name', item: 'name', promo: 'line', date: 'line', time: 'line', start: 'line', end: 'line', total: 'money',
  address: 'text', url: 'url', link: 'url', desc: 'desc', slot: 'slot', cart: 'lines', items: 'lines', lines: 'lines',
  label: 'nested', intro: 'nested', examples: 'nested', lead: 'nested',
};
const OVERRIDE = { 'journey.added.points': { total: 'num' } };
const NESTED_KEYS = {
  label: ['journey.catalog.headerBrowse', 'journey.catalog.headerPoints', 'journey.catalog.headerSale'],
  intro: ['journey.catalog.textIntroPoints', 'journey.catalog.textIntroCash'],
  examples: ['journey.catalog.textExamples'],
  slot: ['journey.slot.range', 'journey.slot.at'],
};
const LINE_KEYS = {
  cart: ['journey.text.cartLine'],
  items: ['journey.text.itemLine'],
  lines: ['journey.catalog.textLinePoints', 'journey.catalog.textLineCash'],
};
const TRAILING_NL = new Set(['lines']); // the plain-text catalogue: every numbered line is followed by a newline

const FIELD_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function typeOf(key, name) { return (OVERRIDE[key] && OVERRIDE[key][name]) || BY_NAME[name] || 'text'; }
function reSource(type, name) {
  if (type === 'name') return RE.line;
  if (type === 'lines') return TRAILING_NL.has(name) ? '(?:[^\n]+\n)+' : '[^\n]+(?:\n[^\n]+)*';
  if (type === 'slot' || type === 'nested') return RE.text;
  return RE[type] || RE.text;
}

function compile(entries) {
  const out = new Map();
  for (const [key, e] of entries) {
    if (typeof e.en !== 'string' || !e.en) continue;
    let src = '^'; let last = 0; const names = [];
    for (const m of e.en.matchAll(FIELD_RE)) {
      src += esc(e.en.slice(last, m.index));
      const t = typeOf(key, m[1]);
      names.push({ name: m[1], type: t });
      src += `(${reSource(t, m[1])})`;
      last = m.index + m[0].length;
    }
    src += `${esc(e.en.slice(last))}$`;
    out.set(key, { key, names, re: new RegExp(src), en: e.en, ar: typeof e.ar === 'string' ? e.ar : '' });
  }
  return out;
}

// 150.00 SAR -> 150.00 ر.س ; AED -> د.إ ; any other token (a "$12.50", "100.00 AUD") is kept as the merchant's currency prints it.
// The integer part is grouped with ',' exactly like senderValues.formatMoney (1250.00 SAR -> 1,250.00 ر.س), so the shopping journey
// and the order / promotion notices write the same amount the same way.
function groupThousands(num) { return num.replace(/^(-?\d+)(\.\d+)$/, (all, int, dec) => `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${dec}`); }
function arMoney(tok) {
  let m = /^(-?\d+\.\d{2}) SAR$/.exec(tok); if (m) return `${groupThousands(m[1])} ر.س`;
  m = /^(-?\d+\.\d{2}) AED$/.exec(tok); if (m) return `${groupThousands(m[1])} د.إ`;
  return tok;
}

const K = (...a) => a.map((x) => `journey.${x}`);
const FAMILIES_BUTTON = [
  { id: 'goodChoice', body: K('goodChoice.body'), buttons: [[/^continue_shopping$/, K('btn.keepShopping')], [/^checkout(_.*)?$/, K('btn.checkout')]] },
  { id: 'added', body: K('added.cash', 'added.cashDiscount', 'added.points'), buttons: [[/^continue_shopping$/, K('btn.keepBrowsing')], [/^(checkout|points_checkout)$/, K('btn.checkout', 'btn.redeemPoints')]] },
  { id: 'more', body: K('more.body'), buttons: [[/^more_/, K('btn.seeNext')]] },
  { id: 'card', body: K('card.points', 'card.sale', 'card.plain'), buttons: [[/^cart_/, K('btn.addToCart', 'btn.redeem')]] },
  { id: 'payLater', body: K('payLater.body'), buttons: [[/^paylater_/, K('btn.payInPerson')]] },
];
const FAMILIES_LIST = [
  { id: 'catalogList', header: K('catalog.headerBrowse', 'catalog.headerPoints', 'catalog.headerSale'), body: K('catalog.bodyPoints', 'catalog.bodyCash'), footer: K('catalog.footerPoints', 'catalog.footerCash'), button: K('btn.viewProducts'), section: K('catalog.sectionPoints', 'catalog.sectionCash'), rowDesc: K('catalog.rowPoints', 'catalog.rowCash'), rowIdRe: /^cart_(.+)$/ },
  { id: 'variantList', header: K('variant.header'), body: K('variant.body'), footer: K('variant.footer'), button: K('btn.viewOptions'), section: K('variant.section'), rowDesc: K('variant.rowCash', 'variant.rowPoints'), special: 'variant' },
  { id: 'slotList', header: K('slots.headerBook', 'slots.headerRebook'), body: K('slots.bodyBook', 'slots.bodyRebook'), footer: K('slots.footer'), button: K('btn.viewSlots'), section: K('slots.section'), rowDesc: K('slots.rowLeft') },
];
const CONSENT_TEXT_KEYS = ['consent.optOutAck', 'consent.optInAck', 'consent.declineAck', 'consent.startAck', 'consent.startNoConsent'];

// WhatsApp limits in code points (the same counting as metaConstraints.charLength).
const lim = { text: 4096, body: LIMITS.BODY, header: LIMITS.HEADER, footer: LIMITS.FOOTER, button: LIMITS.BUTTON_LABEL, listButton: 20, section: 24, rowTitle: 24, rowDesc: 72 };
const ok = (s, n) => typeof s === 'string' && s.length > 0 && charLength(s) <= n;
const cut = (s, n) => (charLength(s) <= n ? s : Array.from(s).slice(0, n).join(''));

const PLAIN = new Set(['name', 'money', 'num', 'int', 'line', 'text']); // LRM-protect when Latin/digits only
const NESTED = new Set(['slot', 'nested', 'lines']); // placeholders that are themselves rendered from a catalogue entry

function createMatcher(entries) {
  const T = compile(entries);
  const textKeys = [...entries.keys()].filter((k) => /^journey\.text\./.test(k) && !/cartLine|itemLine/.test(k))
    .concat(CONSENT_TEXT_KEYS.filter((k) => entries.has(k)), entries.has('journey.slots.none') ? ['journey.slots.none'] : [], entries.has('inbox.paymentLink') ? ['inbox.paymentLink'] : []);

  // Per-call state (localize/translate are synchronous, so a module-level slot cannot interleave).
  let cx = null;
  let used = null;

  function match(key, str) {
    const t = T.get(key); if (!t || typeof str !== 'string') return null;
    const m = t.re.exec(str); if (!m) return null;
    const params = {}; t.names.forEach((n, i) => { params[n.name] = m[i + 1]; });
    return { t, params };
  }
  function matchAny(keys, str) { for (const k of keys) { const r = match(k, str); if (r) return { key: k, ...r }; } return null; }

  // Arabic string for one captured parameter; null = cannot (the whole message stays English).
  function arParam(name, type, raw, params, plain) {
    switch (type) {
      case 'name': return cx.names.name(name === 'service' ? 'service' : 'product', raw);
      case 'money': return arMoney(raw);
      case 'num': case 'int': case 'line': case 'text': case 'plural': return raw;
      case 'url': return cx.payUrl(raw);
      case 'desc': return raw ? `\n\n${cx.names.description('product', params.product, raw.slice(2))}` : '';
      case 'slot': { const r = matchAny(NESTED_KEYS.slot, raw); return r ? renderMatch(r, plain) : null; }
      case 'nested': { const r = matchAny(NESTED_KEYS[name] || [], raw); return r ? renderMatch(r, plain) : null; }
      case 'lines': {
        const trailing = TRAILING_NL.has(name);
        const parts = raw.split('\n'); if (trailing) { if (parts.pop() !== '') return null; }
        const outLines = [];
        for (const line of parts) {
          const r = matchAny(LINE_KEYS[name] || [], line); if (!r) return null;
          const s = renderMatch(r, plain); if (s === null) return null; outLines.push(s);
        }
        return outLines.join('\n') + (trailing ? '\n' : '');
      }
      default: return raw;
    }
  }

  // plain = render WITHOUT any direction mark (a nested placeholder that sits inside *bold* / _italic_).
  function renderMatch(r, plain) {
    if (!r.t.ar) return null; // no Arabic text for this entry: stay English
    const raw = {}; const type = {};
    for (const n of r.t.names) {
      const v = arParam(n.name, n.type, r.params[n.name], r.params, plain);
      if (v === null || v === undefined) return null;
      raw[n.name] = v; type[n.name] = n.type;
    }
    let missing = false;
    // ONE bidi rule (sessionBidi.js, review R3-04): no direction mark when the character before OR after the placeholder is * or _
    // (WhatsApp's bold / italic delimiters), and the output of a NESTED placeholder is never marked inside such a pair.
    const text = r.t.ar.replace(FIELD_RE, (m, name, offset, whole) => {
      if (!(name in raw)) { if (name === 's') return ''; missing = true; return m; }
      if (NESTED.has(type[name])) {
        if (!plain && !insideFormatting(whole, offset, m.length)) return raw[name];
        const bare = arParam(name, type[name], r.params[name], r.params, true);
        if (bare === null || bare === undefined) { missing = true; return m; }
        return bare;
      }
      const v = raw[name];
      return !plain && PLAIN.has(type[name]) && needsLtrProtection(v) && markAllowed(whole, offset, m.length) ? wrapLtr(v) : v;
    });
    if (missing) return null;
    if (used) used.add(r.key);
    return text;
  }

  function translateIn(keys, str) {
    const r = matchAny(keys, str); if (!r) return null;
    const text = renderMatch(r); if (text === null) return null;
    return { key: r.key, text };
  }

  function consentCarrier(payload) {
    const it = payload.interactive;
    const sfxE = entries.get('consent.askSuffix'); const yesE = entries.get('consent.buttonOptIn'); const noE = entries.get('consent.buttonDecline');
    if (!sfxE || !yesE || !noE || !sfxE.ar || !yesE.ar || !noE.ar) return null;
    const body = it.body && it.body.text; if (typeof body !== 'string' || !body.endsWith(`\n\n${sfxE.en}`)) return null;
    const btns = it.action && it.action.buttons;
    if (!Array.isArray(btns) || btns.length !== 2 || !/^consent_yes_/.test(btns[0].reply.id) || !/^consent_no_/.test(btns[1].reply.id)) return null;
    if (btns[0].reply.title !== yesE.en || btns[1].reply.title !== noE.en) return null;
    const lead = translateIn(textKeys, body.slice(0, -(sfxE.en.length + 2))); if (!lead) return null;
    const out = JSON.parse(JSON.stringify(payload));
    out.interactive.body.text = `${lead.text}\n\n${sfxE.ar}`;
    out.interactive.action.buttons[0].reply.title = yesE.ar;
    out.interactive.action.buttons[1].reply.title = noE.ar;
    if (!ok(out.interactive.body.text, lim.body)) return null;
    ['consent.askSuffix', 'consent.buttonOptIn', 'consent.buttonDecline'].forEach((k) => used.add(k));
    return { shape: `consentCarrier(${lead.key})`, payload: out };
  }

  function localizeButtons(payload) {
    const it = payload.interactive;
    const carrier = consentCarrier(payload); if (carrier) return carrier;
    const bodyText = it.body && it.body.text; const buttons = it.action && it.action.buttons;
    if (typeof bodyText !== 'string' || !Array.isArray(buttons)) return null;
    for (const fam of FAMILIES_BUTTON) {
      const b = translateIn(fam.body, bodyText); if (!b) continue;
      if (buttons.length !== fam.buttons.length) continue;
      const outButtons = []; let good = true;
      buttons.forEach((btn, i) => {
        const [idRe, keys] = fam.buttons[i]; const id = btn && btn.reply && btn.reply.id;
        if (typeof id !== 'string' || !idRe.test(id)) { good = false; return; }
        const t = translateIn(keys, btn.reply.title); if (!t || !ok(t.text, lim.button)) { good = false; return; }
        outButtons.push({ ...btn, reply: { ...btn.reply, title: t.text } });
      });
      if (!good || !ok(b.text, lim.body)) continue;
      const out = JSON.parse(JSON.stringify(payload)); out.interactive.body.text = b.text; out.interactive.action.buttons = outButtons;
      return { shape: `${fam.id}(${b.key})`, payload: out };
    }
    return null;
  }

  function localizeList(payload) {
    const it = payload.interactive;
    if (!it.action || !Array.isArray(it.action.sections)) return null;
    for (const fam of FAMILIES_LIST) {
      const body = translateIn(fam.body, it.body && it.body.text); if (!body) continue;
      const out = JSON.parse(JSON.stringify(payload)); let good = ok(body.text, lim.body); out.interactive.body.text = body.text;
      const one = (keys, getter, setter, n) => {
        const v = getter(); if (v === undefined) return;
        const t = translateIn(keys, v); if (!t || !ok(t.text, n)) { good = false; return; }
        setter(t.text);
      };
      if (it.header) one(fam.header, () => it.header.text, (x) => { out.interactive.header.text = x; }, lim.header);
      if (it.footer) one(fam.footer, () => it.footer.text, (x) => { out.interactive.footer.text = x; }, lim.footer);
      one(fam.button, () => it.action.button, (x) => { out.interactive.action.button = x; }, lim.listButton);
      it.action.sections.forEach((sec, si) => {
        one(fam.section, () => sec.title, (x) => { out.interactive.action.sections[si].title = x; }, lim.section);
        (sec.rows || []).forEach((row, ri) => {
          const o = out.interactive.action.sections[si].rows[ri];
          if (fam.special === 'variant' && /^variant_.+_base$/.test(row.id)) {
            const npE = entries.get('journey.variant.noPreference'); const npdE = entries.get('journey.variant.noPreferenceDesc');
            if (!npE || !npdE || !npE.ar || !npdE.ar || row.title !== npE.en || row.description !== npdE.en) { good = false; return; }
            o.title = npE.ar; o.description = npdE.ar; used.add('journey.variant.noPreference'); used.add('journey.variant.noPreferenceDesc'); return;
          }
          if (fam.special === 'variant') {
            const m = match('journey.variant.optionN', row.title);
            if (m) { const s = renderMatch({ key: 'journey.variant.optionN', ...m }); if (s !== null) o.title = s; }
          }
          const idm = fam.rowIdRe && fam.rowIdRe.exec(row.id);
          if (idm) { const nm = cx.names.byId('product', idm[1]); if (nm) o.title = cut(nm, lim.rowTitle); }
          if (row.description !== undefined) {
            const t = translateIn(fam.rowDesc, row.description);
            if (!t || !ok(t.text, lim.rowDesc)) { good = false; return; }
            o.description = t.text;
          }
          if (!ok(o.title, lim.rowTitle)) good = false;
        });
      });
      if (!good) return null;
      return { shape: fam.id, payload: out };
    }
    return null;
  }

  // -> { shape, payload, keys:[catalogue keys used] } | null (null = send the ORIGINAL payload untouched). Never throws on a
  // well-formed or malformed payload: any exception is the caller's fail-open.
  function localize(payload, ctx) {
    cx = ctx; used = new Set();
    try {
      if (!payload || payload.messaging_product !== 'whatsapp' || typeof payload.to !== 'string') return null;
      let res = null;
      if (payload.type === 'text') {
        const body = payload.text && payload.text.body; if (typeof body !== 'string') return null;
        const r = translateIn(textKeys, body);
        if (r && ok(r.text, lim.text)) res = { shape: r.key, payload: { ...payload, text: { ...payload.text, body: r.text } } };
      } else if (payload.type === 'interactive' && payload.interactive) {
        if (payload.interactive.type === 'button') res = localizeButtons(payload);
        else if (payload.interactive.type === 'list') res = localizeList(payload);
      }
      return res ? { ...res, keys: [...used] } : null;
    } finally { cx = null; used = null; }
  }

  // Public single-string helper (tests, tooling): -> { key, text } | null
  function translate(keys, text, ctx) {
    cx = ctx; used = new Set();
    try { return translateIn(keys, text); } finally { cx = null; used = null; }
  }

  return { localize, translate, has: (k) => T.has(k) };
}

// The catalogue namespaces the matcher reads: journey.* (own), consent.* and inbox.* (reused, never duplicated).
function entriesFromCatalog(catalog) {
  const all = catalog.load();
  const out = new Map();
  for (const [key, e] of all) if (/^(journey|consent|inbox)\./.test(key)) out.set(key, { en: e.en, ar: e.ar, status: e.status });
  return out;
}

module.exports = { createMatcher, entriesFromCatalog, arMoney };
