// Seeds a single, polished KSA demo merchant — "Riyadh Barber" — replacing whatever
// test/generic data currently exists. Unlike seed.js (large generic clothing catalog,
// AUD, 100 customers sharing one fake phone), this is meant to look and behave like one
// real small business for a live sales demo, with prices in SAR and a coherent catalog
// spanning both major flows the app supports: product purchase and service booking.
//
// Usage: node seed/seed-demo.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const Customer  = require('../models/Customer');
const Product   = require('../models/Product');
const Order     = require('../models/Order');
const Service   = require('../models/Service');
const TimeSlot  = require('../models/TimeSlot');
const Booking   = require('../models/Booking');
const Promotion = require('../models/Promotion');
const Settings  = require('../models/Settings');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/waflow';

// All demo customers share this one real, presenter-controlled WhatsApp number so the
// flow can actually be tested end-to-end without risking messaging a real stranger.
// Swap this for whoever is driving the live demo before the real thing.
const DEMO_PHONE = '61422286126';

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randDate(daysAgo) { return new Date(Date.now() - Math.floor(Math.random() * daysAgo) * 86400000); }

// ─── Services (booking flow) ─────────────────────────────────────────────────
const SERVICES = [
  { name: 'Classic Haircut',          description: 'Precision haircut with wash and style finish.',        category: 'Hair',  duration: 30, basePrice: 40, pointsPrice: 400 },
  { name: 'Beard Trim & Shape',        description: 'Expert beard shaping and edge-up.',                     category: 'Beard', duration: 20, basePrice: 25, pointsPrice: 250 },
  { name: 'Hot Towel Shave',           description: 'Traditional hot towel straight-razor shave.',           category: 'Beard', duration: 25, basePrice: 35, pointsPrice: 350 },
  { name: 'Haircut + Beard Combo',     description: 'Full haircut paired with a beard trim.',                category: 'Hair',  duration: 45, basePrice: 60, pointsPrice: 600 },
  { name: 'Kids Haircut',              description: 'Gentle haircut for children under 12.',                 category: 'Hair',  duration: 20, basePrice: 30, pointsPrice: 300 },
];

// ─── Products (retail / product-purchase flow) ───────────────────────────────
const PRODUCTS = [
  { name: 'Matte Clay Pomade',              description: 'Strong-hold, low-shine styling clay.',                category: 'Hair Care',  basePrice: 45, variants: [{ size: '100ml', color: 'Black',   stock: 30, sku: 'MCP-100' }] },
  { name: 'Argan & Cedarwood Beard Oil',    description: 'Nourishing beard oil with a warm cedarwood scent.',   category: 'Beard Care', basePrice: 55, variants: [{ size: '30ml',  color: 'Amber',   stock: 25, sku: 'ABO-30'  }] },
  { name: 'Wooden Beard Comb',              description: 'Handcrafted sandalwood comb for beard grooming.',     category: 'Beard Care', basePrice: 20, variants: [{ size: 'One Size', color: 'Brown', stock: 40, sku: 'WBC-1' }] },
  { name: 'Beard Balm',                     description: 'Leave-in balm for softness and hold.',                category: 'Beard Care', basePrice: 50, variants: [{ size: '60g',   color: 'Natural', stock: 20, sku: 'BB-60'   }] },
  { name: 'Strong Hold Hair Wax',           description: 'All-day hold with a natural matte finish.',           category: 'Hair Care',  basePrice: 40, variants: [{ size: '80ml',  color: 'Black',   stock: 35, sku: 'SHW-80'  }] },
];

