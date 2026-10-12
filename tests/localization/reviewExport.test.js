const fs = require('fs');
const path = require('path');
const { buildState, exportCsv, planImport, applyUpdates, COLUMNS } = require('../../shared/localization/reviewExport');
const { parseCsv, stringifyCsv, BOM } = require('../../shared/localization/csv');

const FILES = {
  consent: {
    optOutAck: { en: 'You have been unsubscribed.', ar: 'تم إلغاء اشتراكك.', status: 'draft', notes: 'n1' },
    greet: { en: 'Hello {name}, welcome to {business}', ar: 'مرحباً {name}، أهلاً بك في {business}', status: 'draft', needsLegalApproval: true },
    old: { en: 'Thank you very much for visiting', ar: 'شكراً جزيلاً لزيارتك', status: 'reviewed', reviewer: 'Sara', reviewedAt: '2026-01-02T00:00:00.000Z' },
    empty: { en: 'Not translated yet', status: 'draft' },
  },
  aimode: { a: { en: 'Please confirm the action', ar: 'يرجى تأكيد الإجراء', status: 'draft' } },
};
const LIBRARY = [{ key: 'library.welcome.ar.body', english: 'Welcome to our shop today', arabic: 'أهلاً بك في متجرنا اليوم', status: 'draft', needsLegalApproval: false }];
const TEXTS = () => Object.fromEntries(Object.entries(FILES).map(([ns, o]) => [ns, `${JSON.stringify(o, null, 2)}\n`]));
const state = () => buildState(FILES, LIBRARY);
const cp = (...codes) => String.fromCodePoint(...codes);

function csvOf(rows) {
  return stringifyCsv([['key', 'english', 'arabic', 'status', 'reviewer', 'reviewed_at'], ...rows]);
}
function plan(rows, opts) { return planImport(csvOf(rows), state(), { today: '2026-05-05', ...opts }); }
const outcome = (p, key) => p.results.find((r) => r.key === key);

describe('exportCsv', () => {
  test('BOM, CRLF, header, deterministic order (namespace, key), library rows marked manual', () => {
    const { csv, count } = exportCsv(state());
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toContain('\r\n');
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(COLUMNS);
    expect(count).toBe(6);
    expect(rows.map((r) => r.key)).toEqual(['aimode.a', 'consent.empty', 'consent.greet', 'consent.old', 'consent.optOutAck', 'library.welcome.ar.body']);
    expect(rows.find((r) => r.key === 'library.welcome.ar.body').apply).toBe('manual');
    expect(rows.find((r) => r.key === 'consent.greet').needs_legal).toBe('yes');
    expect(rows.find((r) => r.key === 'consent.empty').status).toBe('draft');
    expect(exportCsv(state()).csv).toBe(csv);
  });

  test('Arabic round-trips byte-exact', () => {
    const { rows } = parseCsv(exportCsv(state()).csv);
    expect(rows.find((r) => r.key === 'consent.optOutAck').arabic).toBe(FILES.consent.optOutAck.ar);
  });

  test('--only-unreviewed and --namespace filters', () => {
    const rows = parseCsv(exportCsv(state(), { onlyUnreviewed: true }).csv).rows.map((r) => r.key);
    expect(rows).not.toContain('consent.old');
    expect(rows).toContain('consent.empty');
    expect(parseCsv(exportCsv(state(), { namespace: 'aimode' }).csv).rows).toHaveLength(1);
  });

  test('formula-looking cells are neutralised on export and restored on import', () => {
    const s = buildState({ x: { k: { en: '=SUM(A1) is not a formula', ar: '=مرحباً بك في متجرنا الكبير', status: 'draft' } } });
    const { csv } = exportCsv(s);
    expect(csv).toContain("'=SUM");
    expect(planImport(csv, s, {}).summary).toMatchObject({ updated: 0, unchanged: 1, rejected: 0 });
  });
});

