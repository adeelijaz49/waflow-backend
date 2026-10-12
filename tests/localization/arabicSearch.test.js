// Pure tests for the Arabic-aware search builder: the filters it produces are
// evaluated against a corpus with the in-memory matcher (JS RegExp), so a wrong
// pattern fails a test. The same filters were also run against a real MongoDB
// 8.3 and returned identical results (see the slice report).
const {
  buildSearchFilter, tokenize, namePattern, phonePattern, nationalDigits, escapeRegex, MAX_TERM_LENGTH, MAX_TOKENS,
} = require('../../shared/localization/arabicSearch');
const { matches } = require('./helpers/fakeMongo');

const doc = (firstname, lastname, phone) => ({ firstname, lastname, phone });
const CORPUS = [
  doc('محمد', 'العتيبي', '966501234567'),
  doc('مُحَمَّد', 'القحطاني', '0551234567'),
  doc('أحمد', 'الحربي', '+966 53 123 4567'),
  doc('احمد', 'الدوسري', '966561111111'),
  doc('إبراهيم', 'الغامدي', '966572222222'),
  doc('سارة', 'أحمد', '966503333333'),
  doc('فاطمة', 'علي', '966504444444'),
  doc('فاطمه', 'على', '966505555555'),
  doc('عائشة', 'محمد', '966506666666'),
  doc('عايشه', 'سعد', '966507777777'),
  doc('مؤمن', 'خالد', '966508888881'),
  doc('Sara', 'Ahmed', '61412345678'),
  doc('sara', 'AL-Harbi', '(050) 888-9999'),
  doc('John', "O'Brien", '966509999999'),
  doc('Table 5', 'Guest', '966501010101'),
  doc('ليلى', 'كريم', '9665٠٢٢٢٢٢٢٢'),
  doc('عبد الله', 'المطيري', '966508888888'),
  doc('😀 Emoji', 'Fan', '966500000000'),
  doc('Bob', '.*', '966511111111'),
  doc('Q', 'a(b', '966522222222'),
  doc('كلمة', 'مَرْحَبًا', '966533333333'),
  doc('Customer', 'Tatweel', '966544444444'),
];
const label = (d) => `${d.firstname} ${d.lastname}`;
const S = (names) => [...names].sort();
const find = (term, options, corpus = CORPUS) => {
  const { filter } = buildSearchFilter(term, options);
  return corpus.filter((d) => matches(d, filter)).map(label).sort();
};

describe('degenerate terms', () => {
  test.each([[undefined], [null], [''], ['   '], ['\t\n']])('%j -> no filter', (term) => {
    expect(buildSearchFilter(term)).toEqual({ filter: {}, normalizedTokens: [] });
  });

  test('control characters (including NUL) are removed, never forwarded to the regex engine', () => {
    expect(buildSearchFilter('\u{0}\u{1}\u{7F}')).toEqual({ filter: {}, normalizedTokens: [] });
    const { filter } = buildSearchFilter('sa\u{0}ra');
    expect(JSON.stringify(filter)).not.toMatch(/[\u{0}-\u{1F}]/u);
    expect(find('sa\u{0}ra')).toEqual(['Sara Ahmed', 'sara AL-Harbi']);
  });

  test('invisible direction marks and zero-width characters in the term are ignored', () => {
    expect(find('\u{200F}سارة\u{200F}')).toEqual(['سارة أحمد']);
    expect(find('sa\u{200B}ra')).toEqual(['Sara Ahmed', 'sara AL-Harbi']);
    expect(find('\u{202E}sara\u{202C}')).toEqual(['Sara Ahmed', 'sara AL-Harbi']);
  });

  test('a lone separator between words does not break the search', () => {
    expect(find('Sara - Ahmed')).toEqual(['Sara Ahmed']);
    expect(find('Sara , Ahmed')).toEqual(['Sara Ahmed']);
    expect(find('سارة ، أحمد')).toEqual(['سارة أحمد']);
  });

  test('leading/trailing punctuation and Arabic quotation marks are trimmed from tokens', () => {
    expect(find('«سارة»')).toEqual(['سارة أحمد']);
    expect(find('"Sara",')).toEqual(['Sara Ahmed', 'sara AL-Harbi']);
    expect(find('سارة،')).toEqual(['سارة أحمد']);
  });
});

