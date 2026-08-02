// One-time migration (Phase 3): backfill workspaceId onto every pre-existing
// document across the 13 workspace-scoped collections, pointing them all at
// Workspace #1 (the one scripts/migrate-to-workspace.js created for today's
// single-tenant data). Safe to re-run: updateMany's filter only ever touches
// documents that are still missing workspaceId.
require('dotenv').config();
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const Product = require('../models/Product');
const Service = require('../models/Service');
const TimeSlot = require('../models/TimeSlot');
const Customer = require('../models/Customer');
const Booking = require('../models/Booking');
const Order = require('../models/Order');
const Promotion = require('../models/Promotion');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const MessageNode = require('../models/MessageNode');
const CampaignMessage = require('../models/CampaignMessage');
const Settings = require('../models/Settings');
const AiChatSession = require('../models/AiChatSession');

const MODELS = [
  Product, Service, TimeSlot, Customer, Booking, Order, Promotion,
  Flow, FlowEnrollment, MessageNode, CampaignMessage, Settings, AiChatSession,
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const workspace = await Workspace.findOne().sort({ createdAt: 1 });
  if (!workspace) throw new Error('No workspace exists yet — run scripts/migrate-to-workspace.js first');
  console.log('Backfilling workspaceId =', workspace._id.toString(), `(${workspace.name})`);

  for (const Model of MODELS) {
    const filter = { $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] };
    const res = await Model.updateMany(filter, { $set: { workspaceId: workspace._id } });
    console.log(`  ${Model.modelName}: matched ${res.matchedCount}, modified ${res.modifiedCount}`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
