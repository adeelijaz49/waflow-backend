'use strict';
// Gate for /api/platform: WaFlow staff only. Mount AFTER requireAuth:
//   app.use('/api/platform', requireAuth, requireSuperAdmin, require('./routes/platform'));
//
// The decision is never taken from the token: the User is loaded from the database on EVERY request and its verified
// contact is compared with the SUPER_ADMIN_CONTACTS allowlist (shared/platformAdmin.js), so removing a contact from the
// env stops that person's platform access at the next request. An empty allowlist means nobody is a super admin.
//
// A session that "entered" a customer (token claim actAs) is refused everywhere except POST /exit, which is how it leaves
// again ("exit the customer first"): staff acting inside a customer must not be able to create customers, change
// WhatsApp numbers or enter another customer from there.
const User = require('../models/User');
const platformAdmin = require('../shared/platformAdmin');

const DENIED = { error: 'Super admin only' };
const EXIT_PATH = /^\/exit\/?$/;

async function requireSuperAdmin(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ error: 'Not logged in' });
  if (req.superAdminChecked && req.platformActor) return next(); // already checked on this request (the router re-checks defensively)

  if (!platformAdmin.isConfigured()) return res.status(403).json(DENIED);
  if (req.user.actAs && !(req.method === 'POST' && EXIT_PATH.test(req.path || ''))) {
    return res.status(403).json({ ...DENIED, hint: 'Exit the customer first' });
  }

  let user;
  try {
    user = await User.findById(req.user.id).select('phone email name').lean();
  } catch (err) {
    return res.status(500).json({ error: 'Could not verify your permissions right now — please try again' });
  }
  if (!platformAdmin.isSuperAdminUser(user)) return res.status(403).json(DENIED);

  req.platformActor = user;
  req.superAdminChecked = true;
  return next();
}

module.exports = requireSuperAdmin;
module.exports.requireSuperAdmin = requireSuperAdmin;
