'use strict';
// Every *.itest.js calls assertThrowawayDb() first: these tests write real documents,
// so they may only ever run against the throwaway local mongod (never the shared DB).
function assertThrowawayDb() {
  const uri = process.env.MONGODB_URI || '';
  if (!/^mongodb:\/\/127\.0\.0\.1:27099\/waflow_loc_test/.test(uri)) {
    throw new Error('refusing to run: MONGODB_URI is not the throwaway database (127.0.0.1:27099/waflow_loc_test*)');
  }
}
module.exports = { assertThrowawayDb };
