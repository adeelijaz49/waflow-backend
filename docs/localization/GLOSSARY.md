# Arabic glossary, tone and orthography decisions (for ALL Arabic strings in this feature)

Sources: the spec's §8 table, the marketing website's Arabic (its 462 Arabic strings were reviewed during the audit), and the decisions below. EVERY Arabic string is a `draft`
until a native reader marks it `reviewed` (spec §8) — write good Arabic, but never mark anything reviewed yourself.

## Voice and tone
- UI / marketing voice: Modern Standard Arabic, friendly-professional, **second person masculine singular imperative** for actions
  (احفظ، أرسل، اختر), possessive ـك (عملاؤك). No honorifics, no feminine/gender-neutral variants, no Gulf dialect in the UI.
- Customer-facing WhatsApp messages: warm MSA with a light Saudi-business feel ("Make this Saudi-friendly" targets natural Saudi/Gulf business tone);
  short clauses, emoji at the END of a clause, quotes « ». Not literal translation — write it the way a Saudi shop would.
- Questions with ؟ and commas with ، ; Western digits (0-9) always; percent as `15%`; thousands separator `,`.
- Brand stays Latin: WaFlow, WaFlow AI, Stripe, Meta, CSV, QR, STOP. WhatsApp = **واتساب** (never Latin in Arabic copy). Instagram = **إنستغرام**.

## Orthography decisions (the spec's audit items D1–D14)
- **D7 tanween**: alef + fathatan as on the website: `مرحباً، أهلاً، شكراً، جداً، تلقائياً` (NOT `مرحبًا`). Matching code normalises both.
- **D8 currency**: UI shows `150.00 ر.س` (number, space, ر.س); in message text a merchant-supplied `{amount}` is passed through unchanged.
- **D10 counted nouns**: never hard-wire a counted noun after a merge field (`{points} نقطة` is wrong for 1, 2, 3–10). Use count-neutral phrasing:
  `رصيدك الحالي من النقاط: {points}`. In the UI use plural-aware keys (`_one/_two/_few/_many/_other`, CLDR) via `i18n.tp()`.
- **D4 consent vs approval**: consent = **الموافقة** (على استلام الرسائل); Meta template approval = **الاعتماد** (معتمد / قيد المراجعة / مرفوض);
  human approval of AI output = **موافقة بشرية** / تأكيد. Do not use الموافقة for template approval.
- **D1 inbox**: **صندوق الوارد** (menu/page); **صندوق واتساب الوارد** where the WhatsApp qualifier helps.
- **D2 offer**: **عرض** generally; **عرض ترويجي** for the formal object "promotion". (عرض also = "demo" on the website: never use it for demo.)
- **D3 redeem**: **استبدال** (spec term; not on the website — keep, flagged for the reviewer).
- **D5 AI Mode**: full **وضع الذكاء الاصطناعي** everywhere in this feature.
- **D6 plan** = **باقة** (باقة البداية، باقة النمو، الباقة الاحترافية).
- **D11 طلب** means both *order* and *AI prompt*: in the UI say **طلب** only for orders; call an AI prompt **سؤال** or **استفسار**.
- **D12 opt-out keywords shown to merchants**: list the Arabic keywords too («إلغاء الاشتراك» / STOP).
- Sent/delivered/read for messages: **مرسلة / مُسلَّمة / مقروءة** (participles); campaign status "sent" = **تم الإرسال**.

