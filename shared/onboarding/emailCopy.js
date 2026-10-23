'use strict';
// E-mail copy of the onboarding notifications (DB design 7.1), English + Arabic.
//   render(kind, language, params) -> { subject, html, text }
// Rules (HARD): every interpolated value is HTML-escaped (esc); subjects are static; links are
// built from config.frontendUrl(); no phone number, token, e-mail address or workspace name is
// ever put in a mail (the few dynamic detail values are cleaned and anything that looks like a
// phone number / e-mail / token is dropped); payment copy carries only the neutral line about
// Meta fees. Arabic copy is a DRAFT (docs/localization/GLOSSARY.md): never mark it reviewed here.
// Pure module: no I/O, nothing executed at require time.
const config = require('./config');

/** Review status of every Arabic string below (a native reader marks them reviewed, never code). */
const ARABIC_STATUS = 'draft';

const FEES_EN = 'WhatsApp message fees are charged by Meta to your own Meta account.';
const FEES_AR = 'تُحتسب رسوم رسائل واتساب من قِبل Meta على حسابك الخاص في Meta.';

const FOOTER = {
  en: 'You are receiving this email because of your WaFlow setup.',
  ar: 'وصلتك هذه الرسالة بسبب إعدادك في WaFlow.',
};
const FOOTER_PATHB = {
  en: 'We send this reminder by email and in the app, never on WhatsApp.',
  ar: 'نرسل هذا التذكير عبر البريد الإلكتروني وداخل التطبيق، وليس عبر واتساب.',
};
const DETAILS_LABEL = { en: 'Details', ar: 'التفاصيل' };
const DETAIL_KEYS = Object.freeze([
  ['templateKey', { en: 'Template', ar: 'القالب' }],
  ['reason', { en: 'Reason', ar: 'السبب' }],
  ['tier', { en: 'Limit', ar: 'الحد' }],
  ['decision', { en: 'Decision', ar: 'القرار' }],
  ['status', { en: 'Status', ar: 'الحالة' }],
]);
// The Step 4 status words of the notifications (verification_changed / display_name_decided carry params.status = done | waiting |
// needs_you | unknown): shown with the words of the checklist ("Done", "Waiting on Meta", "Needs you") instead of the raw token.
// 'unknown' says nothing, so no status line is shown. Any other value is shown as it is (cleaned like every detail).
const STATUS_WORDS = Object.freeze({
  done: { en: 'Done', ar: 'تم' },
  waiting: { en: 'Waiting on Meta', ar: 'بانتظار Meta' },
  needs_you: { en: 'Needs you', ar: 'يحتاج إلى إجراء منك' },
});
const PROGRESS_LABEL = { en: 'Approved', ar: 'المعتمد' };

