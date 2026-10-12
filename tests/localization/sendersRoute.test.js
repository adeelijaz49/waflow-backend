// Route tests for routes/localization/senders.js (/senders/:sender/plan, /promotions/:id/send-plan | test-send | send-report).
// The REAL routers run behind a stub auth middleware with injected services, so what is verified is the HTTP path:
// tenant scoping from req.user only, validation, status codes and error shapes. No database, no Meta, no WhatsApp.
const express = require('express');
const request = require('supertest');
const { createRouters } = require('../../routes/localization/senders');
const { id, WS, OTHER_WS, PROMOTION_ID, fakeModel, promotionDoc } = require('./legacyTestKit');

function appWith(overrides = {}, { workspaceId = WS } = {}) {
  const deps = {
    plan: {
      planSender: jest.fn(async (args) => ({ planned: 'sender', ...args })),
      planPromotionSend: jest.fn(async (args) => ({ planned: 'promotion', ...args })),
      reportPromotionSends: jest.fn(async (args) => ({ reported: true, ...args })),
    },
    legacy: { sendPromotionTest: jest.fn(async () => ({ sent: true, dryRun: false, usedLanguage: 'ar', templateName: 'wf_x' })) },
    limiter: { take: jest.fn(() => ({ ok: true })) },
    Promotion: fakeModel([promotionDoc()]),
    Settings: fakeModel([{ workspaceId: WS, defaultCountryCode: '966' }]),
    senderValues: { loadPromotionItems: jest.fn(async () => []), realDeps: () => ({}) },
    ...overrides,
  };
  const routers = createRouters(deps);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: id(900), workspaceId, role: 'owner' }; next(); });
  app.use('/senders', routers.senders);
  app.use('/promotions', routers.promotions);
  return { app, routers, deps };
}

describe('POST /senders/:sender/plan', () => {
  test('passes the workspace from the token (never from the body), the sender and the ids', async () => {
    const { app } = appWith();
    const res = await request(app).post('/senders/loyalty_reminder/plan').send({ customerIds: [id(1)], includeIds: true, workspaceId: OTHER_WS });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ planned: 'sender', workspaceId: WS, sender: 'loyalty_reminder', customerIds: [id(1)], includeIds: true });
  });

  test('no body is fine (the sender\'s own audience); a non-boolean includeIds is ignored', async () => {
    const { app } = appWith();
    const res = await request(app).post('/senders/consent_request/plan').send({ includeIds: 'yes' });
    expect(res.status).toBe(200);
    expect(res.body.includeIds).toBe(false);
    expect(res.body.customerIds).toBeUndefined();
  });

  test('service errors keep their status and code; a bare 400 becomes INVALID_INPUT; unknown errors are a 500 without details', async () => {
    const { app } = appWith({
      plan: {
        planSender: jest.fn()
          .mockRejectedValueOnce(Object.assign(new Error('Unknown sender'), { status: 404, code: 'SENDER_NOT_FOUND' }))
          .mockRejectedValueOnce(Object.assign(new Error('ids must be an array'), { status: 400 }))
          .mockRejectedValueOnce(new Error('boom with secret detail')),
      },
    });
    const a = await request(app).post('/senders/x/plan').send({});
    expect(a.status).toBe(404);
    expect(a.body).toEqual({ error: 'Unknown sender', code: 'SENDER_NOT_FOUND' });
    const b = await request(app).post('/senders/loyalty_reminder/plan').send({ customerIds: 'x' });
    expect(b.status).toBe(400);
    expect(b.body).toEqual({ error: 'ids must be an array', code: 'INVALID_INPUT' });
    const c = await request(app).post('/senders/loyalty_reminder/plan').send({});
    expect(c.status).toBe(500);
    expect(JSON.stringify(c.body)).not.toContain('secret');
  });
});

describe('POST /promotions/:id/send-plan and GET /promotions/:id/send-report', () => {
  test('workspace from the token, promotion id from the path', async () => {
    const { app } = appWith();
    const plan = await request(app).post(`/promotions/${PROMOTION_ID}/send-plan`).send({ customerIds: [id(1), id(2)] });
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ planned: 'promotion', workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [id(1), id(2)], includeIds: false });
    const report = await request(app).get(`/promotions/${PROMOTION_ID}/send-report`);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ reported: true, workspaceId: WS, promotionId: PROMOTION_ID });
  });
});

