const { LIMITS, BUTTON_ROLES, charLength, validateTemplateName, validateButtonLabel, validateButtonUrl, validateVariant } = require('../../shared/localization/metaConstraints');

const OPT_OUT_AR = { role: 'opt_out', text: 'إلغاء الاشتراك' };
const good = (over = {}) => ({
  language: 'ar',
  body: 'أهلًا {name}، رصيدك الحالي {points} نقطة. استبدلها قبل {date} واستمتع بمكافأتك.',
  buttons: [OPT_OUT_AR],
  ...over,
});
const codes = (list) => list.map((e) => e.code);

describe('button labels (spec: max 20 characters)', () => {
  test('Arabic suggested labels fit', () => {
    for (const label of ['نعم، أوافق', 'لا، شكرًا', 'إلغاء الاشتراك']) {
      expect(charLength(label)).toBeLessThanOrEqual(LIMITS.BUTTON_LABEL);
      expect(validateButtonLabel(label).ok).toBe(true);
    }
  });
  test('21 characters is rejected, 20 accepted', () => {
    expect(validateButtonLabel('x'.repeat(20)).ok).toBe(true);
    expect(validateButtonLabel('x'.repeat(21))).toMatchObject({ ok: false, code: 'button_label_too_long', max: 20 });
  });
  test('empty label rejected', () => {
    expect(validateButtonLabel('  ').code).toBe('button_label_empty');
  });
  test('counts code points, not UTF-16 units (emoji = 1)', () => {
    expect(charLength('👍')).toBe(1);
  });
});