## Glossary (EN → AR)
| English | Arabic | Notes |
|---|---|---|
| Customer / customers | عميل / عملاء | profile = ملف العميل |
| Promotion / Offer | عرض ترويجي / عرض | |
| Campaign | حملة (حملات) | |
| Loyalty points | نقاط الولاء | mass noun; balance = رصيد الولاء / رصيد النقاط |
| Balance | رصيد | |
| Redeem | استبدال (استبدل) | |
| Voucher | قسيمة (قسائم) | never كوبون |
| Referral / Referrer | إحالة / المُحيل | damma on the meem |
| Inbox | صندوق الوارد | |
| AI Mode | وضع الذكاء الاصطناعي | |
| Opt in / Opt out | الموافقة / إلغاء الاشتراك | button labels: «نعم، أوافق» · «لا، شكراً» · «إلغاء الاشتراك» (each ≤ 20 chars) |
| Subscribe (keyword) | اشترك | |
| Plans: Starter / Growth / Pro | البداية / النمو / الاحترافية | باقة … |
| Template (WhatsApp message template) | قالب رسالة | no website precedent; reviewer to confirm |
| Approval status: Not created / Pending / Approved / Rejected | غير مُنشأ / قيد المراجعة / معتمد / مرفوض | |
| Draft / Reviewed | مسودة / تمت المراجعة | |
| Language / Bilingual | اللغة / ثنائي اللغة | |
| Merge field | حقل دمج | e.g. «اسم العميل» |
| Preview | معاينة | |
| Send test | إرسال تجريبي | |
| Audience | الجمهور | |
| Recipients | المستلمون | |
| Reminder | تذكير | |
| Payment link | رابط الدفع | |
| Booking / Service / Product | حجز / خدمة / منتج | |
| Order | طلب | |
| Marketing message / Utility message | رسالة تسويقية / رسالة خدمية | |
| Automated flows | المسارات الآلية | |
| Settings | الإعدادات | |
| Billing | الفوترة | |
| Smart Insights | رؤى ذكية | |
| Dashboard | لوحة التحكم | |
| Merchant | تاجر | |
| Save / Cancel / Delete-like "Archive" | حفظ / إلغاء / أرشفة | never "حذف" for archive |
| WhatsApp | واتساب | |
| Instagram | إنستغرام | caption = التعليق التوضيحي |
| Shop now (button role `shop_now`) | تسوق الآن | the quick reply of a promotion-linked template; payload `promo_<id>` |
| Cart / Checkout | السلة / إتمام الطلب | journey buttons: أضف إلى السلة، إتمام الطلب ✅ |
| Rebook / Pay in person | إعادة الحجز / احجز وادفع بالموقع | booking-notice and slot buttons (each within 20 characters) |
| Entry message (the first message of a flow or promotion) | رسالة الدخول | Meta-approved template |
| Follow-up message (the reply after a button tap) | رسالة الرد التالية | free session reply: needs native review, no Meta approval |
| Arabic hub (`/arabic`) | العربية واللغات / مركز العربية | page title / how other screens link to it |
| Native reader / native review | متحدث أصلي للعربية / مراجعة متحدث أصلي | avoid the shortened "مراجعة أصلية" |
| Out of date (an Arabic text whose English source changed) | قديمة | the Arabic follow-up is not sent until it is saved and reviewed again |
| English instead of Arabic (fallback) | بالإنجليزية بدلاً من العربية | shown in plans and reports before sending |
| Months (Gregorian, session texts) | يناير فبراير مارس أبريل مايو يونيو يوليو أغسطس سبتمبر أكتوبر نوفمبر ديسمبر | `senderValues.js`; written with a Western-digit day, e.g. `30 نوفمبر` |

## Native-review metadata
Frontend catalogues: `src/app/i18n/catalogs/ar/<ns>.json` (flat `key: text`) with review state in `catalogs/meta/<ns>.json`
(`{ "<key>": {"status":"reviewed","reviewer":"…","reviewedAt":"ISO"} }` — keys absent ⇒ draft; optional `"needsLegalApproval": true`).
Backend catalogue: `shared/localization/catalog/<ns>.json` entries carry `status` inline (see `catalog.js`).
Strings flagged `needsLegalApproval` (AI notice, consent/opt-out acknowledgements, privacy-adjacent copy) additionally need the owner's lawyer — never machine-translated legal text. State on 2026-10-12: the backend catalogue flags 17 strings (13 `consent.*`, the 3 Arabic `welcome_optin` library texts, `senders.optOutHint`); the Angular catalogues flag none yet, although the AI notice (`ai.notice`) and the AI Mode disclaimer (`aimode.disclaimer`) belong on the lawyer's list (backlog I10).

## Session-message conventions (journey and senders catalogues, wiring phase)
The 86 `journey.*` and 17 `senders.*` backend strings follow the rules above plus these:
- Money in Arabic session texts is `150.00 ر.س` (AED `د.إ`), Western digits; a Latin product/service name or number inside an Arabic sentence is isolated with LRM by the renderer, never hand-typed into the catalogue.
- Count-neutral phrasing instead of a counted noun after `{n}` (`عدد المنتجات في السلة: {n}`, `النقاط المطلوبة: {pts}`); "was" price = `كان {base}`, discount = `خصم {pct}%`.
- Button titles stay within WhatsApp's 20 characters (the Arabic pay-in-person label is 18; the existing English one is 22); list rows within 24 and bodies within 1,024 characters.
- Opt-out wording uses «إلغاء الاشتراك» exactly (the keyword the hook recognises); the referral hint line `senders.optOutHint` is legal-sensitive.
- Merchant names of products/services appear only as the merchant's own text or a **reviewed** Arabic translation; the renderer never translates them.
