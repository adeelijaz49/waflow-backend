// Shared in-memory conversation state for the WhatsApp shopping flow.
// Keyed by customer phone number. Not persisted — a server restart clears all state.
const carts                  = new Map(); // phone → [{ name, priceAud, pointsCost, description }]
const pendingCatalogs        = new Map(); // phone → { promotion, products, categories, displayedProducts }
const pendingAddressReqs     = new Map(); // phone → 'cash'|'points' (awaiting free-text address reply)
const pendingPointsCheckouts = new Map(); // phone → { cart, promotion, totalPointsCost, address }
const pendingSlotSelections   = new Map(); // phone → { service, promotion, slots, isFree, oldBookingId }
const pendingServiceCheckouts = new Map(); // phone → { service, slot, promotion, totalPointsCost }
const pendingVariantSelections = new Map(); // phone → { product, promotion }
const pendingPayLaterSlots = new Map(); // phone → { service, slot } — "Reserve, Pay in Person" offer

module.exports = {
  carts,
  pendingCatalogs,
  pendingAddressReqs,
  pendingPointsCheckouts,
  pendingSlotSelections,
  pendingServiceCheckouts,
  pendingVariantSelections,
  pendingPayLaterSlots,
};
