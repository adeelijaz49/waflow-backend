// Test kit for the campaign slice (not a test file: jest only runs *.test.js).
// A small in-memory, Mongo-like store so the audience / planner / sender / routes
// can be exercised end to end with NO database, NO network and NO real sleeping.
//
// It is deliberately STRICTER than the real thing where that catches bugs:
//   * collections backed by a real Mongoose model (LocalizedCampaign, LocalizedSend,
//     CampaignMessage, Customer) cast and VALIDATE every created document with the
//     real schema (enums, required) and reject any $set path the schema does not
//     know (Mongoose would drop it silently);
//   * aggregate() compares ids by type (an ObjectId never equals its hex string),
//     because aggregation pipelines are not cast — the classic multi-tenant bug;
//   * unsupported query/update operators throw instead of being ignored;
//   * there are NO delete methods at all: any code path that tried to delete would
//     fail with a TypeError.
// Faults can be injected per collection and operation (kit.fail).
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Types;

function isObjectId(v) {
  return !!v && typeof v === 'object' && typeof v.toHexString === 'function';
}

function norm(v, strict) {
  if (v instanceof Date) return strict ? `date:${v.getTime()}` : v.getTime();
  if (isObjectId(v)) return strict ? `oid:${v.toHexString()}` : v.toHexString();
  if (strict && typeof v === 'string') return `str:${v}`;
  return v;
}

function getPath(doc, path) {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split('.');
  let cur = doc;
  keys.slice(0, -1).forEach((k) => {
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
}

function cloneDoc(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (isObjectId(value)) return value;
  if (Array.isArray(value)) return value.map(cloneDoc);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneDoc(v);
    return out;
  }
  return value;
}

function isOperatorObject(cond) {
  return !!cond && typeof cond === 'object' && !(cond instanceof Date) && !isObjectId(cond) && !Array.isArray(cond)
    && Object.keys(cond).some((k) => k.startsWith('$'));
}

function eq(value, expected, strict) {
  if (Array.isArray(value)) return value.some((x) => eq(x, expected, strict));
  if (expected === null) return value === null || value === undefined;
  return norm(value, strict) === norm(expected, strict);
}

function compare(value, bound, strict) {
  if (value === undefined || value === null) return null;
  if (strict && (isObjectId(value) !== isObjectId(bound) || (value instanceof Date) !== (bound instanceof Date))) return null;
  const a = norm(value);
  const b = norm(bound);
  if (typeof a !== typeof b) return null; // BSON type bracketing
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function applyOperator(value, op, arg, strict) {
  switch (op) {
    case '$eq': return eq(value, arg, strict);
    case '$ne': return arg === null ? !(value === null || value === undefined) : !eq(value, arg, strict);
    case '$in': return arg.some((x) => eq(value, x, strict));
    case '$nin': return !arg.some((x) => eq(value, x, strict));
    case '$exists': return arg ? value !== undefined : value === undefined;
    case '$lt': { const c = compare(value, arg, strict); return c !== null && c < 0; }
    case '$lte': { const c = compare(value, arg, strict); return c !== null && c <= 0; }
    case '$gt': { const c = compare(value, arg, strict); return c !== null && c > 0; }
    case '$gte': { const c = compare(value, arg, strict); return c !== null && c >= 0; }
    default: throw new Error(`campaignTestKit: unsupported query operator ${op}`);
  }
}

function matches(doc, filter, strict = false) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    if (key === '$or') return cond.some((f) => matches(doc, f, strict));
    if (key === '$and') return cond.every((f) => matches(doc, f, strict));
    if (key.startsWith('$')) throw new Error(`campaignTestKit: unsupported top-level operator ${key}`);
    const value = getPath(doc, key);
    if (isOperatorObject(cond)) return Object.entries(cond).every(([op, arg]) => applyOperator(value, op, arg, strict));
    return eq(value, cond, strict);
  });
}

