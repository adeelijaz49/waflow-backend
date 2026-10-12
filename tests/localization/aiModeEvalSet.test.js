// The invariants of the Arabic AI Mode evaluation set (B7b): the spec's minimum
// size and coverage, that every expectation points at real tools and real canned
// ids, and that each case really has the digit style and language it claims.
// No network, no database: the tool names come from the real ai/tools.js source
// loaded with its imports stubbed.
const evalSet = require('../../shared/localization/aiMode/evalSet');
const runner = require('../../shared/localization/aiMode/evalRunner');

const { CASES, CORE_INTENTS, STYLES, ACTION_TOOLS, WRITE_TOOLS } = evalSet;
const toolNames = runner.loadToolDefinitions().TOOLS.map((t) => t.name);

const ARABIC_INDIC = /[\u{0660}-\u{0669}]/u;
const WESTERN = /[0-9]/;
const ARABIC_LETTER = /[\u{0621}-\u{064A}]/u;
const byId = (id) => CASES.find((c) => c.id === id);

describe('size and coverage (spec §6)', () => {
  test('at least 60 cases (the spec asks for 40)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  test('ids are unique', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  test('every one of the 7 intents appears in every one of the 3 styles', () => {
    for (const intent of CORE_INTENTS) {
      for (const style of STYLES) {
        expect(CASES.filter((c) => c.intent === intent && c.style === style).length).toBeGreaterThan(0);
      }
    }
  });

  test('both Arabic-Indic and Western digits are used, for every intent that contains a number', () => {
    const numeric = ['winback', 'inactive', 'top_loyalty', 'send_reminder', 'create_promotion'];
    for (const intent of numeric) {
      const digits = new Set(CASES.filter((c) => c.intent === intent).map((c) => c.digits));
      expect(digits.has('arabic-indic')).toBe(true);
      expect(digits.has('western')).toBe(true);
    }
    expect(CASES.filter((c) => c.digits === 'arabic-indic').length).toBeGreaterThanOrEqual(15);
    expect(CASES.filter((c) => c.digits === 'western').length).toBeGreaterThanOrEqual(15);
  });

  test('at least 8 ambiguous cases, in more than one style, all flagged and all forbidding every action and draft', () => {
    const ambiguous = CASES.filter((c) => c.ambiguous);
    expect(ambiguous.length).toBeGreaterThanOrEqual(8);
    expect(ambiguous.every((c) => c.intent === 'ambiguous')).toBe(true);
    expect(CASES.filter((c) => c.intent === 'ambiguous').every((c) => c.ambiguous)).toBe(true);
    expect(new Set(ambiguous.map((c) => c.style)).size).toBeGreaterThan(1);
    for (const c of ambiguous) {
      for (const tool of WRITE_TOOLS) expect(c.expect.forbid).toContain(tool);
    }
  });

  test('extraction-heavy cases exist: days, top-N, month and year phrases, order status, discounts', () => {
    const args = new Set(CASES.flatMap((c) => c.expect.tools.flatMap((e) => (e.oneOf || [e]).flatMap((o) => Object.keys(o.args || {})))));
    for (const key of ['days', 'limit', 'month', 'year', 'status', 'discountPercent', 'pointsPrice', 'metric', 'promotionId', 'customerIds']) {
      expect(args.has(key)).toBe(true);
    }
  });

  test('the six MSA sample prompts of the website are included', () => {
    const prompts = CASES.map((c) => c.prompt);
    for (const sample of [
      'ابحث عن العملاء الذين لم يطلبوا منذ ٣٠ يوماً وأعدهم إلينا',
      'من هو العميل الأكثر نقاط ولاء حالياً؟',
      'أي عرض ترويجي كان الأفضل أداءً الشهر الماضي؟',
      'أي العملاء يجب أن أستهدف اليوم؟',
      'أنشئ حملة عودة للعملاء الخاملين',
      'ابحث عن العملاء الذين لم يزوروننا منذ ٣٠ يوماً وأنشئ لهم حملة عودة.',
    ]) {
      expect(prompts).toContain(sample);
    }
  });
});