describe('Arabic spelling variants', () => {
  test.each([['احمد'], ['أحمد'], ['إحمد'], ['آحمد'], ['ٱحمد']])('alef family: %s finds every spelling of Ahmad', (term) => {
    expect(find(term)).toEqual(S(['أحمد الحربي', 'احمد الدوسري', 'سارة أحمد']));
  });

  test.each([['فاطمة علي'], ['فاطمه علي'], ['فاطمة على'], ['فاطمه على']])('teh marbuta and yeh/alef maksura: %s', (term) => {
    expect(find(term)).toEqual(['فاطمة علي', 'فاطمه على'].sort());
  });

  test('hamza-on-yeh and hamza-on-waw spellings of common names', () => {
    expect(find('عائشة')).toEqual(['عائشة محمد', 'عايشه سعد'].sort());
    expect(find('عايشة')).toEqual(['عائشة محمد', 'عايشه سعد'].sort());
    expect(find('مومن')).toEqual(['مؤمن خالد']);
    expect(find('مؤمن')).toEqual(['مؤمن خالد']);
  });

  test('Farsi yeh/kaf and heh variants are treated as their Arabic counterparts', () => {
    const corpus = [doc('علی', 'ک', '1'), doc('علي', 'ك', '2')];
    expect(find('علي', undefined, corpus)).toHaveLength(2);
    expect(find('ك', undefined, corpus)).toHaveLength(2);
    expect(find('ک', undefined, corpus)).toHaveLength(2);
    expect(find('علی', undefined, corpus)).toHaveLength(2);
  });

  test('tashkeel in the STORED text does not block a plain query', () => {
    expect(find('محمد')).toEqual(['عائشة محمد', 'محمد العتيبي', 'مُحَمَّد القحطاني'].sort());
    expect(find('مرحبا')).toEqual(['كلمة مَرْحَبًا']);
  });

  test('tashkeel typed in the QUERY still finds plain stored text', () => {
    expect(find('مُحَمَّد')).toEqual(['عائشة محمد', 'محمد العتيبي', 'مُحَمَّد القحطاني'].sort());
    expect(find('مَرْحَبًا')).toEqual(['كلمة مَرْحَبًا']);
  });

  test('tatweel (kashida) in the query or in the stored text', () => {
    expect(find('محـــمد')).toEqual(['عائشة محمد', 'محمد العتيبي', 'مُحَمَّد القحطاني'].sort());
    const corpus = [doc('محـمـد', 'x', '1')];
    expect(find('محمد', undefined, corpus)).toHaveLength(1);
  });

  test('Arabic presentation forms typed in the query are normalised (NFKC)', () => {
    const presentation = String.fromCodePoint(0xFEE3, 0xFEA4, 0xFEE4, 0xFEAA);
    expect(presentation.normalize('NFKC')).toBe('محمد');
    expect(find(presentation)).toEqual(['عائشة محمد', 'محمد العتيبي', 'مُحَمَّد القحطاني'].sort());
  });

  test('substring matches inside a name; letters must stay in order', () => {
    expect(find('طيم')).toEqual([]); // not a substring of any name
    expect(find('براه')).toEqual(['إبراهيم الغامدي']);
    expect(find('مري')).toEqual([]); // the letters are not consecutive in "المطيري"
  });

  test('every token must match (AND), in any order, across first and last name', () => {
    expect(find('سارة أحمد')).toEqual(['سارة أحمد']);
    expect(find('أحمد سارة')).toEqual(['سارة أحمد']);
    expect(find('سارة محمد')).toEqual([]);
    expect(find('عبد الله')).toEqual(['عبد الله المطيري']);
    expect(find('عبد الله المطيري')).toEqual(['عبد الله المطيري']);
    expect(find('المطيري عبد')).toEqual(['عبد الله المطيري']);
  });

  test('a long compound Arabic name', () => {
    const corpus = [doc('عبد الرحمن بن عبد العزيز', 'آل سعود', '1')];
    expect(find('عبدالرحمن', undefined, corpus)).toEqual([]); // no space-joined guessing
    expect(find('عبد الرحمن بن عبد العزيز آل سعود', undefined, corpus)).toHaveLength(1);
    expect(find('ال سعود', undefined, corpus)).toHaveLength(1);
  });
});

