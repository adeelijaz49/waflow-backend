'use strict';
// A search term typed by a person is data, never pattern syntax: every character that means something in a regular expression is
// escaped, so "(" or "+966" finds those characters instead of failing with a malformed pattern (HTTP 500) and ".*" cannot match
// everything. Used by the list/search endpoints that build a $regex from a query-string value.
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = escapeRegex;
module.exports.escapeRegex = escapeRegex;
