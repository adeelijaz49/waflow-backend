'use strict';
// Minimal in-memory stand-in for the mongoose models used by the B0 modules
// (unit tests only; no mongoose, no DB). Supports the query/update operators the
// foundation code uses: equality on dotted paths, $ne $in $nin $exists $lt $lte $gt $gte,
// $set $unset $inc $setOnInsert, upsert, E11000 on a declared unique key.
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}
function set(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (o[keys[i]] === undefined || o[keys[i]] === null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
function unset(obj, path) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i += 1) { if (!o) return; o = o[keys[i]]; }
  if (o) delete o[keys[keys.length - 1]];
}
const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : String(a) === String(b));
function matchValue(actual, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && Object.keys(cond).some((k) => k.startsWith('$'))) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$ne': return v === null ? (actual !== undefined && actual !== null) : !(actual !== undefined && actual !== null && same(actual, v));
        case '$in': return v.some((x) => (x === null ? actual === null || actual === undefined : same(actual, x)));
        case '$nin': return !v.some((x) => (x === null ? actual === null || actual === undefined : same(actual, x)));
        case '$exists': return v ? actual !== undefined : actual === undefined;
        case '$lt': return actual !== undefined && actual !== null && new Date(actual) < new Date(v);
        case '$lte': return actual !== undefined && actual !== null && new Date(actual) <= new Date(v);
        case '$gt': return actual !== undefined && actual !== null && new Date(actual) > new Date(v);
        case '$gte': return actual !== undefined && actual !== null && new Date(actual) >= new Date(v);
        default: throw new Error(`fake store: unsupported operator ${op}`);
      }
    });
  }
  if (cond === null) return actual === null || actual === undefined;
  return actual !== undefined && actual !== null && same(actual, cond);
}
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    return matchValue(get(doc, k), cond);
  });
}
function clone(d) { return d === undefined ? d : JSON.parse(JSON.stringify(d), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v) : v)); }

let counter = 1;
function newId() { return (counter++).toString(16).padStart(24, '0'); }

/**
 * @param {{unique?:string[][], defaults?:object, failWith?:Error}} [opts]
 */
function createFakeModel(opts = {}) {
  const rows = [];
  const model = { rows, calls: [], failWith: opts.failWith || null };
  const check = () => { if (model.failWith) throw model.failWith; };
  function query(fn) {
    const q = { _sort: null, _limit: null, _fields: null };
    q.select = () => q;
    q.lean = () => q;
    q.sort = (s) => { q._sort = s; return q; };
    q.limit = (n) => { q._limit = n; return q; };
    q.then = (res, rej) => Promise.resolve().then(() => {
      check();
      let out = fn();
      if (Array.isArray(out)) {
        if (q._sort) { const [k, dir] = Object.entries(q._sort)[0]; out = out.slice().sort((a, b) => (new Date(get(a, k)) - new Date(get(b, k))) * (dir < 0 ? -1 : 1)); }
        if (q._limit) out = out.slice(0, q._limit);
      }
      if (q._one) return out.length ? out[0] : null;
      return out;
    }).then(res, rej);
    q.catch = (rej) => q.then(undefined, rej);
    return q;
  }
  function dup(doc, ignore) {
    return (opts.unique || []).some((keys) => rows.some((r) => r !== ignore && keys.every((k) => same(get(r, k), get(doc, k)))));
  }
  function e11000() { const e = new Error('E11000 duplicate key error'); e.code = 11000; return e; }
  function applyUpdate(doc, update, inserting) {
    for (const [op, body] of Object.entries(update)) {
      if (op === '$set') for (const [k, v] of Object.entries(body)) set(doc, k, v);
      else if (op === '$unset') for (const k of Object.keys(body)) unset(doc, k);
      else if (op === '$inc') for (const [k, v] of Object.entries(body)) set(doc, k, (get(doc, k) || 0) + v);
      else if (op === '$setOnInsert') { if (inserting) for (const [k, v] of Object.entries(body)) set(doc, k, v); }
      else throw new Error(`fake store: unsupported update ${op}`);
    }
  }
  function equalityFields(filter) {
    const out = {};
    for (const [k, v] of Object.entries(filter || {})) if (!k.startsWith('$') && (v === null || typeof v !== 'object' || v instanceof Date)) set(out, k, v);
    return out;
  }
  model.findOne = (filter) => { const q = query(() => { model.calls.push(['findOne', filter]); return rows.filter((x) => matches(x, filter)).map(clone); }); q._one = true; return q; };
  model.findById = (id) => model.findOne({ _id: id });
  model.find = (filter) => query(() => { model.calls.push(['find', filter]); return rows.filter((x) => matches(x, filter)).map(clone); });
  model.countDocuments = (filter) => query(() => { model.calls.push(['countDocuments', filter]); return rows.filter((x) => matches(x, filter)).length; });
  model.create = async (doc) => {
    check();
    model.calls.push(['create', doc]);
    const row = { ...clone(doc) };
    if (opts.defaults) for (const [k, v] of Object.entries(opts.defaults)) if (get(row, k) === undefined) set(row, k, typeof v === 'function' ? v() : v);
    if (row._id === undefined) row._id = newId();
    if (row.createdAt === undefined) row.createdAt = new Date();
    if (dup(row)) throw e11000();
    rows.push(row);
    return { ...clone(row), toObject() { return clone(row); } };
  };
  model.updateOne = async (filter, update, o = {}) => {
    check();
    model.calls.push(['updateOne', filter, update]);
    let r = rows.find((x) => matches(x, filter));
    let inserted = false;
    if (!r && o.upsert) {
      r = { ...clone(equalityFields(filter)), _id: newId() };
      inserted = true;
    }
    if (!r) return { matchedCount: 0, modifiedCount: 0 };
    const before = JSON.stringify(r);
    applyUpdate(r, update, inserted);
    if (inserted) { if (dup(r, r)) throw e11000(); rows.push(r); }
    return { matchedCount: 1, modifiedCount: inserted || JSON.stringify(r) !== before ? 1 : 0 };
  };
  model.updateMany = async (filter, update) => {
    check();
    model.calls.push(['updateMany', filter, update]);
    let n = 0;
    for (const r of rows.filter((x) => matches(x, filter))) { applyUpdate(r, update, false); n += 1; }
    return { matchedCount: n, modifiedCount: n };
  };
  model.findOneAndUpdate = (filter, update, o = {}) => query(() => {
    model.calls.push(['findOneAndUpdate', filter, update]);
    let r = rows.find((x) => matches(x, filter));
    let inserted = false;
    if (!r && o.upsert) { r = { ...clone(equalityFields(filter)), _id: newId(), createdAt: new Date() }; inserted = true; }
    if (!r) return null;
    const preImage = inserted ? null : clone(r); // returnDocument:'before' answers with the document as it was (null when this call created it)
    applyUpdate(r, update, inserted);
    if (inserted) {
      if (opts.defaults) for (const [k, v] of Object.entries(opts.defaults)) if (get(r, k) === undefined) set(r, k, typeof v === 'function' ? v() : v);
      if (dup(r, r)) throw e11000();
      rows.push(r);
    }
    return o.returnDocument === 'before' ? preImage : clone(r);
  });
  model.seed = (doc) => { const row = { _id: newId(), createdAt: new Date(), ...clone(doc) }; rows.push(row); return row; };
  return model;
}

module.exports = { createFakeModel, newId };