describe('Latin, mixed and special content', () => {
  test('case-insensitive, any order, across both name fields', () => {
    expect(find('SARA ahmed')).toEqual(['Sara Ahmed']);
    expect(find('ahmed sara')).toEqual(['Sara Ahmed']);
    expect(find('al-harbi')).toEqual(['sara AL-Harbi']);
    expect(find("o'brien")).toEqual(["John O'Brien"]);
  });

  test('Latin text inside Arabic names and vice versa', () => {
    const corpus = [doc('أحمد (Ahmed)', 'Ltd', '1'), doc('Cafe', 'مقهى', '2')];
    expect(find('ahmed', undefined, corpus)).toHaveLength(1);
    expect(find('احمد', undefined, corpus)).toHaveLength(1);
    expect(find('cafe مقهى', undefined, corpus)).toHaveLength(1);
  });

  test('emoji are matched literally', () => {
    expect(find('😀')).toEqual(['😀 Emoji Fan']);
    expect(find('😀 emoji')).toEqual(['😀 Emoji Fan']);
  });

  test('digits typed as Arabic-Indic or Persian match digits in names (and the reverse)', () => {
    expect(find('table 5')).toEqual(['Table 5 Guest']);
    expect(find('table ٥')).toEqual(['Table 5 Guest']);
    expect(find('table ۵')).toEqual(['Table 5 Guest']);
    const corpus = [doc('غرفة ٣', 'x', '1')];
    expect(find('غرفة 3', undefined, corpus)).toHaveLength(1);
  });

  test('full-width Latin letters and digits are normalised', () => {
    expect(find('ＳＡＲＡ')).toEqual(['Sara Ahmed', 'sara AL-Harbi']);
    expect(find('ｔａｂｌｅ ５')).toEqual(['Table 5 Guest']);
  });
});

describe('phone numbers', () => {
  const FIND = (term, options = { countryCode: '966' }) => find(term, options);

  test.each([
    ['+966 50 123 4567'], ['+966501234567'], ['00966501234567'], ['00966 50 123 4567'], ['966501234567'], ['0501234567'],
    ['050 123 4567'], ['(050) 123-4567'], ['501234567'], ['٠٥٠١٢٣٤٥٦٧'], ['+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧'], ['۰۵۰۱۲۳۴۵۶۷'], ['050.123.4567'], ['+966-50-123-4567'], ['+966 (0) 50 123 4567'],
  ])('%s finds the stored 966501234567', (term) => {
    expect(FIND(term)).toEqual(['محمد العتيبي']);
  });

  test('a number typed in any format finds a customer stored in ANY format', () => {
    expect(FIND('0551234567')).toEqual(['مُحَمَّد القحطاني']); // stored locally
    expect(FIND('+966551234567')).toEqual(['مُحَمَّد القحطاني']);
    expect(FIND('966551234567')).toEqual(['مُحَمَّد القحطاني']);
    expect(FIND('0531234567')).toEqual(['أحمد الحربي']); // stored "+966 53 123 4567"
    expect(FIND('966531234567')).toEqual(['أحمد الحربي']);
    expect(FIND('0508889999')).toEqual(['sara AL-Harbi']); // stored "(050) 888-9999"
    expect(FIND('966508889999')).toEqual(['sara AL-Harbi']);
  });

  test('stored Arabic-Indic digits are found by Western digits and by Arabic-Indic digits', () => {
    expect(FIND('502222222')).toEqual(['ليلى كريم']);
    expect(FIND('٥٠٢٢٢٢٢٢٢')).toEqual(['ليلى كريم']);
  });

  test('other country codes keep working (no stripping of a different code)', () => {
    expect(FIND('+61 412 345 678')).toEqual(['Sara Ahmed']);
    expect(FIND('61412345678')).toEqual(['Sara Ahmed']);
    expect(FIND('0412345678', { countryCode: '61' })).toEqual(['Sara Ahmed']);
  });

  test('without a country code the number is matched as typed (minus 00 / trunk 0)', () => {
    expect(find('0501234567')).toEqual(['محمد العتيبي']);
    expect(find('+966501234567')).toEqual(['محمد العتيبي']);
  });

  test('partial numbers match as digit substrings', () => {
    expect(FIND('1234567')).toEqual(['Sara Ahmed', 'أحمد الحربي', 'محمد العتيبي', 'مُحَمَّد القحطاني'].sort());
    expect(FIND('4567')).toHaveLength(4);
  });

  test('a different number does not match', () => {
    expect(FIND('0501234568')).toEqual([]);
    expect(FIND('9665022222222')).toEqual([]);
  });

  test('a name plus a number: both must match', () => {
    expect(FIND('محمد 0501234567')).toEqual(['محمد العتيبي']);
    expect(FIND('محمد 0551234567')).toEqual(['مُحَمَّد القحطاني']);
    expect(FIND('سارة 0501234567')).toEqual([]);
  });

  test('a lone "0" or "00" is not stripped to nothing', () => {
    expect(buildSearchFilter('0').normalizedTokens).toEqual(['0']);
    expect(buildSearchFilter('00').normalizedTokens).toEqual(['0']);
    expect(FIND('0').length).toBeGreaterThan(0);
  });

  test('nationalDigits', () => {
    expect(nationalDigits('+966501234567', '966')).toBe('501234567');
    expect(nationalDigits('00966501234567', '966')).toBe('501234567');
    expect(nationalDigits('0501234567', '966')).toBe('501234567');
    expect(nationalDigits('501234567', '966')).toBe('501234567');
    expect(nationalDigits('+9660501234567', '966')).toBe('501234567'); // trunk zero typed after the code
    expect(nationalDigits('+966', '966')).toBe('966'); // too short to strip
    expect(nationalDigits('+61412345678', '966')).toBe('61412345678');
    expect(nationalDigits('0501234567', undefined)).toBe('501234567');
    expect(nationalDigits('+966501234567', '+966')).toBe('501234567'); // formatted code accepted
  });

  test('digit grouping with a lone number is one phone token, not four', () => {
    expect(buildSearchFilter('+966 50 123 4567', { countryCode: '966' }).filter.$and).toHaveLength(1);
    expect(buildSearchFilter('Sara 0501234567').filter.$and).toHaveLength(2);
  });

  test('a stored phone with separators is found by the plain digits', () => {
    const corpus = [doc('A', 'B', '+966 (50) 123-4567'), doc('C', 'D', '966.50.123.4567'), doc('E', 'F', '\u{200E}+966 50 123 4567')];
    expect(find('501234567', { countryCode: '966' }, corpus)).toHaveLength(3);
  });
});

