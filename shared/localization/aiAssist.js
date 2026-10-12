'use strict';
// AI drafting helpers for the Arabic localisation feature (spec §4 "Translate to
// Arabic / English" and "Make this Saudi-friendly", §5 inbox helpers "Translate"
// and "Reply in Arabic", §3.6 product name/description suggestions).
//
//   translate({ workspaceId, text, from, to, context, maxLength })
//   saudiFriendly({ workspaceId, text, buttons, context, maxLength })
//   replyInArabic({ workspaceId, englishText, customerMessage, customerName })
//   translateInbound({ workspaceId, text })
//   suggestProduct({ workspaceId, name, description })
//
// Every result is a DRAFT (draft: true). Nothing here persists anything (no
// model is imported) or sends anything (no transport is imported): the merchant
// reviews the draft and the template / catalogue / inbox code saves or sends it
// only after their explicit click (spec §3.6, §8: machine text is only ever a draft).
//
// Never silent. Every result is checked against its source with
// mergeFields.compareProtectedTokens ({merge_fields}, numbers incl. Arabic-Indic,
// percentages, URLs, dates) plus hashtags/@mentions and stray braces. A problem
// (changed tokens, text or button too long, no Arabic in an Arabic draft) earns ONE
// automatic repair call with the exact diff fed back; whatever remains is returned
// WITH an AiWarning (tokens_changed, length_exceeded, button_too_long, not_arabic,
// unchanged) — the draft is never "fixed" silently and never rejected silently.
// Of the two attempts the one with fewer problems wins, and a failed repair call
// never throws away a usable first draft.
//
// Safety / cost controls: input <= 4000 chars; 30 calls per minute per workspace
// (in-memory, so per process); max_tokens <= 1500; one 45 s deadline per request
// via AbortSignal; the text to process only ever reaches the model as DATA between
// random markers (aiPrompts.js); hidden Unicode (zero-width, bidi controls, tag
// characters) is stripped from both input and output. Upstream (Anthropic) errors
// are mapped to AI_UNAVAILABLE / AI_FAILED with no upstream text and no user text
// in the message.
//
// Model call: `claude-sonnet-5` (the id ai/agent.js uses; LOCALIZATION_AI_MODEL
// overrides it). No temperature/top_p (this model family rejects sampling
// parameters). effort "low" (LOCALIZATION_AI_EFFORT overrides it): thinking tokens
// count against max_tokens, and translating/rewriting needs little reasoning, so a
// low effort keeps latency down and leaves the token budget for the answer.
// ai/client.js is required lazily on the first call so that loading this module
// never needs an API key (and tests inject a fake client through `getClient`).
const { countLetters, toWesternDigits } = require('./arabicText');
const { detectLanguage, parseLanguageValue } = require('./languageDetect');
const {
  FIELD_RE, compareProtectedTokens, extractProtectedTokens, extractOccurrences, findInvalidPlaceholders, toPositional,
} = require('./mergeFields');
const { LIMITS, charLength } = require('./metaConstraints');
const prompts = require('./aiPrompts');

const {
  TASKS, CONTEXTS, DEFAULT_CONTEXT, CONTEXT_LIMITS, PRODUCT_LIMITS, SINGLE_LINE_CONTEXTS, repairFeedback,
} = prompts;

const DEFAULT_MODEL = 'claude-sonnet-5';
const EFFORTS = Object.freeze(['low', 'medium', 'high']);
const MAX_INPUT_CHARS = 4000;
const MAX_NAME_CHARS = 200;
const MAX_BUTTONS = 10; // Meta allows 10 quick replies
const MAX_BUTTON_INPUT_CHARS = 100;
const MAX_OUTPUT_TOKENS = 1500;
const REQUEST_TIMEOUT_MS = 45 * 1000;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_DETAIL_CHARS = 300;

// Weights used to pick the better of two attempts (lower total = better). A token
// problem also costs one point per missing/added item, so fewer differences win.
const WEIGHT = Object.freeze({ tokens: 100, notArabic: 20, length: 5 });

