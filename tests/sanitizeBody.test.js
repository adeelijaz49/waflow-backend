'use strict';
// Unit tests for middleware/sanitizeBody.js: a request body may carry the FIELDS of a record, never whose it is (workspaceId, _id),
// whether it is demo data (isDemo) or an update operator ("$set"). Pure: no database.
const sanitizeBody = require('../middleware/sanitizeBody');

function run(method, body) {
  const req = { method, body };
  const res = { statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, json(p) { this.payload = p; return this; } };
  let nextCalls = 0;
  sanitizeBody(req, res, () => { nextCalls += 1; });
  return { req, res, nextCalls };
}

describe('sanitizeBody', () => {
  test.each(['POST', 'PUT', 'PATCH'])('%s: workspaceId, _id, __v and isDemo are dropped, every other field is kept', (method) => {
    const body = { name: 'Mine', price: 3, workspaceId: 'someone-else', _id: 'forced-id', __v: 7, isDemo: true, nested: { workspaceId: 'kept: only the top level is a record field' } };
    const { req, res, nextCalls } = run(method, body);
    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBeNull();
    expect(req.body).toEqual({ name: 'Mine', price: 3, nested: { workspaceId: 'kept: only the top level is a record field' } });
    expect('isDemo' in req.body).toBe(false); // isDemo switches the consent gate and the real-send guard off: it never comes from a request
  });

  test.each(['POST', 'PUT', 'PATCH'])('%s: a top-level "$operator" key is refused with 400 and the request goes no further', (method) => {
    const { res, nextCalls } = run(method, { name: 'x', $set: { workspaceId: 'someone-else' } });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ error: 'Invalid field name.' });
    expect(nextCalls).toBe(0);
  });

  test('a "$" inside a value, or in a nested key, is not a top-level operator and is let through', () => {
    const { req, res, nextCalls } = run('POST', { name: 'costs $5 {$x}', extra: { $gt: 1 } });
    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBeNull();
    expect(req.body.name).toBe('costs $5 {$x}');
  });

  test('reading and deleting are not touched at all', () => {
    for (const method of ['GET', 'DELETE', 'HEAD', 'OPTIONS']) {
      const body = { workspaceId: 'x', $set: 1 };
      const { req, nextCalls, res } = run(method, body);
      expect(nextCalls).toBe(1);
      expect(res.statusCode).toBeNull();
      expect(req.body).toBe(body);
      expect(req.body.workspaceId).toBe('x');
    }
  });

  test('an array, an empty, a missing or a text body passes untouched', () => {
    const list = [{ workspaceId: 'x' }];
    for (const body of [list, undefined, null, '', 'text', 42]) {
      const { req, nextCalls, res } = run('POST', body);
      expect(nextCalls).toBe(1);
      expect(res.statusCode).toBeNull();
      expect(req.body).toBe(body);
    }
    expect(list[0].workspaceId).toBe('x'); // an array body is not a record: nothing inside it is rewritten
  });

  test('the list of dropped fields is exported and is what the tests above assume', () => {
    expect(sanitizeBody.DROPPED).toEqual(['workspaceId', '_id', '__v', 'isDemo']);
    expect(sanitizeBody.sanitizeBody).toBe(sanitizeBody);
  });
});