describe('hostile input is searched literally, never interpreted as a pattern', () => {
  const HOSTILE = ['(', ')', '[', ']', '{', '}', '.*', '.+', '\\', '\\\\', '^', '$', '|', 'a|b', '(a+)+$', '(?i)x', '[a-', '\\p{L}', '\\x{0627}', '(?<n>x)', '*', '+', '?', 'a**', '\\d+', '[^a]', '%', '_', '<script>', '"; db.dropDatabase()', "' OR '1'='1"];

  test.each(HOSTILE.map((t) => [t]))('%j compiles in a regex engine and does not throw', (term) => {
    const { filter } = buildSearchFilter(term);
    const patterns = JSON.stringify(filter) && collectPatterns(filter);
    for (const p of patterns) expect(() => new RegExp(p, 'i')).not.toThrow();
  });

  test('".*" matches only text that contains ".*", not everything', () => {
    expect(find('.*')).toEqual(['Bob .*']);
    expect(find('(')).toEqual(['Q a(b']);
    expect(find('a(b')).toEqual(['Q a(b']);
    expect(find('[')).toEqual([]);
    expect(find('\\')).toEqual([]);
    expect(find('a|b')).toEqual([]);
    expect(find('$')).toEqual([]);
    expect(find('^S')).toEqual(find('S')); // anchors are not syntax
  });

  test('regex metacharacters never survive unescaped in a pattern', () => {
    for (const term of ['a.b', 'a*b', 'a+b', 'a?b', 'a^b', 'a$b', 'a(b)c', 'a[b]c', 'a{2}b', 'a|b', 'a\\b']) {
      for (const p of collectPatterns(buildSearchFilter(term).filter)) {
        const bare = p.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
        expect(bare).not.toMatch(/[.^$|?(){}\\]/);
        expect(bare.replace(/\*/g, '')).not.toMatch(/[*+]/); // only the [marks]* repetition is allowed
      }
    }
  });

  test('patterns are flat (no groups, no alternation) so they cannot backtrack catastrophically', () => {
    const patterns = collectPatterns(buildSearchFilter('محمد عبد الله 0501234567 Sara-Ahmed (VIP)', { countryCode: '966' }).filter);
    expect(patterns.length).toBeGreaterThan(5);
    for (const p of patterns) {
      const bare = p.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
      expect(bare).not.toMatch(/[()|{}]/);
    }
  });

  test('a long run of one letter finishes instantly against a long non-matching string', () => {
    const { filter } = buildSearchFilter('ا'.repeat(100));
    const start = Date.now();
    const hit = matches({ firstname: `${'ا'.repeat(5000)}ب`, lastname: '', phone: '' }, filter);
    expect(hit).toBe(true);
    const miss = matches({ firstname: 'ا'.repeat(99), lastname: '', phone: '' }, filter);
    expect(miss).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test.each([[{ $ne: null }], [{ $regex: '.*' }], [['a']], [123], [true], [() => 1]])('non-string %j -> 400 INVALID_INPUT', (value) => {
    let error;
    try { buildSearchFilter(value); } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect(error.status).toBe(400);
    expect(error.code).toBe('INVALID_INPUT');
  });

  test('the term never leaks into $options or into operators', () => {
    const { filter } = buildSearchFilter('x", $where: "1');
    const text = JSON.stringify(filter);
    expect(text).not.toContain('$where');
    for (const clause of filter.$and) {
      for (const cond of clause.$or) {
        const spec = Object.values(cond)[0];
        expect(Object.keys(spec).every((k) => ['$regex', '$options'].includes(k))).toBe(true);
        if (spec.$options) expect(spec.$options).toBe('i');
      }
    }
  });
});

describe('caps', () => {
  test('the term is capped at 100 characters', () => {
    const term = 'ب'.repeat(500);
    const { filter } = buildSearchFilter(term);
    const pattern = filter.$and[0].$or[0].firstname.$regex;
    const letters = pattern.split(']').length; // classes + marks classes
    expect(letters).toBeLessThan(450);
    expect(find('ب'.repeat(100), undefined, [doc('ب'.repeat(100), '', '')])).toHaveLength(1);
    expect(find('ب'.repeat(101), undefined, [doc('ب'.repeat(100), '', '')])).toHaveLength(1); // 101st character is dropped
    expect(MAX_TERM_LENGTH).toBe(100);
  });

  test('at most 6 tokens are used', () => {
    const { filter, normalizedTokens } = buildSearchFilter('a b c d e f g h');
    expect(filter.$and).toHaveLength(MAX_TOKENS);
    expect(normalizedTokens).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(MAX_TOKENS).toBe(6);
  });

  test('duplicate tokens are collapsed', () => {
    expect(buildSearchFilter('sara sara SARA').normalizedTokens).toEqual(['sara']);
  });

  test('a megabyte of input is cut down before any heavy work', () => {
    const start = Date.now();
    const { filter } = buildSearchFilter('سارة '.repeat(200000));
    expect(Date.now() - start).toBeLessThan(500);
    expect(filter.$and.length).toBeLessThanOrEqual(MAX_TOKENS);
  });
});

describe('normalizedTokens and exported helpers', () => {
  test('lower-cased, digits Western, alef unified, phone tokens reduced to national digits', () => {
    expect(buildSearchFilter('  أَحمد   SARA ').normalizedTokens).toEqual(['احمد', 'sara']);
    expect(buildSearchFilter('٠٥٠١٢٣٤٥٦٧', { countryCode: '966' }).normalizedTokens).toEqual(['501234567']);
    expect(buildSearchFilter('table ٥').normalizedTokens).toEqual(['table', '5']);
  });

  test('tokenize exposes the phone digits only for phone-like tokens', () => {
    expect(tokenize('sara 0501234567', { countryCode: '966' })).toEqual([
      { text: 'sara', phone: null },
      { text: '0501234567', phone: '501234567' },
    ]);
  });

  test('escapeRegex escapes ASCII syntax only', () => {
    expect(escapeRegex('.')).toBe('\\.');
    expect(escapeRegex('(')).toBe('\\(');
    expect(escapeRegex('a')).toBe('a');
    expect(escapeRegex('م')).toBe('م');
    expect(escapeRegex('😀')).toBe('😀');
    expect(escapeRegex('-')).toBe('-');
  });

  test('namePattern / phonePattern are what the filter uses', () => {
    const { filter } = buildSearchFilter('سارة 0501234567', { countryCode: '966' });
    expect(filter.$and[0].$or[0].firstname.$regex).toBe(namePattern('سارة'));
    expect(filter.$and[1].$or[2].phone.$regex).toBe(phonePattern('501234567'));
  });

  test('the filter has the documented shape and no workspace in it', () => {
    const { filter } = buildSearchFilter('سارة');
    expect(Object.keys(filter)).toEqual(['$and']);
    expect(filter.$and[0].$or.map((c) => Object.keys(c)[0])).toEqual(['firstname', 'lastname']);
    expect(JSON.stringify(filter)).not.toContain('workspaceId');
  });
});

// All $regex pattern strings in a filter.
function collectPatterns(filter) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.$regex === 'string') out.push(node.$regex);
      Object.values(node).forEach(walk);
    }
  };
  walk(filter);
  return out;
}