function aiError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
const invalidInput = (message) => aiError(400, 'INVALID_INPUT', message);

// ── Rate limiter (sliding window, per key) ───────────────────────────────────
// In-memory: it bounds one process, which is what protects the Anthropic bill
// from a runaway client. Stale keys are swept once per window.
function createRateLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
  const hits = new Map(); // key -> ascending timestamps inside the window
  let lastSweep = now();

  function prune(list, at) {
    while (list.length && list[0] <= at - windowMs) list.shift();
  }

  function sweep(at) {
    lastSweep = at;
    for (const [key, list] of hits) {
      prune(list, at);
      if (!list.length) hits.delete(key);
    }
  }

  return {
    take(key) {
      const at = now();
      if (at - lastSweep >= windowMs) sweep(at);
      const list = hits.get(key) || [];
      prune(list, at);
      if (list.length >= limit) {
        hits.set(key, list);
        return { allowed: false, retryAfterMs: list[0] + windowMs - at };
      }
      list.push(at);
      hits.set(key, list);
      return { allowed: true, remaining: limit - list.length };
    },
    size: () => hits.size,
  };
}

// ── Input handling ───────────────────────────────────────────────────────────
// Invisible to a reader but not to a model or a renderer: soft hyphen, Arabic letter
// mark, zero-width space, direction marks/embeddings/isolates, word joiner, BOM and
// the Unicode "tag" characters that can smuggle hidden instructions. ZWJ/ZWNJ stay
// (emoji sequences need them).
const HIDDEN_RE = /[\u{00AD}\u{061C}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const CONTROL_RE = /[\u{0000}-\u{0008}\u{000B}\u{000C}\u{000E}-\u{001F}\u{007F}]/gu;

function sanitize(value) {
  const wellFormed = typeof value.toWellFormed === 'function' ? value.toWellFormed() : value;
  return wellFormed.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').replace(HIDDEN_RE, '');
}

function textInput(value, label, { max = MAX_INPUT_CHARS, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalidInput(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw invalidInput(`${label} must be a string`);
  if (value.length > max) throw aiError(400, 'AI_TEXT_TOO_LONG', `${label} is too long (max ${max} characters)`);
  const clean = sanitize(value).trim();
  if (!clean && required) throw invalidInput(`${label} is required`);
  return clean;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw invalidInput(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function buttonsInput(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidInput('buttons must be an array of strings');
  if (value.length > MAX_BUTTONS) throw invalidInput(`buttons may hold at most ${MAX_BUTTONS} labels`);
  return value.map((label, i) => textInput(label, `buttons[${i}]`, { max: MAX_BUTTON_INPUT_CHARS }));
}

function contextInput(value) {
  return value === undefined || value === null ? DEFAULT_CONTEXT : oneOf(value, CONTEXTS, 'context');
}

// maxLength can only tighten the platform limit of the context, never loosen it.
function effectiveLimit(context, maxLength) {
  const base = CONTEXT_LIMITS[context];
  if (maxLength === undefined || maxLength === null) return base;
  if (!Number.isInteger(maxLength) || maxLength < 1) throw invalidInput('maxLength must be a positive whole number');
  return Math.min(base, maxLength);
}

// ── Model output cleaning ────────────────────────────────────────────────────
const QUOTE_PAIRS = Object.freeze([['"', '"'], ['\u{201C}', '\u{201D}'], ['\u{00AB}', '\u{00BB}'], ['`', '`']]);

// Models like to wrap a draft in quotes. Strip ONE surrounding pair, but never
// when the source itself was wrapped that way or when the quotes are not a pair
// around the whole text ("a" and "b").
function unwrapQuotes(text, source) {
  const t = text.trim();
  const s = source.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length);
      const sourceWasQuoted = s.startsWith(open) && s.endsWith(close);
      if (!sourceWasQuoted && !inner.includes(open) && !inner.includes(close)) return inner.trim();
    }
  }
  return t;
}

// Spec §1: Western digits always. The model is told so; this makes it certain.
function westernizeNumerals(text) {
  return toWesternDigits(text)
    .replace(/\u{066A}/gu, '%')
    .replace(/(?<=\d)[\u{066B}\u{066C}](?=\d)/gu, (mark) => (mark === '\u{066B}' ? '.' : ','));
}

function cleanGenerated(value, { source = '', singleLine = false } = {}) {
  if (typeof value !== 'string') return '';
  let text = westernizeNumerals(sanitize(value)).trim();
  text = text.replace(/^```[A-Za-z]*\n?|\n?```$/g, '').trim();
  text = unwrapQuotes(text, source);
  if (singleLine) text = text.replace(/\s*\n\s*/g, ' ').trim();
  return text;
}

function sliceObject(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  return first !== -1 && last > first ? text.slice(first, last + 1) : '';
}

// The model is told to answer with one JSON object; tolerate code fences or a
// stray sentence around it. Anything that is not a JSON object is a format failure.
function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/^```[A-Za-z]*\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1].trim();
  for (const candidate of [text, sliceObject(text)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) { /* not JSON: try the next candidate */ }
  }
  return null;
}

const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

// ── Verification ─────────────────────────────────────────────────────────────
const TAG_RE = /[#@][\p{L}_][\p{L}\p{N}_]*/gu; // #hashtags and @mentions (a bare #1042 is just a number)
const PLACEHOLDER_PROBLEM = Object.freeze({ meta_positional_syntax: '{{n}}', unbalanced_braces: 'stray { or }' });

function multisetDiff(source, candidate) {
  const left = new Map();
  for (const s of source) left.set(s, (left.get(s) || 0) + 1);
  const extra = [];
  for (const c of candidate) {
    const n = left.get(c) || 0;
    if (n > 0) left.set(c, n - 1); else extra.push(c);
  }
  const missing = [];
  for (const [k, n] of left) for (let i = 0; i < n; i += 1) missing.push(k);
  return { missing, extra };
}

function protectedCount(text) {
  const { urls, numbers } = extractProtectedTokens(text);
  return extractOccurrences(text).length + urls.length + numbers.length + (text.match(TAG_RE) || []).length;
}

// -> { ok, missing: [..], added: [..], count } (count = protected items in the source)
function checkTokens(source, generated) {
  const cmp = compareProtectedTokens(source, generated);
  const tags = multisetDiff(source.match(TAG_RE) || [], generated.match(TAG_RE) || []);
  const brokenBefore = findInvalidPlaceholders(source);
  const broken = findInvalidPlaceholders(generated).filter((p) => !brokenBefore.includes(p));
  const missing = [...cmp.missingFields.map((f) => `{${f}}`), ...cmp.missingUrls, ...cmp.missingNumbers, ...tags.missing];
  const added = [
    ...cmp.extraFields.map((f) => `{${f}}`), ...cmp.extraUrls, ...cmp.extraNumbers, ...tags.extra,
    ...broken.map((p) => PLACEHOLDER_PROBLEM[p] || p),
  ];
  return { ok: !missing.length && !added.length, missing, added, count: protectedCount(source) };
}

function joinTokens(items) {
  const text = items.join(', ');
  const chars = Array.from(text);
  return chars.length > MAX_DETAIL_CHARS ? `${chars.slice(0, MAX_DETAIL_CHARS - 3).join('')}...` : text;
}

// An issue is something wrong with a candidate. `warning` is what the merchant sees
// if it survives the repair attempt; `feedback` tells the model how to fix it.
function tokensIssue(tokens) {
  return {
    weight: WEIGHT.tokens + tokens.missing.length + tokens.added.length,
    warning: { code: 'tokens_changed', detail: { missing: joinTokens(tokens.missing), added: joinTokens(tokens.added) } },
    feedback: repairFeedback.tokens(tokens),
  };
}

function lengthIssue({ max, length, asButton = false, field }) {
  const detail = field ? { max, length, field } : { max, length };
  return {
    weight: WEIGHT.length,
    warning: { code: asButton ? 'button_too_long' : 'length_exceeded', detail },
    feedback: repairFeedback.length({ max, length }),
  };
}

function buttonIssue(index, length) {
  const max = LIMITS.BUTTON_LABEL;
  return {
    weight: WEIGHT.length,
    warning: { code: 'button_too_long', detail: { max, length, index } },
    feedback: repairFeedback.buttonLength({ index, max, length }),
  };
}

function notArabicIssue() {
  return { weight: WEIGHT.notArabic, warning: { code: 'not_arabic' }, feedback: repairFeedback.notArabic() };
}

// A source with nothing to translate (only {fields}, numbers, URLs, emoji) has no
// Arabic expectation either.
function hasWordsToTranslate(source) {
  const counts = countLetters(source.replace(FIELD_RE, ' ').replace(/https?:\/\/\S+/gi, ' ').replace(TAG_RE, ' '));
  return counts.arabic + counts.latin + counts.other > 0;
}

// Meta counts a template body with its {{n}} placeholders (what validateVariant does).
function measure(text, context) {
  return charLength(context === 'template_body' ? toPositional(text).text : text);
}

const joinParts = (text, buttons) => [text, ...(buttons || [])].join('\n');

function assessText({ value, source, sourceButtons, outputLanguage, context, limit }) {
  const issues = [];
  const tokens = checkTokens(joinParts(source, sourceButtons), joinParts(value.text, value.buttons));
  if (!tokens.ok) issues.push(tokensIssue(tokens));
  const length = measure(value.text, context);
  if (length > limit) issues.push(lengthIssue({ max: limit, length, asButton: context === 'button' }));
  (value.buttons || []).forEach((label, index) => {
    const labelLength = charLength(label);
    if (labelLength > LIMITS.BUTTON_LABEL) issues.push(buttonIssue(index, labelLength));
  });
  if (outputLanguage === 'ar' && hasWordsToTranslate(source) && countLetters(value.text).arabic === 0) issues.push(notArabicIssue());
  return { issues, tokens };
}

function assessProduct({ value, name, description }) {
  const issues = [];
  const tokens = checkTokens(`${name}\n${description}`, `${value.name}\n${value.description}`);
  if (!tokens.ok) issues.push(tokensIssue(tokens));
  const nameLength = charLength(value.name);
  if (nameLength > PRODUCT_LIMITS.name) issues.push(lengthIssue({ max: PRODUCT_LIMITS.name, length: nameLength, field: 'name' }));
  const descriptionLength = charLength(value.description);
  if (descriptionLength > PRODUCT_LIMITS.description) issues.push(lengthIssue({ max: PRODUCT_LIMITS.description, length: descriptionLength, field: 'description' }));
  if (hasWordsToTranslate(name) && countLetters(value.name).arabic === 0) issues.push(notArabicIssue());
  return { issues, tokens };
}

// ── Interpreting the model's JSON ────────────────────────────────────────────
const formatProblem = () => ({ invalid: repairFeedback.format() });

function interpretText(parsed, { source, sourceButtons, singleLine }) {
  const text = cleanGenerated(parsed.text, { source, singleLine });
  if (!text) return formatProblem();
  if (!sourceButtons.length) return { value: { text } };
  const received = Array.isArray(parsed.buttons) ? parsed.buttons : [];
  const buttons = received.map((label, i) => cleanGenerated(label, { source: sourceButtons[i] || '', singleLine: true }));
  if (buttons.length !== sourceButtons.length || buttons.some((label) => !label)) {
    return { invalid: repairFeedback.buttons({ expected: sourceButtons.length, received: received.length }) };
  }
  return { value: { text, buttons } };
}

// The model's own claim wins (it understands Arabizi and dialect); the letter-count
// heuristic is only the fallback when the model leaves the field out.
function resolveDetectedLanguage(claimed, text) {
  if (typeof claimed === 'string' && claimed.trim()) {
    const parsed = parseLanguageValue(claimed);
    return parsed === 'ar' || parsed === 'en' ? parsed : 'unknown';
  }
  return detectLanguage(text).language;
}

function interpretInbound(parsed, { source }) {
  const text = cleanGenerated(parsed.text, { source });
  if (!text) return formatProblem();
  return { value: { text, detectedLanguage: resolveDetectedLanguage(parsed.detectedLanguage, source) } };
}

function interpretProduct(parsed, { name, description }) {
  const translatedName = cleanGenerated(parsed.name, { source: name, singleLine: true });
  if (!translatedName) return formatProblem();
  // Never invent a description the merchant did not write.
  const translatedDescription = description ? cleanGenerated(parsed.description, { source: description }) : '';
  if (description && !translatedDescription) return formatProblem();
  return { value: { name: translatedName, description: translatedDescription } };
}

// ── Plans: one per operation ─────────────────────────────────────────────────
// plan = { system, user, interpret(parsed) -> {value}|{invalid}, assess(value) -> {issues, tokens},
//          finish(value, chosen) -> API response }
const warningsOf = (chosen, unchanged) => [...chosen.issues.map((i) => i.warning), ...(unchanged ? [{ code: 'unchanged' }] : [])];
const tokenSummary = (chosen) => ({ count: chosen.tokens.count, verified: chosen.tokens.ok });

function textPlan({ task, to, context, limit, data, source, sourceButtons = [], outputLanguage }) {
  const singleLine = SINGLE_LINE_CONTEXTS.includes(context);
  return {
    system: prompts.buildSystemPrompt({ task, to, context, limit, buttonCount: sourceButtons.length }),
    user: prompts.buildUserPrompt(task, data),
    interpret: (parsed) => interpretText(parsed, { source, sourceButtons, singleLine }),
    assess: (value) => assessText({ value, source, sourceButtons, outputLanguage, context, limit }),
    unchanged: (value) => sameText(value.text, source)
      && (value.buttons || []).every((label, i) => sameText(label, sourceButtons[i])),
  };
}

function translatePlan({ text, from, to, context, limit }) {
  const plan = textPlan({ task: TASKS.TRANSLATE, to, context, limit, data: { text, from, to }, source: text, outputLanguage: to });
  plan.finish = (value, chosen) => ({
    text: value.text, draft: true, from, to, warnings: warningsOf(chosen, plan.unchanged(value)), protectedTokens: tokenSummary(chosen),
  });
  return plan;
}

function saudiFriendlyPlan({ text, buttons, context, limit }) {
  const plan = textPlan({
    task: TASKS.SAUDI_FRIENDLY, to: 'ar', context, limit, data: { text, buttons }, source: text, sourceButtons: buttons, outputLanguage: 'ar',
  });
  plan.finish = (value, chosen) => ({
    text: value.text,
    ...(value.buttons ? { buttons: value.buttons } : {}),
    draft: true,
    warnings: warningsOf(chosen, plan.unchanged(value)),
    protectedTokens: tokenSummary(chosen),
  });
  return plan;
}

function replyPlan({ englishText, customerMessage, customerName }) {
  const limit = CONTEXT_LIMITS.inbox;
  const plan = textPlan({
    task: TASKS.REPLY_IN_ARABIC, to: 'ar', context: 'inbox', limit, data: { englishText, customerMessage, customerName }, source: englishText, outputLanguage: 'ar',
  });
  plan.finish = (value, chosen) => ({
    text: value.text, draft: true, from: 'en', to: 'ar', warnings: warningsOf(chosen, plan.unchanged(value)), protectedTokens: tokenSummary(chosen),
  });
  return plan;
}

function inboundPlan({ text }) {
  return {
    system: prompts.buildSystemPrompt({ task: TASKS.TRANSLATE_INBOUND, to: 'en' }),
    user: prompts.buildUserPrompt(TASKS.TRANSLATE_INBOUND, { text }),
    interpret: (parsed) => interpretInbound(parsed, { source: text }),
    assess: (value) => {
      const tokens = checkTokens(text, value.text);
      return { issues: tokens.ok ? [] : [tokensIssue(tokens)], tokens };
    },
    // `warnings` is additive to AiInboundTranslation: a customer's order number or
    // amount that changed in translation must not go unnoticed.
    finish: (value, chosen) => ({
      translation: value.text, detectedLanguage: value.detectedLanguage, draft: true, warnings: warningsOf(chosen, false),
    }),
  };
}

function productPlan({ name, description }) {
  return {
    system: prompts.buildSystemPrompt({ task: TASKS.PRODUCT, to: 'ar' }),
    user: prompts.buildUserPrompt(TASKS.PRODUCT, { name, description }),
    interpret: (parsed) => interpretProduct(parsed, { name, description }),
    assess: (value) => assessProduct({ value, name, description }),
    finish: (value, chosen) => ({
      name: value.name,
      description: value.description,
      draft: true,
      warnings: warningsOf(chosen, sameText(value.name, name) && sameText(value.description, description)),
    }),
  };
}

// ── Talking to the model ─────────────────────────────────────────────────────
function defaultGetClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return require('../../ai/client'); // lazy: nothing loads (or needs a key) until the first call
}

function defaultModel() { return process.env.LOCALIZATION_AI_MODEL || DEFAULT_MODEL; }
function defaultEffort() { return EFFORTS.includes(process.env.LOCALIZATION_AI_EFFORT) ? process.env.LOCALIZATION_AI_EFFORT : 'low'; }

async function resolveClient(getClient) {
  let client = null;
  try {
    client = await getClient();
  } catch (err) {
    console.error('[localization] AI client could not be loaded:', err && err.message);
  }
  if (!client || !client.messages || typeof client.messages.create !== 'function') {
    throw aiError(503, 'AI_UNAVAILABLE', 'The AI assistant is not configured');
  }
  return client;
}

// Upstream errors never reach the merchant: status/type only, never the provider's
// text (it can echo request details) and never anything the user wrote.
function mapUpstreamError(err, timedOut) {
  if (timedOut) return aiError(502, 'AI_FAILED', 'AI request timed out');
  const status = err && Number.isInteger(err.status) ? err.status : null;
  const type = err && err.error && err.error.error && typeof err.error.error.type === 'string' ? err.error.error.type.slice(0, 40) : '';
  const summary = status === null ? 'no response' : `status ${status}${type ? `, ${type}` : ''}`;
  // 401/403/404: our key, permissions or model id are wrong. 429/529: the provider is saturated.
  // Either way the feature is unavailable right now, not something the merchant did wrong.
  if ([401, 403, 404, 429, 529].includes(status)) return aiError(503, 'AI_UNAVAILABLE', `AI provider unavailable (${summary})`);
  return aiError(502, 'AI_FAILED', `AI provider error (${summary})`);
}

function textOf(response) {
  const blocks = response && Array.isArray(response.content) ? response.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

function admit(limiter, workspaceId) {
  const verdict = limiter.take(String(workspaceId));
  if (verdict.allowed) return;
  const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  const err = aiError(429, 'AI_RATE_LIMITED', `Too many AI requests. Try again in ${seconds} seconds.`);
  err.retryAfterSeconds = seconds;
  throw err;
}

const penalty = (attempt) => attempt.issues.reduce((sum, issue) => sum + issue.weight, 0);

// The attempt with fewer problems wins; a tie goes to the repair attempt.
function better(first, second) {
  if (second.invalid) return first;
  if (first.invalid) return second;
  return penalty(second) <= penalty(first) ? second : first;
}

// The repair call replays the conversation: the data, the model's own answer, then
// the list of problems. (An empty answer cannot be replayed as an assistant turn.)
function repairMessages(plan, first) {
  const feedback = first.invalid ? [first.invalid] : first.issues.map((issue) => issue.feedback);
  const followUp = prompts.buildRepairPrompt(feedback);
  if (!first.raw.trim()) return [{ role: 'user', content: `${plan.user}\n\n${followUp}` }];
  return [
    { role: 'user', content: plan.user },
    { role: 'assistant', content: first.raw },
    { role: 'user', content: followUp },
  ];
}

function createAiAssist({
  getClient = defaultGetClient,
  model = defaultModel(),
  effort = defaultEffort(), // null/'' = send no effort (for a model that does not take it)
  now = Date.now,
  limiter = createRateLimiter({ now }),
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  async function ask(client, plan, messages, signal) {
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: plan.system,
        messages,
        ...(effort ? { output_config: { effort } } : {}),
      }, { signal, timeout: timeoutMs });
    } catch (err) {
      throw mapUpstreamError(err, signal.aborted);
    }
    if (response && response.stop_reason === 'refusal') throw aiError(502, 'AI_FAILED', 'AI declined the request');
    const raw = textOf(response);
    const parsed = parseJsonObject(raw);
    const interpreted = parsed ? plan.interpret(parsed) : formatProblem();
    if (interpreted.invalid) return { raw, invalid: interpreted.invalid, issues: [] };
    const assessment = plan.assess(interpreted.value);
    return { raw, value: interpreted.value, issues: assessment.issues, tokens: assessment.tokens };
  }

  // The repair call is best effort: if it fails, a usable first draft is still returned.
  async function repair(client, plan, first, signal) {
    try {
      return better(first, await ask(client, plan, repairMessages(plan, first), signal));
    } catch (err) {
      if (first.invalid) throw err;
      return first;
    }
  }

  async function run(workspaceId, plan) {
    if (!workspaceId) throw aiError(403, 'FORBIDDEN', 'A workspace is required');
    const client = await resolveClient(getClient);
    admit(limiter, workspaceId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const first = await ask(client, plan, [{ role: 'user', content: plan.user }], controller.signal);
      const chosen = first.invalid || first.issues.length ? await repair(client, plan, first, controller.signal) : first;
      if (chosen.invalid) throw aiError(502, 'AI_FAILED', 'AI returned an unusable response');
      return plan.finish(chosen.value, chosen);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async translate(input = {}) {
      const text = textInput(input.text, 'text');
      const to = oneOf(input.to, ['en', 'ar'], 'to');
      const from = input.from === undefined || input.from === null ? 'auto' : oneOf(input.from, ['en', 'ar', 'auto'], 'from');
      const context = contextInput(input.context);
      const limit = effectiveLimit(context, input.maxLength);
      return run(input.workspaceId, translatePlan({ text, from, to, context, limit }));
    },
    async saudiFriendly(input = {}) {
      const text = textInput(input.text, 'text');
      const buttons = buttonsInput(input.buttons);
      const context = contextInput(input.context);
      const limit = effectiveLimit(context, input.maxLength);
      return run(input.workspaceId, saudiFriendlyPlan({ text, buttons, context, limit }));
    },
    async replyInArabic(input = {}) {
      const englishText = textInput(input.englishText, 'englishText');
      const customerMessage = textInput(input.customerMessage, 'customerMessage', { required: false });
      const customerName = textInput(input.customerName, 'customerName', { max: MAX_NAME_CHARS, required: false });
      return run(input.workspaceId, replyPlan({ englishText, customerMessage, customerName }));
    },
    async translateInbound(input = {}) {
      return run(input.workspaceId, inboundPlan({ text: textInput(input.text, 'text') }));
    },
    async suggestProduct(input = {}) {
      const name = textInput(input.name, 'name', { max: MAX_NAME_CHARS });
      const description = textInput(input.description, 'description', { required: false });
      return run(input.workspaceId, productPlan({ name, description }));
    },
  };
}

// The instance the routes use: created on first call so that requiring this
// module has no side effects (and reads LOCALIZATION_AI_* when it is first needed).
let shared = null;
function sharedAssist() {
  if (!shared) shared = createAiAssist();
  return shared;
}

module.exports = {
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  REQUEST_TIMEOUT_MS,
  RATE_LIMIT,
  DEFAULT_MODEL,
  createAiAssist,
  createRateLimiter,
  translate: (input) => sharedAssist().translate(input),
  saudiFriendly: (input) => sharedAssist().saudiFriendly(input),
  replyInArabic: (input) => sharedAssist().replyInArabic(input),
  translateInbound: (input) => sharedAssist().translateInbound(input),
  suggestProduct: (input) => sharedAssist().suggestProduct(input),
};
