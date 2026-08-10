require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const ConsentEvent = require('../models/ConsentEvent');
const AdminAuditLog = require('../models/AdminAuditLog');

const USER = process.env.INTERNAL_ADMIN_USER;
const PASS = process.env.INTERNAL_ADMIN_PASSWORD;
const basicAuth = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

describe('/internal-admin', () => {
  let workspaceId, customer;

  beforeAll(async () => {
    await connectOnce();
    workspaceId = await getTestWorkspaceId(app);
    if (!USER || !PASS) throw new Error('INTERNAL_ADMIN_USER/PASSWORD must be set in .env for this test');
  }, 30000);

  afterEach(async () => {
    if (customer) {
      await ConsentEvent.deleteMany({ customerId: customer._id });
      await Order.deleteMany({ customer: customer._id });
      await Customer.findByIdAndDelete(customer._id);
      customer = null;
    }
    await AdminAuditLog.deleteMany({ targetPhone: '15559993333' });
  });

  test('rejects requests with no credentials', async () => {
    const res = await request(app).get('/internal-admin/');
    expect(res.status).toBe(401);
  });

  test('rejects wrong credentials', async () => {
    const res = await request(app).get('/internal-admin/').set('Authorization', basicAuth('wrong', 'wrong'));
    expect(res.status).toBe(401);
  });

  test('accepts correct credentials and logs a login_success entry', async () => {
    const res = await request(app).get('/internal-admin/').set('Authorization', basicAuth(USER, PASS));
    expect(res.status).toBe(200);
    const logs = await AdminAuditLog.find({ action: 'login_success' }).sort({ createdAt: -1 }).limit(1);
    expect(logs.length).toBe(1);
  });

  test('search finds a customer by phone and view logs view_customer', async () => {
    customer = await Customer.create({ firstname: 'Search', lastname: 'Target', phone: '15559993333', workspaceId });

    const search = await request(app).get('/internal-admin/customers?q=15559993333').set('Authorization', basicAuth(USER, PASS));
    expect(search.status).toBe(200);
    expect(search.text).toContain('Search Target');

    const view = await request(app).get(`/internal-admin/customers/${customer._id}`).set('Authorization', basicAuth(USER, PASS));
    expect(view.status).toBe(200);

    const viewLog = await AdminAuditLog.findOne({ action: 'view_customer', targetCustomerId: customer._id });
    expect(viewLog).toBeTruthy();
  });

  test('correct updates PII and logs the field diff', async () => {
    customer = await Customer.create({ firstname: 'Before', lastname: 'Correction', phone: '15559993333', workspaceId });

    const res = await request(app).post(`/internal-admin/customers/${customer._id}/correct`)
      .set('Authorization', basicAuth(USER, PASS))
      .type('form')
      .send({ firstname: 'After', lastname: 'Correction', phone: customer.phone, email: '', address: '' });
    expect(res.status).toBe(302);

    const updated = await Customer.findById(customer._id);
    expect(updated.firstname).toBe('After');

    const log = await AdminAuditLog.findOne({ action: 'correct_customer', targetCustomerId: customer._id });
    expect(log.detail.fieldsChanged).toContain('firstname');
  });

  test('delete anonymizes the customer but leaves Order history intact', async () => {
    customer = await Customer.create({ firstname: 'ToDelete', lastname: 'Person', phone: '15559993333', email: 'todelete@example.com', workspaceId, marketingConsent: true });
    const order = await Order.create({ customer: customer._id, workspaceId, subtotal: 10, total: 10, status: 'delivered' });

    const res = await request(app).post(`/internal-admin/customers/${customer._id}/delete`)
      .set('Authorization', basicAuth(USER, PASS))
      .type('form')
      .send({ reason: 'test deletion request' });
    expect(res.status).toBe(302);

    const updated = await Customer.findById(customer._id);
    expect(updated.firstname).toBe('Deleted');
    expect(updated.email).toBeFalsy();
    expect(updated.marketingConsent).toBe(false);
    expect(updated.optedOut).toBe(true);
    expect(updated.deletedAt).toBeTruthy();

    const survivingOrder = await Order.findById(order._id);
    expect(survivingOrder).toBeTruthy(); // financial record retained, not cascaded

    const log = await AdminAuditLog.findOne({ action: 'delete_customer', targetCustomerId: customer._id });
    expect(log).toBeTruthy();

    await Order.findByIdAndDelete(order._id);
  });
});
