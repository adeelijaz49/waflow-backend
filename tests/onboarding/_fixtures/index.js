'use strict';
// One import for every onboarding test:
//   const { createFakeGraph, createFakeStripe, createFakeSend, fixedClock, fakeRandom } = require('../_fixtures');

const graph = require('./fakeGraph');
const stripe = require('./fakeStripe');
const resend = require('./fakeResend');
const helpers = require('./helpers');

module.exports = {
  // Meta Graph
  createFakeGraph: graph.createFakeGraph,
  graphError: graph.graphError,
  GRAPH_ORIGIN: graph.GRAPH_ORIGIN,
  GRAPH_VERSION: graph.GRAPH_VERSION,
  // Stripe
  createFakeStripe: stripe.createFakeStripe,
  signedEvent: stripe.signedEvent,
  makeEvent: stripe.makeEvent,
  makeSubscription: stripe.makeSubscription,
  makeInvoice: stripe.makeInvoice,
  makeCheckoutSession: stripe.makeCheckoutSession,
  TEST_WEBHOOK_SECRET: stripe.TEST_WEBHOOK_SECRET,
  // E-mail
  createFakeSend: resend.createFakeSend,
  // Clock / randomness
  fixedClock: helpers.fixedClock,
  fakeRandom: helpers.fakeRandom,
};
