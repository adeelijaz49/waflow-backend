'use strict';
// Helper for the STUB modules that the B1 tasks replace. A replaced module no
// longer needs to require this file. Never executed at require time.

/**
 * @param {string} name e.g. 'steps.markStep'
 * @returns {Function} a function that throws Error{ code:'NOT_IMPLEMENTED', status:503 }
 */
function notImplemented(name) {
  return function notImplementedStub() {
    const err = new Error(`${name} is not implemented yet`);
    err.code = 'NOT_IMPLEMENTED';
    err.status = 503;
    throw err;
  };
}

/** An empty Router + createRouter for a stub sub-router. */
function emptyRouter(owner) {
  const express = require('express');
  const createRouter = () => express.Router(); // STUB: owner ${owner} adds the routes
  const router = createRouter();
  router.createRouter = createRouter;
  router.owner = owner;
  return router;
}

module.exports = { notImplemented, emptyRouter };
