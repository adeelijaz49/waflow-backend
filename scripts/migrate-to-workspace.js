// One-time migration: bootstrap Workspace #1 for all of today's existing
// (single-tenant) data, plus the first User+Membership so there's someone
// who can actually log in once auth is live. Does NOT touch the 14 existing
// business-data collections (Product, Customer, Order, ...) — that retrofit
// is Phase 3. Safe to re-run: no-ops if Workspace #1 already exists.
//
// Usage: node scripts/migrate-to-workspace.js [phone] [email] [name]
require('dotenv').config();
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const Membership = require('../models/Membership');

const phone = (process.argv[2] || '61422286126').replace(/\D/g, '');
const email = (process.argv[3] || 'adeelijaz49@gmail.com').trim().toLowerCase();
const name = process.argv[4] || 'Adeel';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  let workspace = await Workspace.findOne();
  if (workspace) {
    console.log('Workspace already exists, skipping creation:', workspace._id.toString(), workspace.name);
  } else {
    workspace = await Workspace.create({ name: `${name}'s Workspace` });
    console.log('Created workspace:', workspace._id.toString());
  }

  let user = await User.findOne({ $or: [{ phone }, { email }] });
  if (user) {
    console.log('User already exists, skipping creation:', user._id.toString());
  } else {
    user = await User.create({ phone, email, name });
    console.log('Created user:', user._id.toString(), phone, email);
  }

  let membership = await Membership.findOne({ userId: user._id, workspaceId: workspace._id });
  if (membership) {
    console.log('Membership already exists:', membership.role);
  } else {
    membership = await Membership.create({ userId: user._id, workspaceId: workspace._id, role: 'owner' });
    console.log('Created owner membership.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
