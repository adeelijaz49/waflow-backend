module.exports = {
  // The DB here is a real cloud instance (Cosmos DB for MongoDB), not a local
  // container — occasional latency spikes can exceed Jest's default 5000ms for
  // a beforeAll/afterAll doing a few sequential writes. Give hooks and tests
  // more room rather than chasing intermittent timeout flakiness.
  testTimeout: 15000,
};
