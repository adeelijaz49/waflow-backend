require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { authedAgent } = require('./testAuth');
const app = require('../server');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Workspace = require('../models/Workspace');
const Product = require('../models/Product');
const Customer = require('../models/Customer');

// Real end-to-end proof of Phase 3 data isolation: log in as two separate
// workspaces through the actual passwordless auth flow (a brand-new phone
// number with no pending invite self-serve-creates its own Workspace — see
// routes/auth.js#resolveSessionForUser), each create their own Product and
// Customer through the real authenticated HTTP surface, then assert neither
// workspace's list/get routes ever return the other's data.
const WORKSPACE2_PHONE = '15559993000';

describe('Phase 3 — multi-tenant data isolation', () => {
  let owner1, owner2;
  let product1Id, product2Id, customer1Id, customer2Id;
  let workspace2Id;

  beforeAll(async () => {
    await connectOnce();
    if (process.env.AUTH_TEST_MODE !== 'true') {
      throw new Error('AUTH_TEST_MODE must be true in .env to run this suite (never set it in production)');
    }
    owner1 = await authedAgent(app); // the real migrated Owner — Workspace #1

    const otpRes = await request(app).post('/api/auth/otp/request').send({ phone: WORKSPACE2_PHONE });
    const verifyRes = await request(app).post('/api/auth/otp/verify').send({ phone: WORKSPACE2_PHONE, code: otpRes.body.testCode });
    const token2 = verifyRes.body.token;
    workspace2Id = verifyRes.body.workspace.id;
    owner2 = {
      get: (url) => request(app).get(url).set('Authorization', `Bearer ${token2}`),
      post: (url) => request(app).post(url).set('Authorization', `Bearer ${token2}`),
    };

    const p1 = await owner1.post('/api/products').send({ name: '__test_iso_product_ws1__', category: 'Test', basePrice: 10 });
    product1Id = p1.body._id;
    const p2 = await owner2.post('/api/products').send({ name: '__test_iso_product_ws2__', category: 'Test', basePrice: 20 });
    product2Id = p2.body._id;

    const c1 = await owner1.post('/api/customers').send({ firstname: '__test_iso__', lastname: 'ws1', phone: '15559993001' });
    customer1Id = c1.body._id;
    const c2 = await owner2.post('/api/customers').send({ firstname: '__test_iso__', lastname: 'ws2', phone: '15559993002' });
    customer2Id = c2.body._id;
  }, 30000);

  afterAll(async () => {
    await Product.deleteMany({ _id: { $in: [product1Id, product2Id].filter(Boolean) } });
    await Customer.deleteMany({ _id: { $in: [customer1Id, customer2Id].filter(Boolean) } });
    const user2 = await User.findOne({ phone: WORKSPACE2_PHONE });
    if (user2) {
      await Membership.deleteMany({ userId: user2._id });
      await User.deleteOne({ _id: user2._id });
    }
    if (workspace2Id) await Workspace.deleteOne({ _id: workspace2Id });
  });

  test('self-serve login for an unknown phone creates its own separate workspace', () => {
    expect(workspace2Id).toBeTruthy();
  });

  test('listing products never crosses workspaces', async () => {
    const list1 = await owner1.get('/api/products?limit=200');
    expect(list1.body.products.some(p => p._id === product2Id)).toBe(false);
    expect(list1.body.products.some(p => p._id === product1Id)).toBe(true);

    const list2 = await owner2.get('/api/products?limit=200');
    expect(list2.body.products.some(p => p._id === product1Id)).toBe(false);
    expect(list2.body.products.some(p => p._id === product2Id)).toBe(true);
  });

  test('fetching another workspace\'s product by id 404s', async () => {
    const res = await owner2.get(`/api/products/${product1Id}`);
    expect(res.status).toBe(404);

    const reverse = await owner1.get(`/api/products/${product2Id}`);
    expect(reverse.status).toBe(404);
  });

  test('listing customers never crosses workspaces', async () => {
    const list1 = await owner1.get('/api/customers?limit=200');
    expect(list1.body.customers.some(c => c._id === customer2Id)).toBe(false);
    expect(list1.body.customers.some(c => c._id === customer1Id)).toBe(true);

    const list2 = await owner2.get('/api/customers?limit=200');
    expect(list2.body.customers.some(c => c._id === customer1Id)).toBe(false);
    expect(list2.body.customers.some(c => c._id === customer2Id)).toBe(true);
  });

  test('fetching another workspace\'s customer by id 404s', async () => {
    const res = await owner2.get(`/api/customers/${customer1Id}`);
    expect(res.status).toBe(404);

    const reverse = await owner1.get(`/api/customers/${customer2Id}`);
    expect(reverse.status).toBe(404);
  });
});
