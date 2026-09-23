// Static, versioned content for WaFlow's legal documents — no DB collection,
// no CMS (neither exists in this codebase, and none is in scope here).
// Swapping in lawyer-approved final text later is a normal code change: add a
// new entry to a document's `versions` map and bump `currentVersion`. Old
// versions are never deleted, so a Merchant's past acceptance of an earlier
// version stays fully retrievable (see routes/legal.js's `?version=`
// support) even after the document is updated.
//
// All five documents below are still marked "DRAFT — FOR LEGAL REVIEW" in
// their own body text and are NOT approved for real launch.

const HOSTING_REGION = 'the Kingdom of Saudi Arabia';
// NOTE: the current dev/staging environment actually runs on Microsoft Azure
// (Australia East) — production is planned to run on Google Cloud Platform,
// hosted in Saudi Arabia. That migration is a separate, not-yet-started
// infrastructure project (see the Legal Documents plan). These documents
// describe the intended production reality, not today's dev environment.

const GOVERNING_LAW = 'the Kingdom of Saudi Arabia';

// Sub-processors — structured data, deliberately kept separate from any
// document's versioned body. The DPA's own text (§7 below) promises
// Controllers a notify + objection window for a NEW sub-processor, not a
// full DPA re-acceptance, so this list must be updatable independently of
// documentVersion. Interpolated into document bodies via {{SUB_PROCESSORS_TABLE}}.
const DPA_SUB_PROCESSORS = [
  { name: 'Meta / WhatsApp Business Platform', purpose: 'Delivery of WhatsApp messages' },
  { name: 'Stripe', purpose: 'Payment processing' },
  { name: 'Anthropic (Claude API)', purpose: "Powers AI Mode — a Merchant's prompts and the data needed to fulfil them are sent to Anthropic to generate suggestions, drafts, and insights." },
  { name: 'Google Cloud Platform', purpose: 'Application hosting and data storage (planned production environment)' },
];
// OPEN ITEM (not resolved by the list above): when a Merchant uses AI Mode via
// a third-party AI assistant (e.g. ChatGPT) through WaFlow's MCP integration,
// data is also sent to whichever third-party AI provider that Merchant has
// configured — a Merchant-chosen, bring-your-own-assistant scenario distinct
// from Anthropic above (which every Merchant's native, in-product AI Mode
// already uses regardless of MCP). This still needs disclosure language
// finalized with a PDPL/GDPR-qualified lawyer before publishing.
const SUB_PROCESSORS_LAST_UPDATED = '2026-09-23';

// Plain-language summary shown before the DPA acceptance step (spec §3) —
// short, not the full legal text.
const DPA_SUMMARY = "WaFlow processes your customers' personal data (name, phone "
  + 'number, order history, loyalty points, consent status, and message activity) '
  + "on your behalf, to run the features you use — sending messages, tracking "
  + "loyalty points, and generating AI Mode insights. This agreement sets out "
  + "WaFlow's obligations as your data processor, including security, breach "
  + 'notification, and how sub-processors (e.g. Meta, Stripe, Anthropic) are '
  + 'disclosed and can be added.';

function subProcessorsTable() {
  const rows = DPA_SUB_PROCESSORS.map(sp => `| ${sp.name} | ${sp.purpose} |`).join('\n');
  return `| Sub-processor | Purpose |\n|---|---|\n${rows}\n\n*This list is maintained independently of this document's version and was last updated ${SUB_PROCESSORS_LAST_UPDATED} — see the section above for how additions are notified.*`;
}

function withTokens(body) {
  return body
    .replace(/\{\{HOSTING_REGION\}\}/g, HOSTING_REGION)
    .replace(/\{\{GOVERNING_LAW\}\}/g, GOVERNING_LAW)
    .replace(/\{\{SUB_PROCESSORS_TABLE\}\}/g, subProcessorsTable());
}

const DRAFT_DATE = '2026-09-23';