describe('planImport state machine', () => {
  test('an untouched export re-imports with no changes', () => {
    const p = planImport(exportCsv(state()).csv, state(), {});
    expect(p.summary).toMatchObject({ updated: 0, rejected: 0, unchanged: 6 });
  });

  test('changed text without explicit reviewed becomes draft, even if it was reviewed', () => {
    const p = plan([['consent.old', '', 'شكراً لزيارتك لنا', '', '', '']]);
    expect(p.updates).toEqual([{ key: 'consent.old', arabic: 'شكراً لزيارتك لنا', status: 'draft', reviewer: null, reviewedAt: null }]);
  });

  test('reviewed + unchanged text only flips the status, with reviewer and default date', () => {
    const p = plan([['consent.optOutAck', '', 'تم إلغاء اشتراكك.', 'Reviewed', 'Huda', '']]);
    expect(p.updates).toEqual([{ key: 'consent.optOutAck', arabic: 'تم إلغاء اشتراكك.', status: 'reviewed', reviewer: 'Huda', reviewedAt: '2026-05-05T00:00:00.000Z' }]);
    expect(p.summary.reviewedWithEdits).toEqual([]);
  });

  test('reviewed + changed text is accepted and listed as a reviewer edit', () => {
    const p = plan([['consent.optOutAck', '', 'تم إلغاء اشتراكك بنجاح.', 'reviewed', 'Huda', '2026-04-01']]);
    expect(p.updates[0]).toMatchObject({ status: 'reviewed', reviewedAt: '2026-04-01T00:00:00.000Z', arabic: 'تم إلغاء اشتراكك بنجاح.' });
    expect(p.summary.reviewedWithEdits).toEqual(['consent.optOutAck']);
  });

  test('--reviewer option supplies the name; a missing reviewer is rejected', () => {
    expect(plan([['aimode.a', '', 'يرجى تأكيد الإجراء', 'reviewed', '', '']], { reviewer: 'Nour' }).updates[0].reviewer).toBe('Nour');
    const p = plan([['aimode.a', '', 'يرجى تأكيد الإجراء', 'reviewed', '', '']]);
    expect(outcome(p, 'aimode.a').reasons.join()).toMatch(/reviewer name/);
    expect(p.updates).toEqual([]);
  });

  test('an already-reviewed unchanged row keeps reviewer/date; draft flips back and clears them', () => {
    expect(plan([['consent.old', '', 'شكراً جزيلاً لزيارتك', 'reviewed', '', '']]).summary.unchanged).toBe(1);
    const p = plan([['consent.old', '', 'شكراً جزيلاً لزيارتك', 'draft', '', '']]);
    expect(p.updates[0]).toMatchObject({ status: 'draft', reviewer: null, reviewedAt: null });
  });

  test('an empty status cell keeps the stored status when the text is unchanged', () => {
    expect(plan([['consent.old', '', 'شكراً جزيلاً لزيارتك', '', '', '']]).summary.unchanged).toBe(1);
  });

  test('a missing translation can be filled in (as draft)', () => {
    const p = plan([['consent.empty', '', 'لم تتم الترجمة بعد', '', '', '']]);
    expect(p.updates[0]).toMatchObject({ key: 'consent.empty', status: 'draft' });
  });

  test('tanween in canonical order is normalised to alef + fathatan and noted', () => {
    const wanted = 'شكراً جزيلاً لزيارتك لنا';
    const reversed = wanted.split(cp(0x0627, 0x064b)).join(cp(0x064b, 0x0627));
    expect(reversed).not.toBe(wanted);
    const p = plan([['consent.old', '', reversed, '', '', '']]);
    expect(p.updates[0].arabic).toBe(wanted);
    expect(outcome(p, 'consent.old').notes.join()).toMatch(/tanween/);
  });
});

describe('planImport validation', () => {
  const reject = (arabic, key = 'consent.optOutAck', status = 'reviewed') => outcome(plan([[key, '', arabic, status, 'Huda', '']]), key).reasons.join(' | ');

  test('unknown keys, duplicates and prototype keys are rejected', () => {
    expect(reject('نص', 'nope.key')).toMatch(/unknown key/);
    expect(reject('نص', '__proto__')).toMatch(/unknown key/);
    const p = plan([['aimode.a', '', 'يرجى تأكيد الإجراء الآن', '', '', ''], ['aimode.a', '', 'يرجى تأكيد الإجراء', '', '', '']]);
    expect(p.results[1].reasons.join()).toMatch(/duplicate/);
  });

  test('placeholder mismatch (missing, extra, renamed) is rejected; reordering is fine', () => {
    expect(reject('مرحباً {name}', 'consent.greet')).toMatch(/placeholders differ/);
    expect(reject('مرحباً {name}، أهلاً في {business} {x}', 'consent.greet')).toMatch(/placeholders differ/);
    expect(reject('مرحباً {nome}، أهلاً بك في {business}', 'consent.greet')).toMatch(/placeholders differ/);
    expect(reject('أهلاً بك في {business} يا {name}', 'consent.greet')).toBe('');
  });

  test('invisible and bidi control characters are rejected', () => {
    for (const code of [0x200f, 0x200e, 0x202b, 0x2067, 0x200b, 0xfeff, 0xad]) {
      expect(reject(`تم إلغاء ${cp(code)}اشتراكك.`)).toMatch(/invisible/);
    }
  });

  test('Arabic-Indic and Persian digits are rejected', () => {
    expect(reject(`تم إلغاء اشتراكك ${cp(0x0661)}.`)).toMatch(/Arabic-Indic/);
    expect(reject(`تم إلغاء اشتراكك ${cp(0x06f2)}.`)).toMatch(/Arabic-Indic/);
  });

  test('leading/trailing spaces and implausible length are rejected', () => {
    expect(reject(' تم إلغاء اشتراكك.')).toMatch(/leading or trailing/);
    expect(reject('تم')).toMatch(/length/);
    expect(reject('تم إلغاء اشتراكك '.repeat(20).trim())).toMatch(/length/);
  });

  test('reviewed needs a non-empty Arabic string; an empty cell never erases an existing one', () => {
    expect(reject('', 'consent.empty')).toMatch(/empty/);
    expect(reject('', 'consent.optOutAck', 'draft')).toMatch(/never erased/);
  });

  test('bad status and bad date are rejected', () => {
    expect(reject('تم إلغاء اشتراكك.', 'consent.optOutAck', 'approved')).toMatch(/draft or reviewed/);
    const p = plan([['consent.optOutAck', '', 'تم إلغاء اشتراكك.', 'reviewed', 'Huda', '12/05/2026']]);
    expect(p.results[0].reasons.join()).toMatch(/ISO date/);
  });

  test('library rows are read-only: any change is rejected, unchanged is fine', () => {
    expect(reject('نص جديد طويل بما يكفي هنا', 'library.welcome.ar.body', 'draft')).toMatch(/templateLibrary\.js/);
    const p = plan([['library.welcome.ar.body', '', 'أهلاً بك في متجرنا اليوم', '', '', '']]);
    expect(p.summary).toMatchObject({ unchanged: 1, rejected: 0 });
  });

  test('English edits are ignored with a note; missing columns throw; blank lines are skipped', () => {
    const p = plan([['aimode.a', 'Different English', 'يرجى تأكيد الإجراء', '', '', ''], ['', '', '', '', '', '']]);
    expect(p.results).toHaveLength(1);
    expect(p.results[0].notes.join()).toMatch(/English/);
    expect(() => planImport('a,b\n1,2\n', state())).toThrow(/key/);
  });

  test('semicolon-delimited, BOM-prefixed Excel files work', () => {
    const csv = `${BOM}key;english;arabic;status;reviewer;reviewed_at\r\naimode.a;;يرجى تأكيد الإجراء;reviewed;Huda;\r\n`;
    const p = planImport(csv, state(), { today: '2026-05-05' });
    expect(p.updates[0]).toMatchObject({ key: 'aimode.a', status: 'reviewed', reviewer: 'Huda' });
  });
});

