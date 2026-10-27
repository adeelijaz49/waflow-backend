'use strict';
// A client may send the FIELDS of a record, never the ones that say whose it is or that change what a database update means.
// Mounted after requireAuth on the data routes (several of them hand req.body straight to findOneAndUpdate):
//   * workspaceId, _id, __v and isDemo are dropped: a record belongs to the signed-in session's customer (workspace), and isDemo
//     (which switches the consent gate and the real-send guard off) is set by the seed script only;
//   * a top-level key that starts with "$" is a MongoDB update operator ({"$set": {...}}), which would bypass every field rule
//     of the route (consent fields, ownership): the request is refused with 400.
const DROPPED = ['workspaceId', '_id', '__v', 'isDemo'];

function sanitizeBody(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return next();
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of Object.keys(body)) {
      if (key.startsWith('$')) return res.status(400).json({ error: 'Invalid field name.' });
    }
    for (const key of DROPPED) delete body[key];
  }
  return next();
}

module.exports = sanitizeBody;
module.exports.sanitizeBody = sanitizeBody;
module.exports.DROPPED = DROPPED;
