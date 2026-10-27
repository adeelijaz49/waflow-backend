'use strict';
// Mongoose builds a model's indexes in the background when the app starts and, when one cannot be built (Cosmos DB for MongoDB
// refuses a unique index on a collection that already holds documents), says nothing: the app runs and the database does NOT
// enforce that rule. For the few indexes whose absence matters (a customer's WhatsApp number belongs to one customer; a WhatsApp
// message id is recorded once) the failure is made loud in the log, so it is seen in the first minutes after a deploy, not months later.
function watchIndexes(Model) {
  Model.on('index', (err) => {
    if (err) {
      console.error(`[indexes] ${Model.modelName}: an index could not be built (${err.message}). `
        + 'The rule it stands for is NOT enforced by the database until it exists - see docs/platform-multitenancy-and-optin.md, section "Data changes and indexes".');
    }
  });
  return Model;
}

module.exports = watchIndexes;
module.exports.watchIndexes = watchIndexes;