describe('strict mode and applyUpdates', () => {
  const rows = [['aimode.a', '', 'يرجى تأكيد الإجراء', 'reviewed', 'Huda', ''], ['nope.key', '', 'x', '', '', '']];

  test('non-strict applies the valid rows; strict applies nothing', () => {
    expect(plan(rows).summary).toMatchObject({ updated: 1, rejected: 1 });
    const s = plan(rows, { strict: true });
    expect(s.updates).toEqual([]);
    expect(s.summary).toMatchObject({ updated: 0, rejected: 1, blockedByStrict: 1 });
  });

  test('applyUpdates keeps key order, indentation and untouched entries; never touches en', () => {
    const out = applyUpdates(TEXTS(), [{ key: 'consent.old', arabic: 'شكراً لزيارتك لنا', status: 'draft', reviewer: null, reviewedAt: null }]);
    expect(Object.keys(out)).toEqual(['consent']);
    const parsed = JSON.parse(out.consent);
    expect(Object.keys(parsed)).toEqual(Object.keys(FILES.consent));
    expect(parsed.old).toEqual({ en: FILES.consent.old.en, ar: 'شكراً لزيارتك لنا', status: 'draft', reviewer: null, reviewedAt: null });
    expect(parsed.optOutAck).toEqual(FILES.consent.optOutAck);
    expect(out.consent.endsWith('}\n')).toBe(true);
    expect(out.consent).toContain('\n  "old": {\n    "en"');
    expect(out.consent).toContain('شكراً لزيارتك لنا');
  });

  test('applyUpdates sets reviewer fields on a review and adds no null fields to drafts', () => {
    const out = JSON.parse(applyUpdates(TEXTS(), [
      { key: 'aimode.a', arabic: 'يرجى تأكيد الإجراء', status: 'reviewed', reviewer: 'Huda', reviewedAt: '2026-05-05T00:00:00.000Z' },
    ]).aimode);
    expect(out.a).toMatchObject({ status: 'reviewed', reviewer: 'Huda', reviewedAt: '2026-05-05T00:00:00.000Z' });
    const draft = JSON.parse(applyUpdates(TEXTS(), [{ key: 'aimode.a', arabic: 'يرجى التأكيد من فضلك', status: 'draft', reviewer: null, reviewedAt: null }]).aimode);
    expect('reviewer' in draft.a).toBe(false);
  });

  test('applyUpdates refuses unknown keys/namespaces and returns nothing for no updates', () => {
    expect(() => applyUpdates(TEXTS(), [{ key: 'aimode.zzz', arabic: 'x', status: 'draft' }])).toThrow(/unknown key/);
    expect(() => applyUpdates(TEXTS(), [{ key: 'ghost.a', arabic: 'x', status: 'draft' }])).toThrow(/no catalogue/);
    expect(applyUpdates(TEXTS(), [])).toEqual({});
  });

  test('the real catalogue files are already in the canonical JSON format (writes make no diff noise)', () => {
    const dir = path.join(__dirname, '..', '..', 'shared', 'localization', 'catalog');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      // A Windows checkout (core.autocrlf) turns LF into CRLF on disk; the canonical format is the LF one.
      const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
      expect(`${JSON.stringify(JSON.parse(text), null, 2)}\n`).toBe(text);
    }
  });
});