const DOCUMENTS = {
  terms_of_service: {
    title: 'Terms of Service',
    currentVersion: 'draft-1',
    versions: {
      'draft-1': { effectiveDate: DRAFT_DATE, status: 'draft', body: `# WaFlow Terms of Service

**DRAFT — FOR LEGAL REVIEW. NOT YET APPROVED FOR USE.**
This document was prepared as a working draft grounded in WaFlow's actual product
and pricing. It must be reviewed by a solicitor before publication — in particular
the liability, indemnity, and governing law/dispute sections, which carry the most
legal risk if drafted incorrectly.

**Last updated:** ${DRAFT_DATE}

---

## 1. Who We Are

WaFlow Technologies Ltd ("**WaFlow**," "**we**," "**us**"), a company registered in
England and Wales at 167-169 Great Portland Street, 5th Floor, London, W1W 5PF
[company number: TO BE INSERTED], provides the WaFlow platform (the "**Service**") —
a WhatsApp-based commerce, loyalty and customer retention tool for businesses.

By creating a WaFlow account or using the Service, you ("**you**," "**Merchant**")
agree to these Terms of Service ("**Terms**").

---

## 2. The Service

WaFlow allows a Merchant to communicate with their customers via WhatsApp, run
promotions and automated retention flows, operate a loyalty points program, accept
payments via Stripe, and use AI-assisted features ("**AI Mode**") to help plan and
execute campaigns.

WaFlow is a **software tool**. WaFlow does not own, control, or take responsibility
for the Merchant's relationship with their own customers, the products/services the
Merchant sells, or the accuracy of information the Merchant provides through the
Service.

---

## 3. Account Registration & Eligibility

- You must be authorized to bind the business you represent when creating an account.
- You are responsible for the accuracy of information provided during signup and for
  maintaining the security of your account credentials.
- WaFlow may offer team member accounts with different permission levels (Owner,
  Manager, Marketing User, Viewer). The account Owner is responsible for all activity
  under their workspace, including actions taken by invited team members.

---

## 4. Subscription Plans & Billing

- WaFlow is offered on Starter, Growth, and Pro subscription plans, each with its own
  monthly fee, usage limits (locations, WhatsApp Business accounts, platform users,
  customer profiles, AI Mode prompts) and included monthly WhatsApp messaging credit,
  as published on our pricing page from time to time.
- **WhatsApp messaging credit** is a monetary allowance used against the real cost of
  sending messages via the WhatsApp Business Platform, which varies by message type
  and destination country. It is not a fixed count of messages. [Note: acceptance
  criteria in the usage metering requirements doc specify how overage is handled once
  built — this clause should be finalized to match the actual enforcement behavior
  before publishing.]
- Fees are billed monthly or annually in advance, in Saudi Riyals (SAR) unless stated
  otherwise. Annual billing is offered at a discount to the monthly rate.
- **No mandatory setup fee applies to any plan.** An optional, one-time onboarding
  setup fee is available at your request, at the price shown on our pricing page at
  the time of purchase.
- You may upgrade, downgrade, or cancel your plan at any time from Settings →
  Billing. Changes take effect at the start of your next billing cycle. There is no
  long-term contract requirement.
- If you exceed a plan's usage limits, WaFlow will notify you and may require you to
  upgrade your plan or purchase additional usage (an "add-on") before continuing that
  activity, as described on our pricing page.

---

## 5. Merchant Responsibilities

You are responsible for:

- **Obtaining valid consent** from your customers before sending them marketing
  messages via WaFlow, in the manner WaFlow's opt-in features are designed to
  support, and for honoring opt-out requests at all times.
- Ensuring the content of your messages, promotions, and loyalty program complies
  with applicable law in every jurisdiction you operate in, including consumer
  protection and data protection law.
- Complying with Meta's WhatsApp Business Messaging Policy and any other policies of
  the WhatsApp Business Platform, independent of WaFlow's own Acceptable Use Policy.
- The accuracy of product, service, and pricing information you configure within the
  Service.

WaFlow provides tools to help you meet consent and opt-out obligations (see our
[Privacy Policy] and in-product consent logging features), but **you remain solely
responsible for your own compliance** with applicable law as the data controller of
your customers' information.

---

## 6. AI Mode & Automated Features

- AI Mode and Automated Flows are designed to suggest, draft, and — once you
  explicitly confirm — execute actions such as sending a campaign or applying a
  discount.
- **AI-generated suggestions (target audiences, offers, draft messages, insights) are
  not guaranteed to be accurate or optimal for your business.** You are responsible
  for reviewing any AI-suggested action before confirming it.
- No action that sends a message to a real customer or spends money will be executed
  by AI Mode or an Automated Flow without your explicit confirmation, except where you
  have configured an Automated Flow to run without per-send approval — in which case
  you are responsible for the configuration of that flow.
- AI Mode may be accessed directly within WaFlow, or via supported third-party AI
  assistants (e.g. ChatGPT) using WaFlow's MCP integration. Use of a third-party AI
  assistant is subject to that provider's own terms, and data necessary to fulfil
  your request may be transmitted to that provider — see our [Privacy Policy] for
  details.

---

## 7. Loyalty Points

- Loyalty points issued through WaFlow are a discount mechanism only. **Points have
  no cash value, cannot be exchanged for cash, and cannot be transferred between
  customers or between merchants.**
- Points may only be redeemed for discounts or rewards configured by the Merchant
  within their own WaFlow account, at that Merchant's business.
- Merchants are responsible for clearly communicating their own loyalty program
  rules, including any expiry or changes to earn rates, to their customers.

---

## 8. Data & Privacy

Our collection and use of personal data through the Service is described in our
[Privacy Policy]. Where WaFlow processes personal data of your customers on your
behalf, this is additionally governed by our [Data Processing Agreement].

---

## 9. Acceptable Use

Use of the Service is subject to our [Acceptable Use Policy], which prohibits spam,
unlawful content, and other misuse of the platform.

---

## 10. Intellectual Property

- WaFlow and its licensors retain all rights, title, and interest in the Service,
  including its software, design, and the "WaFlow" name and logo.
- You retain all rights to your own business data, content, and customer information
  uploaded to or generated through the Service.
- You grant WaFlow a license to use your data solely to provide and improve the
  Service to you, in accordance with our Privacy Policy.

---

## 11. Service Availability

- WaFlow aims to provide reliable access to the Service but does not guarantee
  uninterrupted availability. [Insert specific uptime commitment if/when an SLA is
  finalized — none currently published.]
- Certain features (message delivery, payment processing) depend on third-party
  platforms (WhatsApp/Meta, Stripe) outside WaFlow's control, and WaFlow is not
  responsible for outages or changes on those platforms.

---

## 12. Termination

- You may cancel your subscription at any time via Settings → Billing.
- WaFlow may suspend or terminate your account for material breach of these Terms,
  including violation of the Acceptable Use Policy, non-payment, or misuse that
  risks WaFlow's own standing with WhatsApp/Meta.
- On termination, your right to use the Service ends immediately. Data retention
  after termination is described in our [Privacy Policy] and [Refund & Cancellation
  Policy].

---

## 13. Limitation of Liability

[This section requires solicitor drafting specific to Saudi law and WaFlow's risk
tolerance — placeholder structure only:]

- To the maximum extent permitted by law, WaFlow's aggregate liability arising from
  or related to the Service shall not exceed the amount paid by you in the [3/6/12]
  months preceding the claim.
- WaFlow shall not be liable for indirect, incidential, or consequential damages,
  including loss of profits or loss of customers, except where such exclusion is not
  permitted by applicable law.
- Nothing in these Terms limits any liability that cannot be excluded under
  applicable law.

---

## 14. Indemnification

You agree to indemnify WaFlow against claims arising from your breach of these
Terms, your violation of applicable law (including consent/data protection
obligations to your own customers), or content/campaigns you send through the
Service.

---

## 15. Governing Law & Disputes

These Terms are governed by the laws of {{GOVERNING_LAW}}. [DRAFT — confirm with
counsel the specific dispute-resolution mechanism (e.g., arbitration via the Saudi
Center for Commercial Arbitration (SCCA) as an alternative to court litigation) and
whether any variation is needed for merchants based outside Saudi Arabia.]

---

## 16. Changes to These Terms

We may update these Terms from time to time. Material changes will be notified to
you within the product or by email before taking effect.

---

## 17. Contact

WaFlow Technologies Ltd
167-169 Great Portland Street, 5th Floor, London, W1W 5PF
partners@waflow.ai
` },
    },
  },

  privacy_policy: {
    title: 'Privacy Policy',
    currentVersion: 'draft-1',
    versions: {
      'draft-1': { effectiveDate: DRAFT_DATE, status: 'draft', body: `# WaFlow Privacy Policy

**DRAFT — FOR LEGAL REVIEW. NOT YET APPROVED FOR USE.**
This document must be reviewed by a lawyer qualified in the Saudi PDPL before
publication. One section below is flagged as a genuine open gap identified during
this project's compliance review — it needs a real answer before this policy can
honestly be published, not just legal wordsmithing.

**Last updated:** ${DRAFT_DATE}

---

## 1. Who We Are

WaFlow Technologies Ltd ("**WaFlow**," "**we**," "**us**"), 167-169 Great Portland
Street, 5th Floor, London, W1W 5PF, United Kingdom, is the provider of the WaFlow
platform.

For most personal data processed through WaFlow, **the Merchant business using
WaFlow is the data controller**, and WaFlow acts as a data processor on their
behalf — governed by our [Data Processing Agreement]. This Privacy Policy covers:
(a) data we collect about Merchants themselves as our direct customers, and
(b) our role and obligations as a processor of Merchants' customer data.

---

## 2. What Data We Collect

**About you (the Merchant):** name, business name, email, phone number, billing
information, and usage data about how you use WaFlow.

**About your customers (processed on your behalf, as your processor):** name, phone
number, order history, loyalty points balance, consent/opt-out status, and message
interaction history (e.g. which campaign a customer received and whether they
clicked a button), as configured and uploaded by you.

---

## 3. How We Use Data

We use Merchant account data to provide, bill for, and support the Service. We
process customer data strictly as instructed by the Merchant, to operate the
features they configure (sending messages, tracking loyalty points, generating AI
Mode insights).

**We do not sell personal data.** We do not use customer data processed on a
Merchant's behalf for our own independent marketing purposes.

---

## 4. Legal Basis for Processing

Depending on the data and jurisdiction involved, we (or the Merchant, as
controller) rely on: performance of a contract, legitimate interests, consent
(specifically for marketing messages sent via WhatsApp — see our consent logging
requirements), and compliance with legal obligations. This policy is designed to
meet the requirements of the Saudi Personal Data Protection Law (PDPL), and of the
UK GDPR where applicable to Merchants or customers based outside Saudi Arabia.

---

## 5. Sandbox / Demo Mode

**Sandbox and Demo Mode never use real customer data.** Any data shown while testing
features, running a demo, or exploring the product in Sandbox Mode is
simulated/synthetic and is never sourced from a Merchant's real customer list.

---

## 6. Sub-processors

We use sub-processors to provide the Service. WaFlow maintains this list
independently of this document's version, so it can be kept accurate without
requiring you to re-accept this policy for a routine addition:

{{SUB_PROCESSORS_TABLE}}

**⚠️ Open item — AI Mode via third-party assistants (MCP):** When a Merchant uses
AI Mode through a third-party AI assistant (e.g. ChatGPT) rather than directly
within WaFlow, the data necessary to fulfil that request is transmitted to and
processed by that third-party AI provider. **This is a genuine, currently
undisclosed sub-processor relationship that must be added here — and a
corresponding update made to the Data Processing Agreement — before this policy is
accurate.** Do not publish this policy until this is resolved with input from a
PDPL-qualified lawyer, since it affects what consent/disclosure is required.

---

## 7. Where Data Is Stored

WaFlow's production environment is hosted in {{HOSTING_REGION}}. [DRAFT — this
section still needs a PDPL-qualified lawyer to confirm whether any cross-border
transfer safeguard language is needed for data that touches a sub-processor located
outside {{HOSTING_REGION}} (see Section 6), and to finalize this section once
WaFlow's production infrastructure migration is complete — the current development
environment runs on a different provider and region than production will.]

---

## 8. Data Retention

We retain Merchant account data for as long as the account is active, and for a
reasonable period after cancellation as described in our [Refund & Cancellation
Policy], to allow reactivation and meet legal record-keeping obligations. Customer
data processed on a Merchant's behalf is retained per the Merchant's own
configuration and deleted on their instruction or account closure, subject to
legal retention requirements.

---

## 9. Your Rights

Depending on your jurisdiction, you (or, for a Merchant's customers, the Merchant as
controller) may have rights to access, correct, delete, or object to processing of
personal data. Requests can be made via partners@waflow.ai. We aim to action
verified requests within a reasonable time, consistent with applicable law.

Merchants can action deletion/correction requests from their customers directly
within WaFlow via [Customers section / Settings — confirm exact in-product location
once built].

---

## 10. Security

We apply encryption at rest and in transit for personal data, and maintain access
controls appropriate to the sensitivity of the data processed. In the event of a
data breach, we will notify affected Merchants and relevant regulators within the
timeframes required by applicable law (72 hours under PDPL where applicable).

---

## 11. Consent for WhatsApp Marketing Messages

Where a Merchant sends marketing messages to their customers via WaFlow, a specific,
logged, opt-in consent record is required before the first such message, consistent
with our published consent framework. Customers may opt out of marketing messages
at any time; this does not affect transactional messages related to their own
orders or bookings.

---

## 12. Children's Data

WaFlow is intended for business use and is not directed at children. We do not
knowingly collect personal data from individuals under 18 as end customers of a
Merchant's loyalty program without appropriate parental/guardian consent as required
by applicable law.

---

## 13. Changes to This Policy

We may update this Privacy Policy from time to time. Material changes will be
notified within the product or by email before taking effect.

---

## 14. Contact

WaFlow Technologies Ltd
167-169 Great Portland Street, 5th Floor, London, W1W 5PF
partners@waflow.ai
[Data Protection Officer contact, if appointed — TO BE CONFIRMED]
` },
    },
  },

  acceptable_use_policy: {
    title: 'Acceptable Use Policy',
    currentVersion: 'draft-1',
    versions: {
      'draft-1': { effectiveDate: DRAFT_DATE, status: 'draft', body: `# WaFlow Acceptable Use Policy

**DRAFT — FOR LEGAL REVIEW. NOT YET APPROVED FOR USE.**

**Last updated:** ${DRAFT_DATE}

---

## 1. Purpose

This policy sets out what you may and may not do with WaFlow, in addition to our
[Terms of Service]. It exists to protect your customers from unwanted messages, to
protect WaFlow's own standing with Meta/WhatsApp (which affects every Merchant on
the platform), and to keep the Service safe and lawful to use.

---

## 2. Prohibited Uses

You may not use WaFlow to:

- Send marketing messages to any customer who has not provided valid, logged
  consent, or to any customer who has opted out (via "STOP" or the in-product
  opt-out mechanism).
- Send spam, unsolicited bulk messages, or messages unrelated to a genuine business
  relationship with the recipient.
- Send illegal, fraudulent, deceptive, defamatory, or harassing content.
- Impersonate another business or individual, or misrepresent your identity.
- Use the loyalty points system to facilitate any activity resembling a payment
  instrument, gambling, or cash-equivalent scheme — points must remain a
  non-transferable, non-cash discount mechanism as described in our Terms.
- Attempt to circumvent, disable, or interfere with WaFlow's consent logging,
  opt-out handling, or other safety features.
- Reverse-engineer, scrape, or attempt to extract WaFlow's software, AI models, or
  underlying data beyond your own account's normal use.
- Resell or sublicense access to the Service without WaFlow's written agreement
  (e.g., via an approved reseller arrangement).
- Use the Service in a way that violates Meta's WhatsApp Business Messaging Policy,
  or any other applicable third-party platform policy.

---

## 3. AI Mode Specific Use

- Do not use AI Mode to generate or send content that would violate this policy —
  human review and confirmation before sending remains your responsibility, even
  when a message is AI-drafted.
- Do not attempt to use AI Mode or the MCP integration to extract data belonging to
  another Merchant's account.

---

## 4. Consequences of Violation

Violating this policy may result in a warning, suspension, or termination of your
account, at WaFlow's discretion, depending on severity — particularly for violations
that risk WaFlow's or other Merchants' standing with Meta/WhatsApp. We may also be
required to report certain violations (e.g. suspected fraud or illegal content) to
relevant authorities.

---

## 5. Reporting Abuse

If you believe another Merchant or a WaFlow feature is being misused, contact
partners@waflow.ai.

---

## 6. Contact

WaFlow Technologies Ltd
167-169 Great Portland Street, 5th Floor, London, W1W 5PF
partners@waflow.ai
` },
    },
  },

  data_processing_agreement: {
    title: 'Data Processing Agreement',
    currentVersion: 'draft-1',
    versions: {
      'draft-1': { effectiveDate: DRAFT_DATE, status: 'draft', body: `# WaFlow Data Processing Agreement (DPA)

**DRAFT — FOR LEGAL REVIEW. NOT YET APPROVED FOR USE.**
This is the highest-risk document in this set — it's the formal contract governing
how WaFlow handles a Merchant's customers' personal data. It must be reviewed by a
PDPL-qualified lawyer before publication, not just proofread.

**Last updated:** ${DRAFT_DATE}

---

## 1. Parties & Scope

This Data Processing Agreement ("**DPA**") forms part of the agreement between
WaFlow Technologies Ltd ("**Processor**," "**WaFlow**") and the Merchant using the
Service ("**Controller**"), and applies whenever WaFlow processes personal data of
the Controller's customers on the Controller's behalf.

By accepting WaFlow's Terms of Service and this DPA (via the in-product acceptance
step at onboarding), the Controller instructs WaFlow to process personal data as
described below.

---

## 2. Subject Matter & Duration

WaFlow processes personal data for the duration of the Controller's active WaFlow
subscription, and for a limited period thereafter as described in Section 9
(Deletion / Return of Data).

---

## 3. Nature & Purpose of Processing

WaFlow processes personal data to provide the Service: sending WhatsApp messages
configured by the Controller, operating the loyalty points system, tracking orders
and bookings, generating AI Mode insights, and related reporting.

---

## 4. Categories of Data Subjects

The customers and end-users of the Controller's business.

---

## 5. Categories of Personal Data

Name, phone number, order/booking history, loyalty points balance, marketing
consent/opt-out status, and message interaction data (e.g. campaign delivery and
click status).

---

## 6. Processor Obligations

WaFlow shall:

- Process personal data only on the Controller's documented instructions (including
  those given via the Controller's own configuration of the Service), unless
  required otherwise by law.
- Ensure personnel authorized to process the data are bound by confidentiality.
- Implement appropriate technical and organizational security measures, including
  encryption at rest and in transit.
- Assist the Controller in responding to data subject rights requests (access,
  correction, deletion) via the tools provided in the Service, or on request to
  partners@waflow.ai.
- Notify the Controller without undue delay after becoming aware of a personal data
  breach affecting their data, and in any event within a timeframe sufficient to
  allow the Controller to meet their own regulatory notification deadlines (72 hours
  under PDPL where applicable).
- Make available information reasonably necessary to demonstrate compliance with
  this DPA, and allow for audits by the Controller or their appointed auditor on
  reasonable notice.
- Delete or return all personal data at the end of the provision of services, per
  Section 9, except where retention is required by law.

---

## 7. Sub-processors

The Controller provides **general authorization** for WaFlow to engage the
sub-processors listed below (updated from time to time), including for WhatsApp
message delivery, payment processing, AI Mode, and application hosting:

{{SUB_PROCESSORS_TABLE}}

WaFlow will notify Controllers of any new sub-processor with a role in processing
their customers' personal data, and Controllers may object on reasonable grounds
within [14] days of notification.

**⚠️ Open item:** the third-party AI assistant relationship (MCP integration —
distinct from the Anthropic/Claude API sub-processor already listed above, which
powers native in-product AI Mode) needs to be added here as a disclosed
sub-processor once resolved with legal input, matching the flag raised in the
Privacy Policy — this DPA is not fully accurate until that's resolved.

---

## 8. International Transfers

WaFlow's production environment is hosted in {{HOSTING_REGION}}. Where personal
data is nonetheless transferred outside {{HOSTING_REGION}} (e.g. to a sub-processor
located elsewhere — see Section 7), WaFlow shall ensure an appropriate transfer
safeguard is in place, consistent with PDPL requirements. [DRAFT — this section
still needs a PDPL-qualified lawyer to finalize the specific safeguard mechanism
once every sub-processor's own data-handling location is confirmed.]

---

## 9. Deletion / Return of Data

On termination of the Controller's WaFlow subscription, WaFlow will, at the
Controller's choice, delete or return all personal data processed on their behalf
within [30] days, except to the extent retention is required by applicable law.

---

## 10. Liability

Each party's liability under this DPA is subject to the limitations set out in the
main Terms of Service. [Confirm with counsel whether a separate liability
allocation specific to data protection breaches is needed here, given the
regulatory fine exposure already documented — this is a meaningful drafting
decision, not boilerplate.]

---

## 11. Governing Law

This DPA is governed by the same governing law as the Terms of Service it forms
part of.

---

## 12. Acceptance

This DPA is accepted electronically as part of WaFlow account onboarding, by the
workspace Owner. A Controller may request a signed copy at any time via
partners@waflow.ai, or view/download their accepted copy at any time from Settings
→ Legal.

---

## 13. Contact

WaFlow Technologies Ltd
167-169 Great Portland Street, 5th Floor, London, W1W 5PF
partners@waflow.ai
` },
    },
  },

  refund_cancellation_policy: {
    title: 'Refund & Cancellation Policy',
    currentVersion: 'draft-1',
    versions: {
      'draft-1': { effectiveDate: DRAFT_DATE, status: 'draft', body: `# WaFlow Refund & Cancellation Policy

**DRAFT — FOR LEGAL REVIEW. NOT YET APPROVED FOR USE.**

**Last updated:** ${DRAFT_DATE}

---

## 1. Cancelling Your Subscription

You may cancel your WaFlow subscription at any time from **Settings → Billing**.
There is no long-term contract and no cancellation fee.

Cancellation takes effect at the **end of your current billing period** — you will
retain access to the Service and your included usage (customer profiles, AI Mode
prompts, WhatsApp messaging credit) until that date.

---

## 2. Refunds

- Subscription fees already paid for the current billing period are **not refunded**
  on cancellation, other than as required by applicable law.
- **Optional onboarding setup fees** (SAR 499 for Starter/Growth, SAR 999 for Pro)
  are refundable within [7] days of purchase if onboarding has not yet been
  substantially completed. [Confirm exact refund window and "substantially
  completed" definition with the team actually delivering onboarding.]
- Unused WhatsApp messaging credit is not refundable on cancellation, but remains
  usable until the end of the current billing period.

---

## 3. Changing Plans

- **Upgrades** take effect immediately; you will be charged a prorated amount for
  the remainder of the current billing period.
- **Downgrades** take effect at the start of your next billing period.

---

## 4. Non-Payment

If a payment fails, we will notify you and attempt to retry the charge. If payment
is not resolved within [7] days, your account may be restricted to read-only access,
and campaigns/automated flows will be paused, until payment is made. [Confirm exact
grace period with billing/product team.]

---

## 5. Data After Cancellation

Following cancellation, your data is retained for [30] days to allow reactivation,
after which it will be deleted in accordance with our [Privacy Policy] and [Data
Processing Agreement], except where retention is required by law.

---

## 6. Contact

Questions about billing, cancellation, or refunds can be directed to
partners@waflow.ai.
` },
    },
  },
};

