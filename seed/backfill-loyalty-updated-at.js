// One-time backfill for the points_balance_reminder Automated Flow trigger
// (Phase 3). loyaltyPointsUpdatedAt only started being set going forward
// (server.js's 4 loyaltyPoints $inc sites) — existing customers with a
// nonzero balance have it unset. Treating "unset" as "infinitely stale"
// would make every existing points-holder eligible for a nudge instantly,
// which is a flood, not a nudge. This sets a best-available proxy —
// Customer.updatedAt (the last time the doc changed for any reason) — for
// every customer where loyaltyPoints > 0 and the field is still unset.
//
// Run manually once against the deployed DB after this phase ships, before
// activating any points_balance_reminder flow: `npm run seed:backfill-loyalty`
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Customer = require('../models/Customer');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/waflow';

async function backfill() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const candidates = await Customer.find({
    loyaltyPoints: { $gt: 0 },
    loyaltyPointsUpdatedAt: { $exists: false },
  });
  console.log(`Found ${candidates.length} customer(s) with points but no loyaltyPointsUpdatedAt`);

  let updated = 0;
  for (const c of candidates) {
    await Customer.findByIdAndUpdate(c._id, { loyaltyPointsUpdatedAt: c.updatedAt });
    updated++;
  }

  console.log(`\n✅ Backfill complete: ${updated} customer(s) updated`);
  await mongoose.disconnect();
}

backfill().catch(err => { console.error(err); process.exit(1); });
