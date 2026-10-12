// In-memory stand-ins for the Mongoose models the flow follow-up modules read and write (no database,
// no network). They honour the query filters they are given (equality, $in, $ne) so a missing
// workspace filter shows up as a leaked row, and they record every call.
const id = (n) => String(n).padStart(24, '0');

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    const actual = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$in' in cond) return cond.$in.map(String).includes(String(actual));
      if ('$ne' in cond) return String(actual) !== String(cond.$ne);
    }
    return actual !== undefined && String(actual) === String(cond);
  });
}

function chain(read) {
  let limit = Infinity;
  const q = { select: () => q, populate: () => q, sort: () => q, limit: (n) => { limit = n; return q; }, lean: async () => read(limit) };
  return q;
}

// uniqueKeys: field names whose combination must be unique (simulates the E11000 of a unique index).
function fakeModel(docs = [], { uniqueKeys = null } = {}) {
  let counter = 9000;
  const model = {
    docs,
    find: jest.fn((filter) => chain((limit) => structuredClone(docs.filter((d) => matches(d, filter)).slice(0, limit)))),
    findOne: jest.fn((filter) => chain(() => { const hit = docs.find((d) => matches(d, filter)); return hit ? structuredClone(hit) : null; })),
    create: jest.fn(async (doc) => {
      if (uniqueKeys && docs.some((d) => uniqueKeys.every((k) => String(d[k]) === String(doc[k])))) {
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
      counter += 1;
      const stored = { _id: id(counter), contentVersion: 1, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(doc) };
      docs.push(stored);
      return structuredClone(stored);
    }),
    findOneAndUpdate: jest.fn((filter, update) => chain(() => {
      const hit = docs.find((d) => matches(d, filter));
      if (!hit) return null;
      Object.assign(hit, structuredClone(update.$set || {}));
      for (const key of Object.keys(update.$unset || {})) delete hit[key];
      for (const [key, by] of Object.entries(update.$inc || {})) hit[key] = (hit[key] || 0) + by;
      hit.updatedAt = new Date();
      return structuredClone(hit);
    })),
  };
  return model;
}

module.exports = { id, matches, chain, fakeModel };
