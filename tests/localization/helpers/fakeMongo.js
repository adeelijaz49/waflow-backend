'use strict';
// In-memory stand-ins for the Mongoose models the customers slice touches, so the
// service and route tests run with no database. They implement just enough of
// MongoDB's query semantics to make the tests meaningful rather than call-shape
// assertions: $and/$or, equality, $in/$nin/$ne/$exists/$gt, $regex(+$options),
// field projection, binary (UTF-8) string sorting, skip/limit, upserts with
// $set/$unset/$setOnInsert, a unique (workspaceId, customerId) index and the
// MongoBulkWriteError a unique-index conflict produces.
//
// Fidelity of this file was checked against a real MongoDB 8.3 (see the slice report).
// Nothing here ever deletes a document.

const OPERATORS = new Set(['$in', '$nin', '$ne', '$exists', '$gt', '$regex', '$options']);

function same(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return (a ?? null) === (b ?? null);
  return String(a) === String(b);
}

function isOperatorObject(cond) {
  return cond !== null && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).length > 0 && Object.keys(cond).every((k) => k.startsWith('$'));
}

function fieldMatches(value, cond, present) {
  if (!isOperatorObject(cond)) return same(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    if (!OPERATORS.has(op)) throw new Error(`fakeMongo: unsupported operator ${op}`);
    switch (op) {
      case '$in': return arg.some((a) => same(value, a));
      case '$nin': return !arg.some((a) => same(value, a));
      case '$ne': return !same(value, arg);
      case '$exists': return present === !!arg;
      case '$gt': return value !== undefined && String(value) > String(arg);
      case '$regex': return value !== undefined && value !== null && new RegExp(arg, cond.$options || '').test(String(value));
      default: return true; // $options is consumed by $regex
    }
  });
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    if (key === '$and') return cond.every((f) => matches(doc, f));
    if (key === '$or') return cond.some((f) => matches(doc, f));
    if (key.startsWith('$')) throw new Error(`fakeMongo: unsupported top-level operator ${key}`);
    return fieldMatches(doc[key], cond, Object.prototype.hasOwnProperty.call(doc, key));
  });
}

// MongoDB's default string order: UTF-8 bytes.
function compareValues(a, b) {
  return Buffer.compare(Buffer.from(String(a === undefined || a === null ? '' : a), 'utf8'), Buffer.from(String(b === undefined || b === null ? '' : b), 'utf8'));
}

function project(doc, fields) {
  if (!fields) return { ...doc };
  const out = { _id: doc._id };
  for (const f of fields) if (f in doc) out[f] = doc[f];
  return out;
}

class Query {
  constructor(run) { this.run = run; this.fields = null; this.order = null; this.offset = 0; this.max = 0; }
  select(spec) { this.fields = String(spec).split(/\s+/).filter(Boolean); return this; }
  sort(spec) { this.order = spec; return this; }
  skip(n) { this.offset = n; return this; }
  limit(n) { this.max = n; return this; }
  lean() { return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run(this)).then(resolve, reject); }
}

function duplicateKeyError() {
  const err = new Error('E11000 duplicate key error');
  err.code = 11000;
  return err;
}

class FakeModel {
  // options.unique: array of field names forming a unique index; options.defaults: applied on insert.
  constructor(docs = [], options = {}) {
    this.docs = docs.map((d) => ({ ...d }));
    this.unique = options.unique || null;
    this.defaults = options.defaults || {};
    this.hooks = {};
    this.calls = [];
    this.nextId = 1;
  }

  record(method, filter, extra) { this.calls.push({ method, filter, ...extra }); }

  find(filter = {}) {
    this.record('find', filter);
    return new Query((q) => {
      let out = this.docs.filter((d) => matches(d, filter));
      if (q.order) {
        const keys = Object.entries(q.order);
        out = [...out].sort((a, b) => {
          for (const [k, dir] of keys) {
            const c = compareValues(a[k], b[k]);
            if (c) return c * dir;
          }
          return 0;
        });
      }
      if (q.offset) out = out.slice(q.offset);
      if (q.max) out = out.slice(0, q.max);
      return out.map((d) => project(d, q.fields));
    });
  }

  findOne(filter = {}) {
    this.record('findOne', filter);
    return new Query((q) => {
      const doc = this.docs.find((d) => matches(d, filter));
      return doc ? project(doc, q.fields) : null;
    });
  }

  async countDocuments(filter = {}) {
    this.record('countDocuments', filter);
    return this.docs.filter((d) => matches(d, filter)).length;
  }

  conflicts(candidate, ignore) {
    return !!this.unique && this.docs.some((d) => d !== ignore && this.unique.every((f) => same(d[f], candidate[f])));
  }

  // hooks.loseInsertRace(model, doc): a test may insert the competing document and return true
  // to make this insert fail like it lost a race against a concurrent writer.
  losesInsertRace(doc) { return !!this.hooks.loseInsertRace && !!this.hooks.loseInsertRace(this, doc); }

  buildInsert(filter, update) {
    const base = {};
    for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && !isOperatorObject(v)) base[k] = v;
    const doc = { _id: String(this.nextId++).padStart(24, '0'), ...this.defaults, ...base, ...(update.$setOnInsert || {}), ...(update.$set || {}), createdAt: new Date(), updatedAt: new Date() };
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
    return doc;
  }

  applyUpdate(doc, update) {
    Object.assign(doc, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
    doc.updatedAt = new Date();
  }

  // Resolves the stored document AFTER the update, like returnDocument:'after'.
  findOneAndUpdate(filter, update, options = {}) {
    this.record('findOneAndUpdate', filter, { update, options });
    return new Query(async () => {
      const found = this.docs.find((d) => matches(d, filter));
      if (found) { this.applyUpdate(found, update); return { ...found }; }
      if (!options.upsert) return null;
      const doc = this.buildInsert(filter, update);
      if (this.conflicts(doc) || this.losesInsertRace(doc)) throw duplicateKeyError();
      this.docs.push(doc);
      return { ...doc };
    });
  }

  // ordered:false semantics: every operation runs; unique-index conflicts are collected
  // and raised together as a MongoBulkWriteError.
  async bulkWrite(operations, options = {}) {
    this.record('bulkWrite', null, { operations, options });
    if (this.hooks.beforeBulkWrite) await this.hooks.beforeBulkWrite(this, operations);
    const writeErrors = [];
    operations.forEach((op, index) => {
      const { filter, update, upsert } = op.updateOne;
      const found = this.docs.find((d) => matches(d, filter));
      if (found) { this.applyUpdate(found, update); return; }
      if (!upsert) return;
      const doc = this.buildInsert(filter, update);
      if (this.conflicts(doc) || this.losesInsertRace(doc)) { writeErrors.push({ index, code: 11000, errmsg: 'E11000 duplicate key error' }); return; }
      this.docs.push(doc);
    });
    if (writeErrors.length) {
      const err = new Error('bulk write error');
      err.name = 'MongoBulkWriteError';
      err.code = 11000;
      err.writeErrors = writeErrors;
      throw err;
    }
    return { ok: 1 };
  }

  // test convenience (not part of the Mongoose API)
  insert(doc) {
    const stored = { _id: String(this.nextId++).padStart(24, '0'), ...this.defaults, ...doc };
    this.docs.push(stored);
    return stored;
  }
}

const oid = (n) => Number(n).toString(16).padStart(24, '0');

module.exports = { FakeModel, matches, oid };