function listDocuments() {
  return Object.entries(DOCUMENTS).map(([slug, doc]) => {
    const version = doc.versions[doc.currentVersion];
    return { slug, title: doc.title, currentVersion: doc.currentVersion, effectiveDate: version.effectiveDate, status: version.status };
  });
}

function getDocument(slug, version) {
  const doc = DOCUMENTS[slug];
  if (!doc) return null;
  const v = version || doc.currentVersion;
  const entry = doc.versions[v];
  if (!entry) return null;
  return {
    slug, title: doc.title, version: v, isCurrentVersion: v === doc.currentVersion,
    effectiveDate: entry.effectiveDate, status: entry.status, body: withTokens(entry.body),
  };
}

function getCurrentVersion(slug) {
  return DOCUMENTS[slug]?.currentVersion || null;
}

const ALL_SLUGS = Object.keys(DOCUMENTS);
const COMBINED_SLUGS = ['terms_of_service', 'privacy_policy', 'acceptable_use_policy'];
const DPA_SLUG = 'data_processing_agreement';

module.exports = {
  HOSTING_REGION, GOVERNING_LAW, DPA_SUB_PROCESSORS, SUB_PROCESSORS_LAST_UPDATED, DPA_SUMMARY,
  ALL_SLUGS, COMBINED_SLUGS, DPA_SLUG,
  listDocuments, getDocument, getCurrentVersion,
};
