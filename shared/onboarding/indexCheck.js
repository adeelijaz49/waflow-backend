'use strict';
// Index verification of the nine onboarding collections (review R7, operational note). Mongoose builds the declared indexes automatically at
// first use and SWALLOWS the errors of that build (mongoose.js: model.init().catch(noop)), so if Cosmos DB for MongoDB ever rejected an index
// the guarantees that rest on the UNIQUE ones (one sidecar and one connection per workspace, one notification per dedupe key, one template row
// per key and language, one support request per 10-minute window) would be missing silently. This module lists what is really there, says
// loudly when a UNIQUE index is missing, and (on request) builds the declared indexes explicitly so that an error is SEEN.
// It only ever creates indexes: nothing is dropped, nothing is deleted, no document is touched. `scripts/onboarding-admin.js indexes [--create]`
// is the command; it works with ONBOARDING_FLOW off.
//
//   inspect(deps) -> Promise<{ collections:[{model, collection, exists, indexes:[{name,key,unique}], declared:[{key,unique}], missing:[{key,unique}]}], missingUnique:[{collection,key}], ok }>
//   create(deps)  -> Promise<{ created:[{model, collection}], errors:[{model, collection, code, message}] }>
// deps: { models?: { <name>: { schema:{indexes()}, collection:{name, indexes()}, createIndexes() } } } (tests); real models are loaded lazily.

const MODEL_NAMES = Object.freeze([
  'OnboardingState', 'WhatsAppConnection', 'WhatsAppClaim', 'OnboardingEvent', 'OnboardingInbound',
  'OnboardingNotification', 'OnboardingSupportRequest', 'OnboardingTemplate', 'OnboardingAdminLog',
]);

function loadModels(deps) {
  if (deps && deps.models) return MODEL_NAMES.filter((n) => deps.models[n]).map((n) => ({ name: n, model: deps.models[n] }));
  return MODEL_NAMES.map((n) => ({ name: n, model: require(`../../models/${n}`) }));
}

/** 'workspaceId:1,dedupeKey:1' for { workspaceId: 1, dedupeKey: 1 } (field order matters in an index). */
function keyString(key) {
  return Object.entries(key || {}).map(([k, v]) => `${k}:${v}`).join(',');
}
function plainKey(key) {
  return key instanceof Map ? Object.fromEntries(key) : key;
}

function declaredOf(model) {
  const list = typeof model.schema.indexes === 'function' ? model.schema.indexes() : [];
  return list.map(([fields, options]) => ({ key: plainKey(fields), unique: !!(options && options.unique) }));
}

async function liveIndexes(model) {
  try {
    const rows = await model.collection.indexes();
    return { exists: true, rows: (rows || []).map((r) => ({ name: r.name, key: plainKey(r.key), unique: !!r.unique })) };
  } catch (err) {
    // listIndexes on a collection that does not exist yet (nothing has used it): code 26 / NamespaceNotFound
    if (err && (err.code === 26 || err.codeName === 'NamespaceNotFound' || /ns does not exist|namespace.*not found/i.test(String(err.message || '')))) return { exists: false, rows: [] };
    throw err;
  }
}

/**
 * What exists and what is missing. A declared index counts as present when an index with the same keys (same order) exists; a declared UNIQUE
 * index only when the live one is unique too.
 */
async function inspect(deps) {
  const collections = [];
  const missingUnique = [];
  for (const { name, model } of loadModels(deps)) {
    const declared = declaredOf(model);
    const live = await liveIndexes(model);
    const missing = declared.filter((d) => !live.rows.some((r) => keyString(r.key) === keyString(d.key) && (!d.unique || r.unique)));
    const collection = model.collection.collectionName || model.collection.name || name;
    collections.push({ model: name, collection, exists: live.exists, indexes: live.rows, declared, missing });
    for (const m of missing) if (m.unique) missingUnique.push({ collection, key: keyString(m.key) });
  }
  return { collections, missingUnique, ok: missingUnique.length === 0 };
}

/**
 * Build the declared indexes of the nine models explicitly (Model.createIndexes: it creates what is missing and never drops anything).
 * An error of one model is reported and does not stop the others.
 */
async function create(deps) {
  const created = [];
  const errors = [];
  for (const { name, model } of loadModels(deps)) {
    const collection = model.collection.collectionName || model.collection.name || name;
    try {
      await model.createIndexes();
      created.push({ model: name, collection });
    } catch (err) {
      errors.push({ model: name, collection, code: err && (err.code || err.codeName) ? String(err.code || err.codeName) : 'ERROR', message: String((err && err.message) || '').slice(0, 200) });
    }
  }
  return { created, errors };
}

module.exports = { inspect, create, keyString, declaredOf, MODEL_NAMES };