describe('validateVariant', () => {
  test('a good Arabic marketing variant passes', () => {
    const r = validateVariant(good());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.positional.params).toEqual(['name', 'points', 'date']);
  });

  test('body required, and Meta-style {{1}} / unbalanced braces rejected', () => {
    expect(codes(validateVariant(good({ body: '' })).errors)).toContain('body_required');
    expect(codes(validateVariant(good({ body: 'hi {{1}} there friend' })).errors)).toContain('meta_positional_syntax');
    expect(codes(validateVariant(good({ body: 'hi {name there friend' })).errors)).toContain('unbalanced_braces');
  });

  test('body length is measured on the Meta (positional) form against 1024', () => {
    // "{name}" is 6 characters raw but "{{1}}" is 5 in Meta's form: 1018 + space + {{1}} = 1024 (allowed), one more is not.
    expect(codes(validateVariant(good({ body: `${'ا'.repeat(1018)} {name}` })).errors)).not.toContain('body_too_long');
    expect(codes(validateVariant(good({ body: `${'ا'.repeat(1019)} {name}` })).errors)).toContain('body_too_long');
    expect(codes(validateVariant(good({ body: 'ا'.repeat(1025) })).errors)).toContain('body_too_long');
  });

  test('header / footer limits and footer variables', () => {
    expect(codes(validateVariant(good({ header: 'x'.repeat(61) })).errors)).toContain('header_too_long');
    expect(codes(validateVariant(good({ footer: 'x'.repeat(61) })).errors)).toContain('footer_too_long');
    expect(codes(validateVariant(good({ footer: 'Hi {name}' })).errors)).toContain('footer_has_variable');
  });

  test('marketing templates must carry an opt-out button; utility need not', () => {
    expect(codes(validateVariant(good({ buttons: [] })).errors)).toContain('marketing_requires_opt_out_button');
    expect(validateVariant(good({ buttons: [] }), { category: 'UTILITY' }).ok).toBe(true);
  });

  test('button problems: too long, duplicate, too many', () => {
    const long = validateVariant(good({ buttons: [OPT_OUT_AR, { role: 'decline', text: 'x'.repeat(25) }] }));
    expect(codes(long.errors)).toContain('button_label_too_long');
    const dup = validateVariant(good({ buttons: [OPT_OUT_AR, { role: 'decline', text: 'إلغاء الاشتراك' }] }));
    expect(codes(dup.errors)).toContain('duplicate_button_label');
    const many = validateVariant(good({ buttons: Array.from({ length: 11 }, (_, i) => ({ role: i === 0 ? 'opt_out' : 'decline', text: `b${i}` })) }));
    expect(codes(many.errors)).toContain('too_many_buttons');
  });

  test('the consent request (opt-in + decline) is the opt-out equivalent on a MARKETING template; decline alone is not', () => {
    const consent = [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكرًا' }];
    expect(validateVariant(good({ buttons: consent })).ok).toBe(true);
    expect(codes(validateVariant(good({ buttons: [consent[1]] })).errors)).toContain('marketing_requires_opt_out_button');
    expect(codes(validateVariant(good({ buttons: [consent[0]] })).errors)).toContain('marketing_requires_opt_out_button');
  });

  test('direction marks in submitted text are errors (Meta\'s own templates carry none); the display layer adds them later', () => {
    const LRM = String.fromCodePoint(0x200e);
    const RLM = String.fromCodePoint(0x200f);
    expect(validateVariant(good({ body: `أهلًا ${LRM}{name}، رصيدك الحالي {points} نقطة. استبدلها واستمتع بمكافأتك.` })).errors).toContainEqual({ code: 'direction_marks_in_text', field: 'body' });
    expect(validateVariant(good({ footer: `تذييل${RLM}` })).errors).toContainEqual({ code: 'direction_marks_in_text', field: 'footer' });
    expect(validateVariant(good({ header: `${RLM}عنوان` })).errors).toContainEqual({ code: 'direction_marks_in_text', field: 'header' });
    expect(validateVariant(good({ buttons: [{ role: 'opt_out', text: `إلغاء${LRM}` }] })).errors).toContainEqual({ code: 'direction_marks_in_text', field: 'buttons.0' });
    expect(codes(validateVariant(good()).errors)).not.toContain('direction_marks_in_text');
  });

  test('Meta rejects a body that starts or ends with a variable (error 2388299): an ERROR, not a warning', () => {
    const start = validateVariant(good({ body: '{name}، أهلًا بك في متجرنا اليوم' }));
    expect(start.ok).toBe(false);
    expect(codes(start.errors)).toContain('body_starts_with_variable');
    expect(codes(start.warnings)).not.toContain('body_starts_with_variable');
    const end = validateVariant(good({ body: 'أهلًا بك في متجرنا اليوم يا {name}' }));
    expect(end.ok).toBe(false);
    expect(codes(end.errors)).toContain('body_ends_with_variable');
    expect(validateVariant(good({ body: 'أهلًا {name}، أهلًا بك في متجرنا اليوم' })).ok).toBe(true);
  });

  test('warnings for heuristics Meta enforces at review', () => {
    expect(codes(validateVariant(good({ body: 'أهلًا {name}{points} بك' })).warnings)).toContain('adjacent_variables');
    expect(codes(validateVariant(good({ body: 'أهلًا {name} و {name} هنا' })).warnings)).toContain('repeated_field');
    expect(codes(validateVariant(good({ body: '{a} {b} {c} {d}' })).warnings)).toContain('too_many_variables_for_length');
    expect(codes(validateVariant(good({ buttons: [OPT_OUT_AR, { role: 'decline', text: 'a' }, { role: 'opt_in', text: 'b' }, { role: 'decline', text: 'c' }] })).warnings)).toContain('buttons_collapsed');
  });

  test('an Arabic variant without Arabic is an error; other script checks stay warnings', () => {
    const noArabic = validateVariant(good({ body: 'Hello there my friend how are you' }));
    expect(noArabic.ok).toBe(false);
    expect(codes(noArabic.errors)).toContain('arabic_variant_has_no_arabic');
    expect(codes(noArabic.warnings)).not.toContain('arabic_variant_has_no_arabic');
    expect(codes(validateVariant({ language: 'en', body: 'مرحبا بكم في متجرنا الجميل اليوم', buttons: [{ role: 'opt_out', text: 'Opt out' }] }).warnings)).toContain('english_variant_is_mostly_arabic');
    expect(codes(validateVariant(good({ body: 'رصيدك ١٢٠ نقطة في متجرنا اليوم' })).warnings)).toContain('arabic_indic_digits_in_body');
  });
});

describe('validateTemplateName', () => {
  test.each([['loc_loyalty_ar_v1', true], ['Loyalty', false], ['with space', false], ['', false], ['a-b', false], ['loyalty_2', true]])('%s -> %s', (name, ok) => {
    expect(validateTemplateName(name).ok).toBe(ok);
  });
});

describe('button roles', () => {
  test('the role set is exactly opt_in | decline | opt_out | url | flow_button (no generic custom reply)', () => {
    expect(BUTTON_ROLES).toEqual(['opt_in', 'decline', 'opt_out', 'url', 'flow_button']);
    expect(BUTTON_ROLES).not.toContain('custom');
  });

  test.each([['custom'], ['OPT_OUT'], [''], [null], [undefined], [5], [{}]])('role %j is an error (a dead button must never reach Meta)', (role) => {
    const r = validateVariant(good({ buttons: [OPT_OUT_AR, { role, text: 'Other' }] }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual({ code: 'invalid_button_role', field: 'buttons.1' });
  });

  test('a non-object button entry does not crash the validator', () => {
    const r = validateVariant(good({ buttons: [OPT_OUT_AR, null, 'x', 7] }));
    expect(codes(r.errors)).toContain('invalid_button_role');
    expect(codes(r.errors)).toContain('button_label_empty');
  });

  test('opt_in / decline answer pairs are fine on a utility template', () => {
    const r = validateVariant({ language: 'ar', body: 'أهلاً {name}، هل تود أن تصلك عروضنا عبر واتساب؟', buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }] }, { category: 'UTILITY' });
    expect(r.errors).toEqual([]);
  });
});

