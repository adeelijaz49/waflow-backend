const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const pendingActionSchema = new mongoose.Schema({
  id: String,
  toolName: String,
  args: mongoose.Schema.Types.Mixed,
  summary: String,
  createdAt: Date,
}, { _id: false });

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  sessionId: { type: String, required: true, unique: true }, // frontend-generated, stored in localStorage
  messages: [messageSchema],
  pendingAction: { type: pendingActionSchema, default: null },
}, { timestamps: true, collection: 'ai_chat_sessions' });

module.exports = mongoose.model('AiChatSession', schema);