// kind -> { en, ar } each { subject, title, body: string[], cta, fees?: true, footer?: 'pathb' }
const COPY = {
  payment_failed: {
    en: {
      subject: "Your WaFlow payment didn't go through",
      title: "Your payment didn't go through",
      body: ["We couldn't take your latest subscription payment.", 'Update your payment details to keep going. Your setup progress is saved.'],
      cta: 'Update payment',
      fees: true,
    },
    ar: {
      subject: 'لم تنجح عملية الدفع في WaFlow',
      title: 'لم تنجح عملية الدفع',
      body: ['لم نتمكن من استلام دفعة اشتراكك الأخيرة.', 'حدّث بيانات الدفع لتتابع. تقدمك في الإعداد محفوظ.'],
      cta: 'تحديث الدفع',
      fees: true,
    },
  },
  subscription_active: {
    en: {
      subject: 'Your WaFlow subscription is active',
      title: 'Your subscription is active',
      body: ['You can start setting up WhatsApp now.'],
      cta: 'Continue setup',
    },
    ar: {
      subject: 'اشتراكك في WaFlow فعّال',
      title: 'اشتراكك فعّال',
      body: ['يمكنك الآن البدء في إعداد واتساب.'],
      cta: 'متابعة الإعداد',
    },
  },
  subscription_cancelled: {
    en: {
      subject: 'Your WaFlow subscription has ended',
      title: 'Your subscription has ended',
      body: ['Your data and progress are saved.', 'You can come back at any time.'],
      cta: 'Open WaFlow',
    },
    ar: {
      subject: 'انتهى اشتراكك في WaFlow',
      title: 'انتهى اشتراكك',
      body: ['بياناتك وتقدمك محفوظان.', 'يمكنك العودة في أي وقت.'],
      cta: 'فتح WaFlow',
    },
  },
  connected: {
    en: {
      subject: 'WhatsApp is connected to WaFlow',
      title: 'WhatsApp is connected',
      body: ['Your WhatsApp Business account is now connected to WaFlow.', 'While Meta checks your account, add your customers and products.'],
      cta: 'Continue setup',
    },
    ar: {
      subject: 'تم ربط واتساب مع WaFlow',
      title: 'تم ربط واتساب',
      body: ['تم ربط حساب واتساب للأعمال الخاص بك مع WaFlow.', 'أثناء تحقق Meta من حسابك، أضف عملاءك ومنتجاتك.'],
      cta: 'متابعة الإعداد',
    },
  },
  reconnect_needed: {
    en: {
      subject: 'Reconnect WhatsApp to keep sending',
      title: 'Reconnect WhatsApp to keep sending',
      body: ['Your WhatsApp connection stopped working.', 'Reconnect it in a few minutes so your messages can go out.'],
      cta: 'Reconnect WhatsApp',
    },
    ar: {
      subject: 'أعد ربط واتساب لمتابعة الإرسال',
      title: 'أعد ربط واتساب لمتابعة الإرسال',
      body: ['توقف اتصال واتساب لديك عن العمل.', 'أعد الربط خلال دقائق لتتمكن رسائلك من الانطلاق.'],
      cta: 'إعادة ربط واتساب',
    },
  },
  verification_changed: {
    en: {
      subject: 'Your business verification was updated',
      title: 'Business verification updated',
      body: ['Meta updated the verification status of your business.', 'Open your setup to see what changed.'],
      cta: 'See what changed',
    },
    ar: {
      subject: 'تم تحديث التحقق من نشاطك التجاري',
      title: 'تم تحديث التحقق من النشاط التجاري',
      body: ['حدّثت Meta حالة التحقق من نشاطك التجاري.', 'افتح الإعداد لترى ما الذي تغيّر.'],
      cta: 'عرض التغييرات',
    },
  },
  display_name_decided: {
    en: {
      subject: 'Meta decided on your display name',
      title: 'Display name decision',
      body: ['Meta made a decision about the name your customers see on WhatsApp.', 'Open your setup to see the decision.'],
      cta: 'See the decision',
    },
    ar: {
      subject: 'اتخذت Meta قراراً بشأن اسم العرض',
      title: 'قرار بشأن اسم العرض',
      body: ['اتخذت Meta قراراً بشأن الاسم الذي يراه عملاؤك على واتساب.', 'افتح الإعداد لترى القرار.'],
      cta: 'عرض القرار',
    },
  },
  messaging_limit_changed: {
    en: {
      subject: 'Your messaging limit changed',
      title: 'Your messaging limit changed',
      body: ['Meta changed how many customers you can message each day.', 'Open your setup to see your new limit.'],
      cta: 'See your new limit',
    },
    ar: {
      subject: 'تغيّر حد الرسائل لديك',
      title: 'تغيّر حد الرسائل لديك',
      body: ['غيّرت Meta عدد العملاء الذين يمكنك مراسلتهم يومياً.', 'افتح الإعداد لترى الحد الجديد.'],
      cta: 'عرض الحد الجديد',
    },
  },
  template_approved: {
    en: {
      subject: 'A message template was approved',
      title: 'A message template was approved',
      body: ['Meta approved one of your message templates.', 'It is ready to use.'],
      cta: 'View templates',
    },
    ar: {
      subject: 'تم اعتماد قالب رسالة',
      title: 'تم اعتماد قالب رسالة',
      body: ['اعتمدت Meta أحد قوالب الرسائل لديك.', 'أصبح جاهزاً للاستخدام.'],
      cta: 'عرض القوالب',
    },
  },
  template_rejected: {
    en: {
      subject: 'A message template was rejected',
      title: 'A message template was rejected',
      body: ['Meta did not approve one of your message templates.', 'Open your setup to see why and try again.'],
      cta: 'See why',
    },
    ar: {
      subject: 'تم رفض قالب رسالة',
      title: 'تم رفض قالب رسالة',
      body: ['لم تعتمد Meta أحد قوالب الرسائل لديك.', 'افتح الإعداد لترى السبب وتحاول مرة أخرى.'],
      cta: 'عرض السبب',
    },
  },
  pathb_reminder: {
    en: {
      subject: 'Come back when your number is ready',
      title: 'Come back when your number is ready',
      body: ['Your WaFlow setup is saved and waiting for you.', 'When you have your WhatsApp number, pick up where you left off.'],
      cta: 'Continue setup',
      footer: 'pathb',
    },
    ar: {
      subject: 'عد عندما يصبح رقمك جاهزاً',
      title: 'عد عندما يصبح رقمك جاهزاً',
      body: ['إعدادك في WaFlow محفوظ وبانتظارك.', 'عندما يصبح رقم واتساب جاهزاً، تابع من حيث توقفت.'],
      cta: 'متابعة الإعداد',
      footer: 'pathb',
    },
  },
  sending_paused: {
    en: {
      subject: 'Sending is paused',
      title: 'Sending is paused',
      body: ['Sending from your WhatsApp account is paused.', 'Open the page to see why and how to fix it.'],
      cta: 'See how to fix it',
    },
    ar: {
      subject: 'الإرسال متوقف مؤقتاً',
      title: 'الإرسال متوقف مؤقتاً',
      body: ['الإرسال من حساب واتساب الخاص بك متوقف مؤقتاً.', 'افتح الصفحة لترى السبب وكيفية الإصلاح.'],
      cta: 'عرض طريقة الإصلاح',
    },
  },
  account_alert: {
    en: {
      subject: 'A WhatsApp account alert',
      title: 'A WhatsApp account alert',
      body: ['Meta flagged something on your WhatsApp account.', 'Open your setup for details.'],
      cta: 'See details',
    },
    ar: {
      subject: 'تنبيه بشأن حساب واتساب',
      title: 'تنبيه بشأن حساب واتساب',
      body: ['أشارت Meta إلى أمر يخص حساب واتساب لديك.', 'افتح الإعداد للتفاصيل.'],
      cta: 'عرض التفاصيل',
    },
  },
  help_received: {
    en: {
      subject: 'We got your request',
      title: 'We got your request',
      body: ['Thanks, we received your help request.', "We'll be in touch by email."],
      cta: 'Open WaFlow',
    },
    ar: {
      subject: 'استلمنا طلبك',
      title: 'استلمنا طلبك',
      body: ['شكراً، استلمنا طلب المساعدة.', 'سنتواصل معك عبر البريد الإلكتروني.'],
      cta: 'فتح WaFlow',
    },
  },
};