function sortDocs(docs, spec) {
  const entries = Object.entries(spec || {});
  if (!entries.length) return docs;
  return docs.map((d, i) => [d, i]).sort(([a, ai], [b, bi]) => {
    for (const [path, dir] of entries) {
      const x = norm(getPath(a, path));
      const y = norm(getPath(b, path));
      if (x === y) continue;
      if (x === undefined || x === null) return -dir;
      if (y === undefined || y === null) return dir;
      return (x < y ? -1 : 1) * dir;
    }
    return ai - bi;
  }).map(([d]) => d);
}

function project(doc, selection) {
  if (!selection) return doc;
  const fields = selection.split(/\s+/).filter(Boolean);
  const out = {};
  if (doc._id !== undefined) out._id = doc._id;
  for (const f of fields) if (doc[f] !== undefined) out[f] = doc[f];
  return out;
}

class FakeQuery {
  constructor(collection, op, run) {
    this.collection = collection;
    this.op = op;
    this.run = run;
    this.spec = { selection: null, sort: null, skip: 0, limit: 0 };
  }

  select(s) { this.spec.selection = s; return this; }

  sort(s) { this.spec.sort = s; return this; }

  skip(n) { this.spec.skip = n; return this; }

  limit(n) { this.spec.limit = n; return this; }

  lean() { return this; }

  then(resolve, reject) {
    return Promise.resolve().then(() => this.collection._guard(this.op)).then(() => this.run(this.spec)).then(resolve, reject);
  }
}

class FakeCollection {
  // options: { model?, uniques?: [[fields]], sparseUnique?: [field], timestamps?: bool }
  constructor(name, kit, options = {}) {
    this.name = name;
    this.kit = kit;
    this.model = options.model || null;
    this.uniques = options.uniques || [];
    this.sparseUnique = options.sparseUnique || [];
    this.timestamps = !!options.timestamps;
    this.docs = [];
  }

  _guard(op) {
    this.kit.ops.push({ collection: this.name, op });
    const rule = this.kit.faults.find((f) => f.collection === this.name && f.op === op && f.times > 0);
    if (rule) {
      rule.times -= 1;
      throw rule.error;
    }
  }

  // Casts with the real schema (defaults, ObjectId/Date casting, unknown keys dropped).
  // Documents created BY THE CODE UNDER TEST are also validated (_validated); seeds are fixtures.
  _cast(raw) {
    if (!this.model) return cloneDoc({ _id: new ObjectId(), ...raw });
    const obj = new this.model(raw).toObject();
    if (this.timestamps) {
      const at = this.kit.stamp();
      obj.createdAt = at;
      obj.updatedAt = at;
    }
    return obj;
  }

  async _validated(raw) {
    if (this.model) await new this.model(raw).validate();
    return this._cast(raw);
  }

  _checkUnique(candidate, pool) {
    for (const fields of this.uniques) {
      if (pool.some((d) => fields.every((f) => norm(d[f]) === norm(candidate[f])))) return fields;
    }
    for (const field of this.sparseUnique) {
      if (candidate[field] !== undefined && pool.some((d) => d[field] !== undefined && norm(d[field]) === norm(candidate[field]))) return [field];
    }
    return null;
  }

  _dupError(fields) {
    const err = new Error(`E11000 duplicate key error collection: ${this.name} index: ${fields.join('_')}`);
    err.code = 11000;
    err.name = 'MongoServerError';
    return err;
  }

  _applyUpdate(doc, update) {
    const operators = Object.keys(update);
    if (!operators.length || operators.some((k) => !k.startsWith('$'))) throw new Error('campaignTestKit: updates must use operators');
    for (const [op, fields] of Object.entries(update)) {
      if (op === '$set') {
        for (const [path, value] of Object.entries(fields)) setPath(doc, path, this._castValue(path, value));
      } else if (op === '$inc') {
        for (const [path, n] of Object.entries(fields)) {
          this._castValue(path, n);
          setPath(doc, path, (getPath(doc, path) || 0) + n);
        }
      } else {
        throw new Error(`campaignTestKit: unsupported update operator ${op}`);
      }
    }
    if (this.timestamps) doc.updatedAt = this.kit.stamp();
  }