// ─── Customers ────────────────────────────────────────────────────────────────
const CUSTOMERS = [
  { firstname: 'Abdullah', lastname: 'Al-Rashid', address: 'King Fahd Road, Riyadh, Saudi Arabia' },
  { firstname: 'Faisal',   lastname: 'Al-Otaibi',  address: 'Al Olaya District, Riyadh, Saudi Arabia' },
  { firstname: 'Khalid',   lastname: 'Al-Mutairi', address: 'Al Malaz, Riyadh, Saudi Arabia' },
  { firstname: 'Nasser',   lastname: 'Al-Qahtani', address: 'Al Nakheel, Riyadh, Saudi Arabia' },
  { firstname: 'Saad',     lastname: 'Al-Ghamdi',  address: 'Diplomatic Quarter, Riyadh, Saudi Arabia' },
];

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  console.log('Clearing existing data (Customer, Product, Order, Service, TimeSlot, Booking, Promotion)...');
  await Promise.all([
    Customer.deleteMany({}), Product.deleteMany({}), Order.deleteMany({}),
    Service.deleteMany({}), TimeSlot.deleteMany({}), Booking.deleteMany({}), Promotion.deleteMany({}),
  ]);

  console.log('Inserting demo customers...');
  const customers = await Customer.insertMany(
    CUSTOMERS.map(c => ({ ...c, phone: DEMO_PHONE, loyaltyPoints: randInt(0, 900), isDemo: true }))
  );

  console.log('Inserting demo products...');
  const products = await Product.insertMany(PRODUCTS.map(p => ({ ...p, active: true })));

  console.log('Inserting demo services...');
  const services = await Service.insertMany(SERVICES.map(s => ({ ...s, active: true })));

  console.log('Inserting upcoming time slots (next 7 days, 9am–5pm hourly)...');
  const slotDocs = [];
  for (let d = 1; d <= 7; d++) {
    const date = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    for (const service of services) {
      for (let hour = 9; hour < 17; hour++) {
        slotDocs.push({
          serviceId: service._id,
          date,
          startTime: `${String(hour).padStart(2, '0')}:00`,
          endTime:   `${String(hour + 1).padStart(2, '0')}:00`,
          capacity:  1,
          bookedCount: 0,
        });
      }
    }
  }
  const slots = await TimeSlot.insertMany(slotDocs);

  console.log('Inserting a few sample bookings...');
  await Booking.insertMany([
    {
      serviceId: services[0]._id, slotId: slots[0]._id, customerId: customers[0]._id,
      phone: DEMO_PHONE, customerName: `${customers[0].firstname} ${customers[0].lastname}`,
      status: 'confirmed', paymentType: 'cash', amount: services[0].basePrice,
    },
    {
      serviceId: services[3]._id, slotId: slots[1]._id, customerId: customers[1]._id,
      phone: DEMO_PHONE, customerName: `${customers[1].firstname} ${customers[1].lastname}`,
      status: 'completed', paymentType: 'points', pointsUsed: services[3].pointsPrice,
    },
  ]);
  await TimeSlot.findByIdAndUpdate(slots[0]._id, { $inc: { bookedCount: 1 } });
  await TimeSlot.findByIdAndUpdate(slots[1]._id, { $inc: { bookedCount: 1 } });

  console.log('Inserting ~40 historical orders...');
  const orders = [];
  const STATUSES = ['delivered', 'delivered', 'delivered', 'shipped', 'confirmed', 'pending'];
  for (let i = 0; i < 40; i++) {
    const customer = pick(customers);
    const itemCount = randInt(1, 3);
    const items = [];
    let subtotal = 0;
    for (let j = 0; j < itemCount; j++) {
      const product = pick(products);
      const variant = product.variants[0];
      const qty = randInt(1, 2);
      subtotal += product.basePrice * qty;
      items.push({
        product: product._id, productName: product.name, category: product.category,
        size: variant?.size, color: variant?.color, quantity: qty, unitPrice: product.basePrice,
      });
    }
    subtotal = +subtotal.toFixed(2);
    const status = pick(STATUSES);
    const pointsEarned = Math.floor(subtotal * 5); // 5 pts per SAR, matches Settings below
    orders.push({
      customer: customer._id, items, subtotal, total: subtotal, status,
      loyaltyPointsEarned: pointsEarned, createdAt: randDate(60),
    });
  }
  await Order.insertMany(orders);

  console.log('Inserting demo promotions...');
  await Promotion.insertMany([
    {
      name: 'Grand Opening Offer', description: '20% off all grooming products this week.',
      customerType: 'cash', scope: 'products', type: 'store_wide',
      discountPercent: 20, status: 'draft', isDemo: true,
    },
    {
      name: 'Weekend Grooming Special', description: 'Book the Haircut + Beard Combo at a special rate.',
      customerType: 'cash', scope: 'services', type: 'specific_services',
      services: [services[3]._id], discountPercent: 15, status: 'draft', isDemo: true,
    },
  ]);

  console.log('Setting currency to SAR...');
  let settings = await Settings.findOne();
  if (!settings) settings = new Settings();
  settings.currency = 'SAR';
  settings.loyaltyPointsPerUnit = 5;
  settings.minPointsPerPurchase = 50;
  await settings.save();

  const counts = await Promise.all([
    Customer.countDocuments(), Product.countDocuments(), Order.countDocuments(),
    Service.countDocuments(), TimeSlot.countDocuments(), Booking.countDocuments(), Promotion.countDocuments(),
  ]);
  console.log(`\n✅ Demo seed complete: ${counts[0]} customers, ${counts[1]} products, ${counts[2]} orders, ${counts[3]} services, ${counts[4]} time slots, ${counts[5]} bookings, ${counts[6]} promotions. Currency set to SAR.`);
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