describe('each case is what it claims to be', () => {
  test('the digit style matches the text', () => {
    for (const c of CASES) {
      if (c.digits === 'arabic-indic') expect([c.id, ARABIC_INDIC.test(c.prompt)]).toEqual([c.id, true]);
      if (c.digits === 'western') expect([c.id, WESTERN.test(c.prompt)]).toEqual([c.id, true]);
      if (c.digits === 'none') expect([c.id, ARABIC_INDIC.test(c.prompt) || WESTERN.test(c.prompt)]).toEqual([c.id, false]);
      if (c.digits !== 'arabic-indic') expect([c.id, ARABIC_INDIC.test(c.prompt)]).toEqual([c.id, false]);
    }
  });

  test('every prompt is Arabic or mixed, the English equivalent has no Arabic, and "mixed" really has both scripts', () => {
    for (const c of CASES) {
      expect([c.id, ARABIC_LETTER.test(c.prompt)]).toEqual([c.id, true]);
      expect([c.id, ARABIC_LETTER.test(c.english)]).toEqual([c.id, false]);
      if (c.style === 'mixed') expect([c.id, /[A-Za-z]{3,}/.test(c.prompt)]).toEqual([c.id, true]);
    }
  });

  test('the English equivalent of a prompt with a number carries the same number', () => {
    for (const c of CASES.filter((x) => x.digits !== 'none')) {
      const numbers = c.prompt.match(/[\u{0660}-\u{0669}0-9]+/gu).map((n) => n.replace(/[\u{0660}-\u{0669}]/gu, (d) => String(d.codePointAt(0) - 0x0660)));
      for (const n of numbers) expect([c.id, c.english.includes(n)]).toEqual([c.id, true]);
    }
  });

  test('the numbers that must be extracted appear in the prompt (digits or the right number word)', () => {
    expect(byId('I03').expect.tools[0].args.days).toBe(60);
    expect(byId('I03').prompt).toMatch(/٦٠/);
    expect(byId('T01').expect.tools[0].args.limit).toBe(10);
    expect(byId('P01').prompt).toMatch(/٢٠٪/);
    expect(byId('P05').expect.tools[0].args.pointsPrice).toBe(500);
    expect(byId('W07').expect.tools[0].args.days).toBe(30); // "من شهر"
    expect(byId('W06').expect.tools[0].args.days).toBe(90); // "3 شهور"
    expect(byId('M01').expect.tools[0].args).toMatchObject({ month: 9 }); // last month, fixed clock 2026-10-11
  });

  test('prompts are short chat messages', () => {
    for (const c of CASES) {
      expect(c.prompt.length).toBeLessThan(200);
      expect(c.prompt).toBe(c.prompt.trim());
    }
  });
});

describe('expectations are consistent with the real tool registry and the dry-run data', () => {
  test('validateCases reports no problem', () => {
    expect(evalSet.validateCases(CASES, { toolNames, resolveRef: runner.resolveRef })).toEqual([]);
  });

  test('validateCases does catch each kind of mistake', () => {
    const base = CASES[0];
    const bad = (patch) => evalSet.validateCases([{ ...base, ...patch }], { toolNames, resolveRef: runner.resolveRef });
    expect(evalSet.validateCases([base, base], { toolNames, resolveRef: runner.resolveRef }).join()).toMatch(/duplicate id/);
    expect(bad({ expect: { tools: [{ name: 'drop_database' }], forbid: [] } }).join()).toMatch(/unknown tool drop_database/);
    expect(bad({ expect: { tools: [{ name: 'get_campaign_report', args: { promotionId: '@promo.nope' } }], forbid: [] } }).join()).toMatch(/unresolved ref @promo.nope/);
    expect(bad({ expect: { tools: [{ name: 'list_inactive_customers' }], forbid: ['list_inactive_customers'] } }).join()).toMatch(/both expected and forbidden/);
    expect(bad({ style: 'klingon' }).join()).toMatch(/bad style/);
    expect(bad({ intent: 'dance' }).join()).toMatch(/bad intent/);
  });

  test('forbid never contains a tool the case expects, and action expectations are only for the send_reminder intent', () => {
    for (const c of CASES) {
      const expected = c.expect.tools.flatMap(evalSet.entryNames);
      for (const name of expected) expect(c.expect.forbid).not.toContain(name);
      if (expected.some((n) => ACTION_TOOLS.includes(n))) expect(c.intent).toBe('send_reminder');
    }
  });

  test('read-only question intents forbid every action and every draft', () => {
    for (const c of CASES.filter((x) => ['inactive', 'top_loyalty', 'best_promotion', 'campaign_results', 'return_rate', 'orders', 'insights'].includes(x.intent))) {
      for (const tool of WRITE_TOOLS) expect([c.id, c.expect.forbid.includes(tool)]).toEqual([c.id, true]);
    }
  });

  test('"send to everyone" reminders require customerIds to be left out; named ones require exactly those ids', () => {
    expect(byId('R01').expect.tools[0].args.customerIds).toEqual({ absent: true });
    expect(byId('R05').expect.tools[0].args.customerIds).toEqual({ exactIds: ['@cust.ahmed'] });
  });

  test('every expected id reference resolves to a 24-hex id', () => {
    for (const c of CASES) {
      for (const ref of evalSet.collectRefs(c.expect.tools)) expect(runner.resolveRef(ref)).toMatch(/^[0-9a-f]{24}$/);
    }
  });
});