// The two MILESTONE mails of kind template_approved (starterTemplates.notifyTemplateMilestones). Approvals are coalesced: each one is only
// an in-app notification; the merchant gets an e-mail when the FIRST starter template is approved and when EVERY English starter
// template is approved. The variant is chosen from the notification's params { count, total } (see templateMilestone): no template
// name, no phone number and nothing else is ever put in these mails. The generic COPY.template_approved text above is what any other
// template_approved notification (without those params) renders.
const TEMPLATE_MILESTONES = {
  first: {
    en: {
      subject: 'Your first message template was approved',
      title: 'Your first message template was approved',
      body: ['Meta approved the first of your starter message templates.', 'Open your setup to see where the others stand. You can keep setting up while you wait.'],
      cta: 'View templates',
    },
    ar: {
      subject: 'تم اعتماد أول قالب رسالة لديك',
      title: 'تم اعتماد أول قالب رسالة لديك',
      body: ['اعتمدت Meta أول قالب من قوالب الرسائل الأولية الخاصة بك.', 'افتح الإعداد لترى حالة بقية القوالب. يمكنك متابعة الإعداد أثناء الانتظار.'],
      cta: 'عرض القوالب',
    },
  },
  all: {
    en: {
      subject: 'Your starter message templates are approved',
      title: 'Your starter message templates are approved',
      body: ['Meta approved all of the English starter message templates we sent for you.', 'Open your setup to see what is ready.'],
      cta: 'View templates',
    },
    ar: {
      subject: 'تم اعتماد قوالب الرسائل الأولية لديك',
      title: 'تم اعتماد قوالب الرسائل الأولية لديك',
      body: ['اعتمدت Meta جميع قوالب الرسائل الأولية باللغة الإنجليزية التي أرسلناها لك.', 'افتح الإعداد لترى ما هو جاهز.'],
      cta: 'عرض القوالب',
    },
  },
};

// Fallback for a kind this module does not know (render never throws).
const UNKNOWN = {
  en: { subject: 'Update on your setup', title: 'Update on your setup', body: ["Open your setup to see what's new."], cta: 'Open WaFlow' },
  ar: { subject: 'تحديث على إعدادك', title: 'تحديث على إعدادك', body: ['افتح الإعداد لترى المستجدات.'], cta: 'فتح WaFlow' },
};

