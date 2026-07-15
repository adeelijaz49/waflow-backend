const mongoose = require('mongoose');

// Shared by every test file. Jest (--runInBand) loads test files sequentially
// in one process, so mongoose's connection is a real singleton across files —
// connect once here and never disconnect mid-run. Each file previously called
// its own mongoose.connect()/disconnect() pair, which raced against whichever
// file ran next and caused intermittent "connection closed" style flakiness.
// The connection closes naturally when the process exits (--forceExit).
async function connectOnce() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
}

module.exports = { connectOnce };