  _castValue(path, value) {
    if (value === undefined) throw new Error(`campaignTestKit: undefined value for $set path ${path} (never send undefined in an update)`);
    if (!this.model) return value;
    const kind = this.model.schema.pathType(path);
    if (kind === 'nested') return value;
    if (kind !== 'real') throw new Error(`campaignTestKit: ${this.name} schema has no path "${path}" — Mongoose would silently drop it`);
    const type = this.model.schema.path(path);
    if (value === null) return value;
    if (type.instance === 'ObjectId') return new ObjectId(String(value));
    if (type.instance === 'Date') return new Date(value);
    if (type.enumValues && type.enumValues.length && !type.enumValues.includes(value)) {
      throw new Error(`campaignTestKit: "${value}" is not allowed for ${this.name}.${path} (${type.enumValues.join('|')})`);
    }
    return value;
  }

  // raw:true stores the document as given (legacy rows that would not pass today's schema).
  seed(docs, { raw = false } = {}) {
    return docs.map((d) => {
      const doc = raw ? cloneDoc({ _id: new ObjectId(), ...d }) : this._cast(d);
      this.docs.push(doc);
      return doc;
    });
  }

  find(filter) {
    return new FakeQuery(this, 'find', (spec) => {
      let rows = this.docs.filter((d) => matches(d, filter));
      rows = sortDocs(rows, spec.sort);
      if (spec.skip) rows = rows.slice(spec.skip);
      if (spec.limit) rows = rows.slice(0, spec.limit);
      return rows.map((d) => cloneDoc(project(d, spec.selection)));
    });
  }

  findOne(filter) {
    return new FakeQuery(this, 'findOne', (spec) => {
      const rows = sortDocs(this.docs.filter((d) => matches(d, filter)), spec.sort);
      return rows.length ? cloneDoc(project(rows[0], spec.selection)) : null;
    });
  }

  findById(id) { return this.findOne({ _id: id }); }

  countDocuments(filter) {
    return new FakeQuery(this, 'countDocuments', () => this.docs.filter((d) => matches(d, filter)).length);
  }

  findOneAndUpdate(filter, update, options = {}) {
    return new FakeQuery(this, 'findOneAndUpdate', (spec) => {
      const rows = sortDocs(this.docs.filter((d) => matches(d, filter)), spec.sort);
      if (!rows.length) return null;
      const target = rows[0];
      const before = cloneDoc(target);
      this._applyUpdate(target, update);
      return cloneDoc(options.returnDocument === 'after' ? target : before);
    });
  }

  updateOne(filter, update) {
    return new FakeQuery(this, 'updateOne', () => {
      const target = this.docs.find((d) => matches(d, filter));
      if (!target) return { matchedCount: 0, modifiedCount: 0 };
      this._applyUpdate(target, update);
      return { matchedCount: 1, modifiedCount: 1 };
    });
  }

  updateMany(filter, update) {
    return new FakeQuery(this, 'updateMany', () => {
      const targets = this.docs.filter((d) => matches(d, filter));
      targets.forEach((t) => this._applyUpdate(t, update));
      return { matchedCount: targets.length, modifiedCount: targets.length };
    });
  }

  async create(raw) {
    await this._guard('create');
    const doc = await this._validated(raw);
    const dup = this._checkUnique(doc, this.docs);
    if (dup) throw this._dupError(dup);
    this.docs.push(doc);
    return { ...cloneDoc(doc), toObject() { return cloneDoc(doc); } };
  }

  async insertMany(rows) {
    await this._guard('insertMany');
    const casted = [];
    for (const row of rows) casted.push(await this._validated(row)); // a validation error rejects the whole batch (stricter than Mongoose)
    const writeErrors = [];
    const inserted = [];
    casted.forEach((doc, index) => {
      const dup = this._checkUnique(doc, [...this.docs, ...inserted]);
      if (dup) writeErrors.push({ index, code: 11000 });
      else inserted.push(doc);
    });
    this.docs.push(...inserted);
    if (writeErrors.length) {
      const err = new Error(`E11000 duplicate key error collection: ${this.name}`);
      err.name = 'MongoBulkWriteError';
      err.code = 11000;
      err.writeErrors = writeErrors;
      throw err;
    }
    return inserted.map(cloneDoc);
  }

