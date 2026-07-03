// Shared in-memory conversation state for the WhatsApp shopping flow.
// Keyed by customer phone number. Not persisted — a server restart clears carts/sessions.
const carts               = new Map(); // phone → [{ name, priceAud, description }]
const pendingCatalogs     = new Map(); // phone → { promotion, products, categories, displayedProducts }
const pendingAddressReqs  = new Map(); // phone → true (awaiting free-text address reply)

module.exports = { carts, pendingCatalogs, pendingAddressReqs };