const KINDS = Object.freeze(Object.keys(COPY));
const DEFAULT_PATH = '/setup';
const PATH_RE = /^\/[A-Za-z0-9/_-]{0,120}$/;

const HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape any value (null/undefined -> ''). Used for EVERY interpolation. */
function esc(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => HTML_MAP[c]);
}

function lang(language) { return language === 'ar' ? 'ar' : 'en'; }

/** One-line plain text: control characters and bidi marks removed, whitespace collapsed. */
function oneLine(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{61c}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 80);
}

/** Defence in depth: a detail value that looks like a phone number, an e-mail or a token is never shown. */
function looksSensitive(s) {
  if (/@/.test(s)) return true;
  if ((s.match(/\d/g) || []).length >= 7) return true;
  if (/[A-Za-z0-9_-]{40,}/.test(s)) return true;
  return false;
}

function detailLines(params, l) {
  const out = [];
  if (!params || typeof params !== 'object') return out;
  for (const [key, labels] of DETAIL_KEYS) {
    const raw = params[key];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    if (key === 'status' && typeof raw === 'string' && (raw === 'unknown' || Object.prototype.hasOwnProperty.call(STATUS_WORDS, raw))) {
      if (raw !== 'unknown') out.push({ label: labels[l], value: STATUS_WORDS[raw][l] });
      continue;
    }
    const v = oneLine(raw, 80);
    if (!v || looksSensitive(v)) continue;
    out.push({ label: labels[l], value: v });
  }
  return out;
}

/**
 * Which template_approved variant the params ask for: 'all' (count >= total), 'first' (count < total) or null (no counts: the
 * generic text). Only finite numbers >= 1 count; a hostile string never selects a variant.
 */
function templateMilestone(params) {
  const count = params && typeof params.count === 'number' ? params.count : NaN;
  const total = params && typeof params.total === 'number' ? params.total : NaN;
  if (!Number.isFinite(count) || !Number.isFinite(total) || count < 1 || total < 1) return null;
  return count >= total ? 'all' : 'first';
}

/** The "Approved: 3 of 7" detail of a milestone mail (counts only; null for any other mail). */
function progressLine(kind, params, l) {
  if (kind !== 'template_approved' || !templateMilestone(params)) return null;
  const total = Math.min(999, Math.trunc(params.total));
  const count = Math.min(total, Math.trunc(params.count));
  return { label: PROGRESS_LABEL[l], value: l === 'ar' ? `${count} من ${total}` : `${count} of ${total}` };
}

function linkFor(params) {
  const p = params && typeof params.actionPath === 'string' && PATH_RE.test(params.actionPath) ? params.actionPath : DEFAULT_PATH;
  return `${config.frontendUrl()}${p}`;
}

/**
 * Render one notification e-mail.
 * @param {string} kind one of notifications.KINDS (unknown kinds get a generic message)
 * @param {'en'|'ar'} language anything but 'ar' renders English
 * @param {object} [params] small, PII-free params (see DETAIL_KEYS) plus an optional actionPath
 * @returns {{subject:string, html:string, text:string}}
 */