  // Supports exactly the stages the campaign code uses: $match, $group, $limit.
  async aggregate(pipeline) {
    await this._guard('aggregate');
    let rows = this.docs.map(cloneDoc);
    for (const stage of pipeline) {
      const [name, arg] = Object.entries(stage)[0];
      if (name === '$match') rows = rows.filter((d) => matches(d, arg, true));
      else if (name === '$limit') rows = rows.slice(0, arg);
      else if (name === '$group') rows = this._group(rows, arg);
      else throw new Error(`campaignTestKit: unsupported aggregation stage ${name}`);
    }
    return rows;
  }

  _group(rows, spec) {
    const resolve = (doc, expr) => {
      if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1));
      if (expr && typeof expr === 'object' && !isObjectId(expr)) {
        const out = {};
        for (const [k, e] of Object.entries(expr)) {
          const v = resolve(doc, e);
          if (v !== undefined) out[k] = v;
        }
        return out;
      }
      return expr;
    };
    const groups = new Map();
    for (const doc of rows) {
      const id = resolve(doc, spec._id);
      const key = JSON.stringify(id, (k, v) => (isObjectId(v) ? `oid:${v.toHexString()}` : v));
      if (!groups.has(key)) groups.set(key, { _id: id, docs: [] });
      groups.get(key).docs.push(doc);
    }
    return Array.from(groups.values()).map(({ _id, docs }) => {
      const out = { _id };
      for (const [field, acc] of Object.entries(spec)) {
        if (field === '_id') continue;
        const [op, expr] = Object.entries(acc)[0];
        const values = docs.map((d) => resolve(d, expr));
        if (op === '$sum') out[field] = values.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
        else if (op === '$max') out[field] = values.filter((v) => v !== undefined && v !== null).reduce((m, v) => (m === undefined || norm(v) > norm(m) ? v : m), undefined);
        else throw new Error(`campaignTestKit: unsupported accumulator ${op}`);
      }
      return out;
    });
  }
}

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