describe('POST /promotions/:id/test-send', () => {
  const post = (app, body, promotionId = PROMOTION_ID) => request(app).post(`/promotions/${promotionId}/test-send`).send(body);

  test('sends through the legacy service with a normalised phone and the workspace\'s promotion', async () => {
    const { app, deps } = appWith();
    const res = await post(app, { phone: '+966 50 123 4567', language: 'ar' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, dryRun: false, usedLanguage: 'ar', templateName: 'wf_x' });
    expect(deps.legacy.sendPromotionTest).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, phone: '966501234567' }));
  });

  test('Arabic-Indic digits and a local 05 number are accepted (default country code of the workspace)', async () => {
    const { app, deps } = appWith();
    expect((await post(app, { phone: '٩٦٦٥٠١٢٣٤٥٦٧' })).status).toBe(200);
    expect(deps.legacy.sendPromotionTest).toHaveBeenLastCalledWith(expect.objectContaining({ phone: '966501234567' }));
    expect((await post(app, { phone: '0501234567' })).status).toBe(200);
    expect(deps.legacy.sendPromotionTest).toHaveBeenLastCalledWith(expect.objectContaining({ phone: '966501234567' }));
  });

  test.each([
    [{ phone: 'abc' }, 400, 'INVALID_PHONE'],
    [{ phone: '123' }, 400, 'INVALID_PHONE'],
    [{ phone: {} }, 400, 'INVALID_PHONE'],
    [{}, 400, 'INVALID_PHONE'],
    [{ phone: '966501234567', language: 'en' }, 400, 'INVALID_INPUT'],
  ])('%j -> %i %s', async (body, status, code) => {
    const { app, deps } = appWith();
    const res = await post(app, body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(deps.legacy.sendPromotionTest).not.toHaveBeenCalled();
  });

  test('another workspace\'s promotion is a 404; a bad id is a 400', async () => {
    const { app } = appWith({}, { workspaceId: OTHER_WS });
    expect((await post(app, { phone: '966501234567' })).status).toBe(404);
    const mine = appWith();
    expect((await post(mine.app, { phone: '966501234567' }, 'nope')).status).toBe(400);
  });

  test('rate limited: 429 with Retry-After and nothing sent', async () => {
    const { app, deps } = appWith({ limiter: { take: jest.fn(() => ({ ok: false, retryAfterSeconds: 120 })) } });
    const res = await post(app, { phone: '966501234567' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('120');
    expect(deps.legacy.sendPromotionTest).not.toHaveBeenCalled();
  });

  test('409 NO_ARABIC_VERSION carries the reason; 502 META_ERROR carries no upstream detail', async () => {
    const noVersion = Object.assign(new Error('There is no Arabic version of this promotion that can be sent'), { status: 409, code: 'NO_ARABIC_VERSION', details: { reason: 'pending' } });
    const a = appWith({ legacy: { sendPromotionTest: jest.fn().mockRejectedValue(noVersion) } });
    const res = await post(a.app, { phone: '966501234567' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: noVersion.message, code: 'NO_ARABIC_VERSION', reason: 'pending' });
    const metaFail = Object.assign(new Error('WhatsApp could not send the message'), { status: 502, code: 'META_ERROR', details: { metaCode: '131026' } });
    const b = appWith({ legacy: { sendPromotionTest: jest.fn().mockRejectedValue(metaFail) } });
    const res2 = await post(b.app, { phone: '966501234567' });
    expect(res2.status).toBe(502);
    expect(res2.body).toEqual({ error: 'WhatsApp could not send the message', code: 'META_ERROR' });
  });
});

describe('mounting', () => {
  test('routes/localization/index.js mounts both routers behind the arabic_enabled flag', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../routes/localization/index.js'), 'utf8');
    expect(source).toContain("router.use('/senders', requireArabicEnabled, senderRoutes.senders);");
    expect(source).toContain("router.use('/promotions', requireArabicEnabled, senderRoutes.promotions);");
  });
});
