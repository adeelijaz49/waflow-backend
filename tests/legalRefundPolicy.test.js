'use strict';
// The Refund & Cancellation Policy as the app serves it (shared/legalDocuments.js): the owner's final text of 25 October 2026 is pinned
// sentence by sentence, so a later edit of the module cannot change legal wording without a test saying so. Pure: no database, no server.
const legalDocuments = require('../shared/legalDocuments');

const SLUG = 'refund_cancellation_policy';
const current = () => legalDocuments.getDocument(SLUG);

// The owner's sentences, exactly as in his PDF (formatting marks as in the app: **bold**, and the two bracketed references of section 5
// are links to the documents in the app; the e-mail address is a mailto link).
const SENTENCES = [
  '# WaFlow Refund & Cancellation Policy',
  '**Last updated:** 25 October 2026',
  '## 1. Cancelling Your Subscription',
  'You may cancel your WaFlow subscription at any time from **Settings → Billing**. There is no long-term contract and no cancellation fee.',
  'Cancellation takes effect at the **end of your current billing period** - you will retain access to the Service and your included usage (customer profiles and AI Mode prompts) until that date.',
  '## 2. Refunds',
  '- Subscription fees already paid for the current billing period are **not refunded** on cancellation, other than as required by applicable law.',
  '- Optional onboarding and set-up services are provided under a separate written agreement that sets out the scope, the fee, and any refund terms. This policy does not give a right to a refund of onboarding or set-up fees.',
  '- WhatsApp message fees are charged and collected by Meta directly, not by WaFlow, so WaFlow cannot refund them.',
  '## 3. Changing Plans',
  '- **Upgrades** take effect immediately; you will be charged a prorated amount for the remainder of the current billing period.',
  '- **Downgrades** take effect at the start of your next billing period.',
  '## 4. Non-Payment',
  'If a payment fails, we will notify you and attempt to retry the charge. If payment is not resolved within 7 days, your account may be restricted to read-only access, and promotions and automated flows will be paused, until payment is made.',
  '## 5. Data After Cancellation',
  'Following cancellation, your data is retained for 30 days to allow reactivation, after which it will be deleted in accordance with our [Privacy Policy](/legal/privacy_policy) and [Data Processing Agreement](/legal/data_processing_agreement), except where retention is required by law.',
  '## 6. Contact',
  'Questions about billing, cancellation, or refunds can be directed to [Support@waflowtech.com](mailto:Support@waflowtech.com).',
];

describe('Refund & Cancellation Policy: the current version', () => {
  test('is version v1, final, effective 25 October 2026, and the current one', () => {
    const doc = current();
    expect(doc).toMatchObject({ slug: SLUG, title: 'Refund & Cancellation Policy', version: 'v1', isCurrentVersion: true, status: 'final', effectiveDate: '2026-10-25' });
    expect(legalDocuments.getCurrentVersion(SLUG)).toBe('v1');
  });

  test('carries the owner\'s text, sentence by sentence, in his order', () => {
    const { body } = current();
    let from = 0;
    for (const sentence of SENTENCES) {
      const at = body.indexOf(sentence, from);
      expect({ sentence, found: at >= 0 }).toEqual({ sentence, found: true });
      from = at + sentence.length;
    }
  });

  test('has exactly the six sections, numbered 1 to 6', () => {
    const headings = current().body.split('\n').filter((l) => /^## /.test(l));
    expect(headings).toEqual([
      '## 1. Cancelling Your Subscription', '## 2. Refunds', '## 3. Changing Plans', '## 4. Non-Payment', '## 5. Data After Cancellation', '## 6. Contact',
    ]);
  });

  test('is a finished text: no draft banner, no bracketed placeholders, no tokens, nothing left from the first draft', () => {
    const { body } = current();
    expect(body).not.toMatch(/DRAFT|FOR LEGAL REVIEW|NOT YET APPROVED/i);
    expect(body).not.toMatch(/\{\{|\}\}/);
    expect(body).not.toMatch(/\[[^\]]+\](?!\()/); // every [text] is a link: [text](address)
    for (const gone of ['partners@waflow.ai', 'SAR 499', 'SAR 999', 'messaging credit', 'campaigns/automated', 'Confirm exact', '[7]', '[30]']) expect(body).not.toContain(gone);
  });

  test('every link goes somewhere that exists: a document of the app, or a mailto address', () => {
    const links = [...current().body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links.sort()).toEqual(['/legal/data_processing_agreement', '/legal/privacy_policy', 'mailto:Support@waflowtech.com']);
    for (const href of links.filter((l) => l.startsWith('/legal/'))) expect(legalDocuments.ALL_SLUGS).toContain(href.slice('/legal/'.length));
  });

  test('says what the product behind it must do (so a change of the text is a deliberate decision): 7 days, 30 days, read-only, Meta bills message fees', () => {
    const { body } = current();
    expect(body).toMatch(/within 7 days/);
    expect(body).toMatch(/retained for 30 days/);
    expect(body).toMatch(/restricted to read-only access/);
    expect(body).toMatch(/charged and collected by Meta directly/);
  });
});

describe('Refund & Cancellation Policy: earlier versions and the rest of the set', () => {
  test('the first draft stays retrievable under its own version (never deleted), and is not the current one', () => {
    const old = legalDocuments.getDocument(SLUG, 'draft-1');
    expect(old).toMatchObject({ version: 'draft-1', isCurrentVersion: false, status: 'draft' });
    expect(old.body).toContain('DRAFT — FOR LEGAL REVIEW');
    expect(old.body).toContain('partners@waflow.ai');
    expect(legalDocuments.getDocument(SLUG, 'nope')).toBeNull();
  });

  test('listDocuments: the policy is final with its date; the other four are still drafts; the order is unchanged', () => {
    const list = legalDocuments.listDocuments();
    expect(list.map((d) => d.slug)).toEqual(['terms_of_service', 'privacy_policy', 'acceptable_use_policy', 'data_processing_agreement', SLUG]);
    expect(list.find((d) => d.slug === SLUG)).toMatchObject({ currentVersion: 'v1', status: 'final', effectiveDate: '2026-10-25' });
    expect(list.filter((d) => d.slug !== SLUG).map((d) => d.status)).toEqual(['draft', 'draft', 'draft', 'draft']);
  });

  test('it has no acceptance step: it is not in the combined acceptance and is not the DPA, so nothing new is required of anybody', () => {
    expect(legalDocuments.COMBINED_SLUGS).not.toContain(SLUG);
    expect(legalDocuments.DPA_SLUG).not.toBe(SLUG);
    expect(legalDocuments.COMBINED_SLUGS).toEqual(['terms_of_service', 'privacy_policy', 'acceptable_use_policy']);
  });

  test('the other documents are untouched: same current versions as before', () => {
    for (const slug of ['terms_of_service', 'privacy_policy', 'acceptable_use_policy', 'data_processing_agreement']) {
      expect(legalDocuments.getCurrentVersion(slug)).toBe('draft-1');
    }
  });
});
