require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops = require('../shared/operations');
const Customer = require('../models/Customer');

describe('listCustomers search matches a full "First Last" name', () => {
  let customer;

  beforeAll(async () => {
    await connectOnce();
    customer = await Customer.create({ firstname: '__test_search__', lastname: 'FullNameCase', phone: '15559990399' });
  }, 15000);

  afterAll(async () => {
    await Customer.deleteOne({ _id: customer._id });
  });

  // Root-caused via an AI Mode incident: searching "Adeel Ijaz" (a real
  // customer) returned zero results because the old filter checked the whole
  // search string against firstname OR lastname independently - a two-word
  // full name never matches either field alone.
  test('a two-word search matches firstname+lastname together, not just each half', async () => {
    const full = await ops.listCustomers({ search: '__test_search__ FullNameCase' });
    expect(full.customers.map(c => c._id.toString())).toContain(customer._id.toString());
  });

  test('single-field searches (firstname alone, lastname alone) still work', async () => {
    const byFirst = await ops.listCustomers({ search: '__test_search__' });
    expect(byFirst.customers.map(c => c._id.toString())).toContain(customer._id.toString());

    const byLast = await ops.listCustomers({ search: 'FullNameCase' });
    expect(byLast.customers.map(c => c._id.toString())).toContain(customer._id.toString());
  });
});