describe('URL buttons', () => {
  const withUrl = (url, over = {}) => validateVariant(good({ buttons: [OPT_OUT_AR, { role: 'url', text: 'تصفح العروض', url, ...over }] }));

  test('a static https link is valid and counts toward the 10 button limit only', () => {
    expect(withUrl('https://waflowtech.com/offers').errors).toEqual([]);
    expect(withUrl('HTTPS://Example.com/a?b=1&c=%D8%B9#top').errors).toEqual([]);
    expect(withUrl('https://example.com/عرض').errors).toEqual([]); // Arabic path: the URL parser percent-encodes it
  });

  test.each([
    ['', 'button_url_required'],
    ['   ', 'button_url_required'],
    [undefined, 'button_url_required'],
    ['http://example.com', 'button_url_not_https'],
    ['example.com/offers', 'button_url_not_https'],
    ['//example.com/x', 'button_url_not_https'],
    ['javascript:alert(1)', 'button_url_not_https'],
    ['ftp://example.com/x', 'button_url_not_https'],
    ['data:text/html;base64,AAAA', 'button_url_not_https'],
    ['https://example.com/{name}', 'button_url_has_field'],
    ['https://example.com/{{1}}', 'button_url_has_field'],
    ['https://example.com/a b', 'button_url_invalid'],
    ['https://example.com/{x', 'button_url_invalid'],
    ['https://localhost/x', 'button_url_invalid'],
    ['https://intranet/x', 'button_url_invalid'],
    ['https://user:pass@example.com/x', 'button_url_invalid'],
    ['https://', 'button_url_invalid'],
  ])('%j -> %s', (url, code) => {
    const r = withUrl(url);
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toContain(code);
  });

  test(`a URL longer than ${LIMITS.URL} characters is rejected, exactly ${LIMITS.URL} is not`, () => {
    const base = 'https://example.com/';
    expect(codes(withUrl(base + 'a'.repeat(LIMITS.URL - base.length)).errors)).not.toContain('button_url_too_long');
    const r = withUrl(base + 'a'.repeat(LIMITS.URL - base.length + 1));
    expect(r.errors).toContainEqual({ code: 'button_url_too_long', field: 'buttons.1', detail: { length: LIMITS.URL + 1, max: LIMITS.URL } });
  });

  test('the label rules apply to URL buttons too (<= 20 characters)', () => {
    expect(codes(withUrl('https://example.com', { text: 'x'.repeat(21) }).errors)).toContain('button_label_too_long');
    expect(codes(withUrl('https://example.com', { text: '' }).errors)).toContain('button_label_empty');
  });

  test('at most 2 URL buttons', () => {
    const three = validateVariant(good({ buttons: [OPT_OUT_AR, ...[1, 2, 3].map((n) => ({ role: 'url', text: `رابط ${n}`, url: `https://example.com/${n}` }))] }));
    expect(three.errors).toContainEqual({ code: 'too_many_url_buttons', field: 'buttons', detail: { count: 3, max: 2 } });
    const two = validateVariant(good({ buttons: [OPT_OUT_AR, ...[1, 2].map((n) => ({ role: 'url', text: `رابط ${n}`, url: `https://example.com/${n}` }))] }));
    expect(codes(two.errors)).not.toContain('too_many_url_buttons');
  });

  test('quick replies must come before URL buttons (Meta groups them)', () => {
    const wrong = validateVariant(good({ buttons: [{ role: 'url', text: 'تصفح', url: 'https://example.com' }, OPT_OUT_AR] }));
    expect(wrong.errors).toContainEqual({ code: 'buttons_wrong_order', field: 'buttons.1' });
    const right = validateVariant(good({ buttons: [OPT_OUT_AR, { role: 'url', text: 'تصفح', url: 'https://example.com' }] }));
    expect(codes(right.errors)).not.toContain('buttons_wrong_order');
  });

  test('the order error is reported once, not per button', () => {
    const r = validateVariant(good({ buttons: [{ role: 'url', text: 'تصفح', url: 'https://example.com' }, OPT_OUT_AR, { role: 'decline', text: 'لا' }] }));
    expect(codes(r.errors).filter((c) => c === 'buttons_wrong_order')).toHaveLength(1);
  });

  test('a url on a quick-reply button is ignored, not an error', () => {
    expect(validateVariant(good({ buttons: [{ ...OPT_OUT_AR, url: 'http://not-checked.example' }] })).errors).toEqual([]);
  });

  test('validateButtonUrl is usable on its own', () => {
    expect(validateButtonUrl('https://example.com')).toBeNull();
    expect(validateButtonUrl('http://example.com')).toEqual({ code: 'button_url_not_https' });
    expect(validateButtonUrl(12345)).toEqual({ code: 'button_url_required' });
  });
});