// A tenant-scoped test world. `kit.deps` has the exact shape of campaignSender.realDeps().
function makeKit(overrides = {}) {
  const kit = {
    ops: [],
    faults: [],
    clock: { t: T0 },
    scheduled: [],
    sleeps: [],
    sent: [],
    logs: [],
  };
  kit.stamp = () => { kit.clock.t += 1; return new Date(kit.clock.t); };
  kit.fail = (collection, op, error, times = 1) => kit.faults.push({ collection, op, error, times });

  const Customer = require('../../models/Customer');
  const LocalizedCampaign = require('../../models/LocalizedCampaign');
  const LocalizedSend = require('../../models/LocalizedSend');
  const CampaignMessage = require('../../models/CampaignMessage');

  kit.customers = new FakeCollection('customers', kit, { model: Customer, timestamps: true });
  kit.languages = new FakeCollection('customerlanguages', kit);
  kit.orders = new FakeCollection('orders', kit);
  kit.templates = new FakeCollection('localizedtemplates', kit);
  kit.settingsDocs = new FakeCollection('settings', kit);
  kit.workspaces = new FakeCollection('workspaces', kit);
  kit.campaigns = new FakeCollection('localizedcampaigns', kit, { model: LocalizedCampaign, timestamps: true });
  kit.sends = new FakeCollection('localizedsends', kit, { model: LocalizedSend, timestamps: true, uniques: [['campaignId', 'customerId']] });
  kit.messages = new FakeCollection('campaignmessages', kit, { model: CampaignMessage, timestamps: true, sparseUnique: ['wamid'] });

  const transport = {
    dryRun: false,
    isDryRun: () => transport.dryRun,
    extractWamid: require('../../shared/localization/transport').extractWamid,
    sendTemplate: async (to, payload) => {
      if (transport.impl) return transport.impl(to, payload);
      const id = `wamid.TEST${kit.sent.length + 1}`;
      return { messages: [{ id }] };
    },
  };
  const realSend = transport.sendTemplate;
  transport.sendTemplate = async (to, payload) => {
    kit.sent.push({ to, ...payload });
    return realSend(to, payload);
  };
  kit.transport = transport;

  const { toPositional } = require('../../shared/localization/mergeFields');
  // The Meta `components` shape the sender expects from the templates service
  // (templates.buildSendComponents): header/body text parameters in positional
  // order, one quick-reply component per button that has a payload.
  kit.referenceComponents = ({ variant, values, buttonPayloads }) => {
    const components = [];
    for (const [type, text] of [['header', variant.header], ['body', variant.body]]) {
      const { params } = toPositional(text || '');
      if (params.length) components.push({ type, parameters: params.map((p) => ({ type: 'text', text: values[p] })) });
    }
    (variant.buttons || []).forEach((button, i) => {
      if (buttonPayloads[i]) components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: buttonPayloads[i] }] });
    });
    return components;
  };
  kit.buildSendComponents = jest.fn(async (args) => kit.referenceComponents(args));

  kit.localeSettings = { defaultCustomerLanguage: 'en', bilingualOrder: 'ar_first' };
  kit.flagEnabled = true; // true | false | (workspaceId) => boolean
  kit.killSwitch = false;
  const consent = require('../../shared/consent');
  let runner = 0;

  kit.deps = {
    Customer: kit.customers,
    CustomerLanguage: kit.languages,
    Order: kit.orders,
    LocalizedTemplate: kit.templates,
    Settings: kit.settingsDocs,
    Workspace: kit.workspaces,
    LocalizedCampaign: kit.campaigns,
    LocalizedSend: kit.sends,
    CampaignMessage: kit.messages,
    consent,
    settings: {
      getSettings: async () => ({ ...kit.localeSettings }),
      killSwitchOn: () => kit.killSwitch,
      isArabicEnabled: async (ws) => (typeof kit.flagEnabled === 'function' ? kit.flagEnabled(ws) : kit.flagEnabled),
    },
    catalog: require('../../shared/localization/catalog'),
    transport,
    buildSendComponents: (args) => kit.buildSendComponents(args),
    now: () => kit.clock.t,
    sleep: async (ms) => { kit.sleeps.push(ms); },
    schedule: (fn) => { kit.scheduled.push(fn); },
    newRunnerId: () => { runner += 1; return `runner-${runner}`; },
    log: (...args) => { kit.logs.push(args.map(String).join(' ')); },
    sendTimeoutMs: 50,
    ...overrides,
  };

  // Runs everything the code scheduled with setImmediate (the background sender).
  kit.drain = async () => {
    while (kit.scheduled.length) {
      const fn = kit.scheduled.shift();
      await fn();
    }
  };
  return kit;
}

// ── builders ────────────────────────────────────────────────────────────────

let counter = 0;
function oid() {
  counter += 1;
  return new ObjectId(`${(0x5f0000000000 + counter).toString(16).padStart(12, '0')}${(counter).toString(16).padStart(12, '0')}`);
}

function variant(language, extra = {}) {
  const defaults = {
    en: {
      body: 'Hi {name}, enjoy {discount}% off until {date}. You have {points} points.',
      buttons: [{ role: 'opt_out', text: 'Opt out' }],
    },
    ar: {
      body: 'مرحباً {name}، خصم {discount}% حتى {date}. رصيدك الحالي من النقاط: {points}',
      buttons: [{ role: 'opt_out', text: 'إلغاء الاشتراك' }],
    },
    bilingual: {
      body: 'مرحباً {name}، خصم {discount}% حتى {date}.\n\nHi {name}, enjoy {discount}% off until {date}.',
      buttons: [{ role: 'opt_out', text: 'إلغاء الاشتراك' }],
      bilingualOrder: 'ar_first',
    },
  }[language];
  return {
    language,
    header: '',
    footer: '',
    metaStatus: 'APPROVED',
    reviewStatus: 'reviewed',
    metaTemplateName: `wf_test_${language}_v1`,
    metaLanguage: language === 'bilingual' ? 'ar' : language,
    ...defaults,
    ...extra,
  };
}

module.exports = { makeKit, FakeCollection, matches, oid, variant, T0, ObjectId };