function render(kind, language, params) {
  const l = lang(language);
  const milestone = kind === 'template_approved' ? templateMilestone(params) : null;
  const entry = (milestone ? TEMPLATE_MILESTONES[milestone] : (Object.prototype.hasOwnProperty.call(COPY, kind) ? COPY[kind] : UNKNOWN))[l];
  const url = linkFor(params);
  const details = detailLines(params, l);
  const progress = progressLine(kind, params, l);
  if (progress) details.push(progress);
  const footerText = entry.footer === 'pathb' ? FOOTER_PATHB[l] : FOOTER[l];
  const fees = entry.fees ? (l === 'ar' ? FEES_AR : FEES_EN) : null;
  const dir = l === 'ar' ? 'rtl' : 'ltr';

  const paragraphs = entry.body.map((line) => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${esc(line)}</p>`).join('');
  const detailHtml = details.length
    ? `<div style="background:#f4f6f8;border-radius:8px;padding:12px 16px;margin:0 0 16px"><p style="font-size:13px;color:#667085;margin:0 0 6px">${esc(DETAILS_LABEL[l])}</p>${
      details.map((d) => `<p style="font-size:14px;margin:0 0 4px"><strong>${esc(d.label)}:</strong> ${esc(d.value)}</p>`).join('')}</div>`
    : '';
  const feesHtml = fees ? `<p style="font-size:13px;color:#667085;line-height:1.5;margin:0 0 16px">${esc(fees)}</p>` : '';

  const html = `<!doctype html><html lang="${l}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(entry.subject)}</title></head>`
    + `<body dir="${dir}" style="margin:0;padding:24px;background:#eef1f4;font-family:Arial,Helvetica,sans-serif;color:#1f2933">`
    + '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">'
    + '<p style="font-size:13px;color:#667085;margin:0 0 16px">WaFlow</p>'
    + `<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px">${esc(entry.title)}</h1>`
    + paragraphs
    + detailHtml
    + feesHtml
    + `<p style="margin:8px 0 20px"><a href="${esc(url)}" style="display:inline-block;padding:12px 22px;background:#16a34a;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold">${esc(entry.cta)}</a></p>`
    + `<p style="font-size:12px;color:#667085;margin:0">${esc(footerText)}</p>`
    + '</div></body></html>';

  const textParts = [entry.title, '', ...entry.body];
  if (details.length) textParts.push('', ...details.map((d) => `${d.label}: ${d.value}`));
  if (fees) textParts.push('', fees);
  textParts.push('', `${entry.cta}: ${url}`, '', footerText);

  return { subject: entry.subject, html, text: textParts.join('\n') };
}

/**
 * Staff-facing support mail (OnboardingSupportRequest). Static subject, every dynamic value escaped.
 * @param {{kind?:string, step?:string, lastErrorCode?:string, message?:string, businessName?:string, contactEmail?:string}} request
 * @returns {{subject:string, html:string, text:string}}
 */
function renderSupport(request) {
  const r = request || {};
  const rows = [
    ['Request type', oneLine(r.kind, 40)],
    ['Business name', oneLine(r.businessName, 120)],
    ['Setup step', oneLine(r.step, 40)],
    ['Last error code', oneLine(r.lastErrorCode, 64)],
    ['Contact e-mail', oneLine(r.contactEmail, 120)],
  ];
  const message = String(r.message === undefined || r.message === null ? '' : r.message)
    .replace(/[\u{0}-\u{9}\u{b}\u{c}\u{e}-\u{1f}\u{7f}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{61c}]/gu, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, 500);
  const rowsHtml = rows.map(([k, v]) => `<p style="margin:0 0 6px"><strong>${esc(k)}:</strong> ${esc(v || '-')}</p>`).join('');
  const html = '<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><title>WaFlow onboarding help request</title></head>'
    + `<body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933"><h2>WaFlow onboarding help request</h2>${rowsHtml}`
    + `<p style="margin:12px 0 6px"><strong>Message:</strong></p><p style="margin:0">${esc(message || '-').replace(/\n/g, '<br>')}</p></body></html>`;
  const text = ['WaFlow onboarding help request', '', ...rows.map(([k, v]) => `${k}: ${v || '-'}`), '', 'Message:', message || '-'].join('\n');
  return { subject: 'WaFlow onboarding help request', html, text };
}

/**
 * Staff mail for a Meta data-deletion request. Static text, every dynamic value escaped, and NO personal data beyond the request id (no
 * Facebook user id, name, number or workspace): staff open the internal admin page for the details.
 * @param {{requestId?:string}} request
 * @returns {{subject:string, html:string, text:string}}
 */
function renderDataDeletion(request) {
  const id = oneLine(request && request.requestId, 64);
  const url = `${config.appUrl()}/internal-admin-onboarding`;
  const lines = [
    'Meta sent WaFlow a data deletion request.',
    'Nothing is deleted automatically: open the internal admin page, process the request, then mark it processed there.',
  ];
  const html = '<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><title>WaFlow data deletion request</title></head>'
    + `<body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933"><h2>WaFlow data deletion request</h2>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}`
    + `<p style="margin:0 0 6px"><strong>Request id:</strong> ${esc(id || '-')}</p><p><a href="${esc(url)}">${esc(url)}</a></p></body></html>`;
  const text = ['WaFlow data deletion request', '', ...lines, '', `Request id: ${id || '-'}`, url].join('\n');
  return { subject: 'WaFlow data deletion request', html, text };
}

module.exports = { render, renderSupport, renderDataDeletion, esc, KINDS, ARABIC_STATUS, FEES_EN, FEES_AR };
