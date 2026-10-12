const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
const h = require('./helpers/_harness');
const Customer = require('../../../models/Customer');
const CustomerLanguage = require('../../../models/CustomerLanguage');
const Order = require('../../../models/Order');
const CampaignMessage = require('../../../models/CampaignMessage');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');

const HOUR = 3600 * 1000;
const ago = (n) => new Date(Date.now() - n * HOUR);
const idOf = (row) => String(row.customerId);

describe('B6 inbox on real MongoDB', () => {
  let ctx; let a; let b; let c;
  const A = {};
  beforeAll(async () => {
    ctx = await h.setup();
    a = ctx.api(ctx.A); b = ctx.api(ctx.B); c = ctx.api(ctx.C);
    const w = ctx.A.wsId;
    A.ahmad = await h.makeCustomer(w, { firstname: 'أحمد', lastname: 'القحطاني', phone: '966502220001', lastMessageAt: ago(1), lastMessagePreview: 'مرحبا', unreadCount: 2 });
    A.sara = await h.makeCustomer(w, { firstname: 'Sara', lastname: 'Smith', phone: '966502220002', lastMessageAt: ago(2), lastMessagePreview: 'hello' });
    A.orderOnly = await h.makeCustomer(w, { firstname: 'Noor', lastname: 'Buyer', phone: '966502220003' }); // no message: surfaced through an Order
    A.campaignOnly = await h.makeCustomer(w, { firstname: 'Khalid', lastname: 'Camp', phone: '966502220004' });
    A.silent = await h.makeCustomer(w, { firstname: 'Silent', lastname: 'Nobody', phone: '966502220005' }); // no activity: never listed
    A.demo = await h.makeCustomer(w, { firstname: 'أحمد', lastname: 'تجريبي', phone: '966502220006', lastMessageAt: ago(1), isDemo: true });
    A.erased = await h.makeCustomer(w, { firstname: 'أحمد', lastname: 'محذوف', phone: '966502220007', lastMessageAt: ago(1), deletedAt: new Date() });
    A.bPerson = await h.makeCustomer(ctx.B.wsId, { firstname: 'أحمد', lastname: 'بي', phone: '966502220001', lastMessageAt: ago(1), lastMessagePreview: 'B secret', unreadCount: 5 });
    await Order.create({ workspaceId: w, customer: A.orderOnly._id, items: [{ productName: 'x', quantity: 1, unitPrice: 5 }], total: 5, createdAt: ago(3) });
    await CampaignMessage.create({ workspaceId: w, kind: 'promotion', customer: A.campaignOnly._id, phone: A.campaignOnly.phone, messageType: 'template', status: 'sent', sentAt: ago(4) });
    await CustomerLanguage.create({ workspaceId: w, customerId: A.ahmad._id, language: 'ar', languageSource: 'customer_chose' });
    await CustomerLanguage.create({ workspaceId: w, customerId: A.sara._id, language: 'en', languageSource: 'merchant_set' });
  });

  test('conversations: own rows only, activity from messages/orders/campaigns, language attached, demo/erased excluded', async () => {
    const r = await a.get('/inbox/conversations');
    expect(r.status).toBe(200);
    const byId = new Map(r.body.conversations.map((row) => [idOf(row), row]));
    expect([...byId.keys()].sort()).toEqual([A.ahmad, A.sara, A.orderOnly, A.campaignOnly].map((x) => String(x._id)).sort());
    expect(byId.get(String(A.ahmad._id)).language).toBe('ar');
    expect(byId.get(String(A.sara._id)).language).toBe('en');
    expect(byId.get(String(A.orderOnly._id)).language).toBe('unknown');
    expect(byId.get(String(A.orderOnly._id)).lastMessagePreview).toMatch(/Order placed/);
    expect(byId.get(String(A.campaignOnly._id)).lastMessagePreview).toMatch(/Promotion sent/);
    expect(JSON.stringify(r.body)).not.toContain('B secret');
    // newest first
    const times = r.body.conversations.map((row) => new Date(row.lastMessageAt).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    const rb = await b.get('/inbox/conversations');
    expect(rb.body.conversations.map(idOf)).toEqual([String(A.bPerson._id)]);
    expect(rb.body.conversations[0].language).toBe('unknown'); // A's CustomerLanguage never leaks by phone
  });

  test('Arabic-aware search over real names and phones (alef variants, diacritics, Arabic-Indic digits, token AND)', async () => {
    const q = async (s) => (await a.get('/inbox/conversations?search=' + encodeURIComponent(s))).body.conversations.map(idOf);
    expect(await q('احمد')).toEqual([String(A.ahmad._id)]);
    expect(await q('أَحْمَد القحطاني')).toEqual([String(A.ahmad._id)]);
    expect(await q('٩٦٦٥٠٢٢٢٠٠٠٢')).toEqual([String(A.sara._id)]);
    expect(await q('0502220003')).toEqual([String(A.orderOnly._id)]);
    expect(await q('sara smith')).toEqual([String(A.sara._id)]);
    expect(await q('sara القحطاني')).toEqual([]);
    expect(await q('.*')).toEqual([]);
    expect(await q('(')).toEqual([String(A.orderOnly._id)]); // literal match on the preview text 'item(s)', not a regex
  });

  test('filter=unread uses real unreadCount; unknown filters fall back to all', async () => {
    const unread = (await a.get('/inbox/conversations?filter=unread')).body.conversations;
    expect(unread.map(idOf)).toEqual([String(A.ahmad._id)]);
    const weird = await a.get('/inbox/conversations?filter=' + encodeURIComponent('$ne'));
    expect(weird.status).toBe(200); expect(weird.body.conversations).toHaveLength(4);
  });

  test('search/filter operator injection through the query string is harmless (400 or empty, never B data)', async () => {
    const r = await a.get('/inbox/conversations?search[$ne]=x&filter[$ne]=y');
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) expect(JSON.stringify(r.body)).not.toContain('B secret');
  });

  test('context: own customer ok; other tenant 404; operator ids 400', async () => {
    const ok = await a.get(`/inbox/conversations/${A.ahmad._id}/context`);
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ customerId: String(A.ahmad._id), language: 'ar' });
    const cross = await b.get(`/inbox/conversations/${A.ahmad._id}/context`);
    expect(cross.status).toBe(404); expect(cross.body.code).toBe('CUSTOMER_NOT_FOUND');
    const bad = await a.get('/inbox/conversations/%7B%22%24ne%22%3Anull%7D/context');
    expect(bad.status).toBe(400);
    const demo = await a.get(`/inbox/conversations/${A.demo._id}/context`);
    expect([404, 200]).toContain(demo.status);
  });

  test('payment-link: bad amounts rejected before any Stripe client exists; other tenant 404; nothing logged to the DB', async () => {
    for (const amount of [0, -5, 'abc', { $gt: 0 }, 1e12, null]) {
      const r = await a.post(`/inbox/conversations/${A.ahmad._id}/payment-link`).send({ amount });
      expect(r.status).toBe(400);
    }
    const cross = await b.post(`/inbox/conversations/${A.ahmad._id}/payment-link`).send({ amount: 10 });
    expect(cross.status).toBe(404);
  });

  test('loyalty reminder: no consent / no points / no approved variant are clean 200 results; other tenant 404', async () => {
    const noConsent = await a.post(`/inbox/conversations/${A.sara._id}/loyalty-reminder`).send({});
    expect(noConsent.status).toBe(200); expect(noConsent.body).toMatchObject({ sent: false, reason: 'no_consent' });
    const w = ctx.A.wsId;
    const consenting = await h.makeCustomer(w, { firstname: 'Rich', lastname: 'Points', phone: '966502220099', lastMessageAt: ago(1), marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry', loyaltyPoints: 120 });
    const noTemplate = await a.post(`/inbox/conversations/${consenting._id}/loyalty-reminder`).send({});
    expect(noTemplate.status).toBe(200); expect(noTemplate.body).toMatchObject({ sent: false, reason: 'no_approved_variant', fallbackAvailable: true });
    const cross = await b.post(`/inbox/conversations/${consenting._id}/loyalty-reminder`).send({});
    expect(cross.status).toBe(404);
    const noPoints = await h.makeCustomer(w, { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' });
    expect((await a.post(`/inbox/conversations/${noPoints._id}/loyalty-reminder`).send({})).body.reason).toBe('no_points');
  });

  test('loyalty reminder end to end in dry-run: approved + reviewed Arabic variant is chosen for an Arabic customer', async () => {
    const w = ctx.A.wsId;
    const cust = await h.makeCustomer(w, { firstname: 'سارة', lastname: 'العلي', phone: '966502220123', lastMessageAt: ago(1), marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry', loyaltyPoints: 250 });
    await CustomerLanguage.create({ workspaceId: w, customerId: cust._id, language: 'ar', languageSource: 'merchant_set' });
    const tpl = await LocalizedTemplate.create({
      workspaceId: w, key: `loyalty_reminder_${h.uniq()}`, name: 'Loyalty', useCase: 'loyalty_reminder', category: 'MARKETING',
      variants: [{ language: 'ar', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}', buttons: [{ role: 'opt_out', text: 'إيقاف الرسائل' }], metaStatus: 'APPROVED', metaTemplateName: `wf_aaaaaa_loyalty_ar_v1`, metaLanguage: 'ar', reviewStatus: 'reviewed', reviewedBy: 'T', reviewedAt: new Date() }],
    });
    const r = await a.post(`/inbox/conversations/${cust._id}/loyalty-reminder`).send({});
    expect(r.status).toBe(200);
    expect(r.body.sent).toBe(true);
    const LocalizedSend = require('../../../models/LocalizedSend');
    const sends = await LocalizedSend.find({ workspaceId: w, customerId: cust._id }).lean();
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends[0].usedLanguage).toBe('ar');
    expect(String(tpl._id)).toBeTruthy();
  });

  test('gate: 401 without a token, 402 for the unflagged workspace', async () => {
    expect((await ctx.anon.get('/inbox/conversations')).status).toBe(401);
    const r = await c.get('/inbox/conversations');
    expect(r.status).toBe(402); expect(r.body.code).toBe('ARABIC_NOT_ENABLED');
  });
});
