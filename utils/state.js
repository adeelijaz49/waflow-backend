// Shared in-memory conversation state for the WhatsApp shopping flow.
// Keyed by customer phone number. Not persisted — a server restart clears carts/sessions.
const carts                  = new Map(); // phone → [{ name, priceAud, pointsCost, description }]
const pendingCatalogs        = new Map(); // phone → { promotion, products, categories, displayedProducts }
const pendingAddressReqs     = new Map(); // phone → 'cash'|'points' (awaiting free-text address reply)
const pendingPointsCheckouts = new Map(); // phone → { cart, promotion, totalPointsCost, address }

module.exports = { carts, pendingCatalogs, pendingAddressReqs, pendingPointsCheckouts };
