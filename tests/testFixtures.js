const Customer = require('../models/Customer');

// Every real (non-demo) Customer now defaults to marketingConsent:false (Data
// Protection Compliance — see shared/consent.js), so any test exercising a
// marketing send path (Promotions, Loyalty Reminders, or an Automated Flow)
// needs its fixture customer opted in explicitly, or it'll be silently
// excluded exactly like a real uncontacted customer would be. Demo customers
// (isDemo:true) don't need this — shared/consent.js exempts them, since
// nothing real ever sends to demo/fake data regardless of consent state.
function createConsentedCustomer(overrides = {}) {
  return Customer.create({
    marketingConsent: true,
    marketingConsentAt: new Date(),
    marketingConsentMethod: 'manual_staff_entry',
    ...overrides,
  });
}

module.exports = { createConsentedCustomer };