describe('flow buttons (payload msgnode_<nodeId>_<position>)', () => {
  const flowButtons = [{ role: 'flow_button', text: 'تسوق الآن' }, OPT_OUT_AR];

  test('only meaningful on a template linked to a flow message', () => {
    const unlinked = validateVariant(good({ buttons: flowButtons }));
    expect(unlinked.errors).toContainEqual({ code: 'flow_button_without_message_node', field: 'buttons.0' });
    const linked = validateVariant(good({ buttons: flowButtons }), { linkedMessageNodeId: '65a1b2c3d4e5f60718293a4b' });
    expect(linked.errors).toEqual([]);
  });
});

describe('consent buttons speak the message language (spec §3.4)', () => {
  test('an Arabic variant with a Latin-only consent label is warned about, not blocked', () => {
    const r = validateVariant(good({ buttons: [{ role: 'opt_out', text: 'Opt Out' }] }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toContainEqual({ code: 'button_wrong_language', field: 'buttons.0', detail: { role: 'opt_out' } });
  });
  test('an English variant with an Arabic-only consent label is warned about', () => {
    const r = validateVariant({ language: 'en', body: 'Hi {name}, enjoy this week with us at the shop.', buttons: [OPT_OUT_AR] });
    expect(codes(r.warnings)).toContain('button_wrong_language');
  });
  test('matching language, mixed labels, bilingual variants and non-consent roles are not warned about', () => {
    expect(codes(validateVariant(good()).warnings)).not.toContain('button_wrong_language');
    expect(codes(validateVariant(good({ buttons: [{ role: 'opt_out', text: 'إلغاء STOP' }] })).warnings)).not.toContain('button_wrong_language');
    expect(codes(validateVariant(good({ language: 'bilingual', buttons: [{ role: 'opt_out', text: 'Opt Out' }] })).warnings)).not.toContain('button_wrong_language');
    const urlOnly = validateVariant(good({ buttons: [OPT_OUT_AR, { role: 'url', text: 'Shop now', url: 'https://example.com' }] }));
    expect(codes(urlOnly.warnings)).not.toContain('button_wrong_language');
  });
});

describe('bilingual variants', () => {
  const both = 'مرحباً {name}، لدينا عرض جديد لك اليوم.\n\nHello {name}, we have a new offer for you today.';
  const bi = (over = {}) => validateVariant({ language: 'bilingual', bilingualOrder: 'ar_first', body: both, buttons: [OPT_OUT_AR], ...over });

  test('Arabic paragraph first + English second, declared ar_first: no warnings', () => {
    expect(bi().warnings).toEqual([]);
  });
  test('en_first with the English paragraph first is fine too', () => {
    const body = 'Hello {name}, we have a new offer for you today.\n\nمرحباً {name}، لدينا عرض جديد لك اليوم.';
    expect(bi({ bilingualOrder: 'en_first', body }).warnings).toEqual([]);
  });
  test('the declared order must match the body (the Meta language code follows it)', () => {
    expect(codes(bi({ bilingualOrder: 'en_first' }).warnings)).toContain('bilingual_order_mismatch');
    expect(codes(bi({ bilingualOrder: undefined, body: 'Hello {name}, new offer today.\n\nمرحباً {name}، عرض جديد اليوم.' }).warnings)).toContain('bilingual_order_mismatch');
  });
  test('a bilingual body must contain both languages (merge-field names do not count as English)', () => {
    expect(codes(bi({ body: 'مرحباً {name}، لدينا عرض جديد لك اليوم.' }).warnings)).toContain('bilingual_needs_both_languages');
    expect(codes(bi({ body: 'Hello {name}, we have a new offer for you today.' }).warnings)).toContain('bilingual_needs_both_languages');
  });
  test('an empty bilingual body only reports body_required', () => {
    const r = bi({ body: '' });
    expect(codes(r.errors)).toContain('body_required');
    expect(r.warnings).toEqual([]);
  });
});

test('a bilingual body may repeat a field once per language, but not within one paragraph', () => {
  const body = (text) => ({ language: 'bilingual', bilingualOrder: 'ar_first', body: text, buttons: [OPT_OUT_AR] });
  expect(codes(validateVariant(body('مرحباً {name}، لدينا عرض جديد لك اليوم.\n\nHello {name}, we have a new offer today.')).warnings)).not.toContain('repeated_field');
  expect(codes(validateVariant(body('مرحباً {name} و {name}، لدينا عرض جديد لك اليوم.\n\nHello {name}, we have a new offer today.')).warnings)).toContain('repeated_field');
});
