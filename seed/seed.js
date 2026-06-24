require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Customer  = require('../models/Customer');
const Product   = require('../models/Product');
const Order     = require('../models/Order');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/waflow';
const PHONE = '61422286126'; // all customers use this phone for testing

// ─── Data templates ──────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'James','Oliver','Harry','Jack','George','Noah','Charlie','Jacob','Alfie','Freddie',
  'Amelia','Olivia','Isla','Emily','Poppy','Ava','Isabella','Jessica','Lily','Sophie',
  'Muhammad','Ahmed','Omar','Yusuf','Ali','Fatima','Aisha','Zara','Sara','Layla',
  'Liam','Emma','Lucas','Mia','Ethan','Charlotte','Mason','Harper','Logan','Evelyn',
  'Adeel','Rania','Tariq','Nadia','Bilal','Hina','Kamran','Sana','Imran','Ayesha',
  'Thomas','Grace','William','Hannah','Henry','Lucy','Edward','Ella','Samuel','Chloe',
  'Daniel','Victoria','Joshua','Scarlett','Alexander','Madison','Michael','Eleanor','David','Anna',
  'Ryan','Zoe','Nathan','Natalie','Luke','Samantha','Adam','Rachel','Dylan','Laura',
  'Connor','Amy','Jordan','Megan','Tyler','Nicole','Brandon','Stephanie','Caleb','Jennifer',
  'Aiden','Abigail','Hunter','Alexis','Evan','Brittany','Sean','Kaitlyn','Aaron','Taylor',
];

const LAST_NAMES = [
  'Smith','Jones','Williams','Taylor','Brown','Davies','Evans','Wilson','Thomas','Roberts',
  'Johnson','White','Martin','Anderson','Thompson','Garcia','Martinez','Robinson','Clark','Rodriguez',
  'Lewis','Lee','Walker','Hall','Allen','Young','Hernandez','King','Wright','Lopez',
  'Hill','Scott','Green','Adams','Baker','Gonzalez','Nelson','Carter','Mitchell','Perez',
  'Khan','Ahmed','Ali','Hassan','Malik','Patel','Shah','Kumar','Singh','Sharma',
  'Moore','Jackson','Harris','Martin','Garcia','Thompson','Williams','Robinson','Walker','Lewis',
  'Parker','Collins','Edwards','Stewart','Morris','Murphy','Cook','Rogers','Morgan','Peterson',
  'Cooper','Reed','Bailey','Bell','Gomez','Kelly','Howard','Ward','Cox','Diaz',
  'Richardson','Wood','Watson','Brooks','Bennett','Gray','James','Reyes','Hughes','Price',
  'Sanders','Jenkins','Ross','Perry','Powell','Long','Patterson','Hughes','Flores','Washington',
];

const CATEGORIES = {
  "Men's Clothing": {
    types: ['Oxford Shirt','Chinos','Wool Blazer','V-Neck Jumper','Polo Shirt','Linen Shirt','Formal Trousers','Straight Jeans','Parka Jacket','Crew Neck Sweater','Cargo Shorts','Tailored Jacket','Denim Jacket','Rugby Shirt','Waistcoat'],
    prefixes: ['Classic','Premium','Slim Fit','Regular Fit','Tailored'],
    sizes: ['XS','S','M','L','XL','XXL'],
    colors: ['White','Black','Navy','Sky Blue','Grey','Beige','Olive','Khaki'],
    priceRange: [25, 180],
  },
  "Women's Clothing": {
    types: ['Wrap Dress','Midi Skirt','Tailored Blazer','Silk Blouse','Floral Dress','Linen Trousers','Cashmere Jumper','Maxi Dress','Pencil Skirt','Shirt Dress','Peplum Top','Wide Leg Trousers','Shift Dress','Jersey Top','Cami Dress'],
    prefixes: ['Floral','Classic','Premium','Casual','Elegant','Everyday'],
    sizes: ['XS','S','M','L','XL','XXL'],
    colors: ['Black','White','Navy','Blush Pink','Sage Green','Camel','Red','Lilac','Ivory'],
    priceRange: [20, 200],
  },
  "Kids' Clothing": {
    types: ['Graphic T-Shirt','Denim Shorts','Hoodie','School Polo Shirt','Leggings','Pyjama Set','Knit Jumper','Jogger Pants','Printed Dress','Fleece Jacket'],
    prefixes: ['Fun','Bright','Cosy','School'],
    sizes: ['3-4y','5-6y','7-8y','9-10y','11-12y'],
    colors: ['Blue','Red','Green','Yellow','Pink','Grey','Navy','Purple'],
    priceRange: [10, 60],
  },
  'Footwear': {
    types: ['Derby Shoes','Chelsea Boots','Leather Loafers','Running Trainers','Ankle Boots','Leather Sandals','Slip-on Shoes','Ballet Flats','Wedge Heels','Suede Loafers','Hiking Boots','Court Shoes','Espadrilles','Mule Sandals','Platform Trainers'],
    prefixes: ['Leather','Suede','Classic','Premium','Casual'],
    sizes: ['5','6','7','8','9','10','11'],
    colors: ['Black','Brown','Tan','Navy','White','Nude','Grey'],
    priceRange: [30, 180],
  },
  'Accessories': {
    types: ['Leather Belt','Leather Wallet','Silk Scarf','Wool Scarf','Canvas Tote Bag','Leather Handbag','Crossbody Bag','Woollen Hat','Baseball Cap','Leather Gloves','Sunglasses','Tie','Pocket Square','Umbrella','Backpack'],
    prefixes: ['Classic','Premium','Casual','Luxury','Everyday','Designer'],
    sizes: ['One Size'],
    colors: ['Black','Brown','Tan','Navy','Grey','Camel','Red','Burgundy','Multi'],
    priceRange: [15, 250],
  },
};

const STATUSES = ['delivered','delivered','delivered','delivered','shipped','confirmed','pending','cancelled'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return +(Math.random() * (max - min) + min).toFixed(2); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randDate(daysAgo) {
  return new Date(Date.now() - Math.floor(Math.random() * daysAgo) * 86400000);
}

// ─── Generate data ────────────────────────────────────────────────────────────

function buildCustomers() {
  const customers = [];
  const usedNames = new Set();
  for (let i = 0; i < 100; i++) {
    let fn, ln;
    do {
      fn = FIRST_NAMES[i % FIRST_NAMES.length];
      ln = LAST_NAMES[randInt(0, LAST_NAMES.length - 1)];
    } while (usedNames.has(`${fn}${ln}`));
    usedNames.add(`${fn}${ln}`);
    customers.push({ firstname: fn, lastname: ln, phone: PHONE, loyaltyPoints: 0 });
  }
  return customers;
}

function buildProducts() {
  const products = [];
  for (const [category, cfg] of Object.entries(CATEGORIES)) {
    for (const type of cfg.types) {
      for (const prefix of cfg.prefixes) {
        const basePrice = rand(...cfg.priceRange);
        const colors = cfg.colors.slice(0, randInt(3, Math.min(6, cfg.colors.length)));
        const variants = [];
        for (const size of cfg.sizes) {
          for (const color of colors) {
            variants.push({
              size,
              color,
              stock: randInt(0, 50),
              sku: `${category.replace(/[^A-Z]/g,'').slice(0,3)}-${type.replace(/\s/g,'').slice(0,4).toUpperCase()}-${size}-${color.replace(/\s/g,'').slice(0,3).toUpperCase()}`,
            });
          }
        }
        const seed = encodeURIComponent(`${prefix}-${type}`).slice(0,20);
        products.push({
          name: `${prefix} ${type}`,
          description: `Our ${prefix.toLowerCase()} ${type.toLowerCase()} — quality craftsmanship with a modern fit.`,
          category,
          basePrice,
          variants,
          images: [`https://picsum.photos/seed/${seed}/400/400`],
          active: true,
        });
      }
    }
  }
  return products;
}

function buildOrders(customers, products, count = 3000) {
  const orders = [];
  const customerSpend = {};

  for (let i = 0; i < count; i++) {
    const customer = pick(customers);
    const itemCount = randInt(1, 4);
    const items = [];
    let subtotal = 0;

    for (let j = 0; j < itemCount; j++) {
      const product = pick(products);
      const variant  = pick(product.variants);
      const qty      = randInt(1, 3);
      const price    = +product.basePrice.toFixed(2);
      subtotal += price * qty;
      items.push({
        product:     product._id,
        productName: product.name,
        category:    product.category,
        size:        variant.size,
        color:       variant.color,
        quantity:    qty,
        unitPrice:   price,
      });
    }

    subtotal = +subtotal.toFixed(2);
    const status = pick(STATUSES);
    const pointsEarned = status === 'cancelled' ? 0 : Math.floor(subtotal);

    const cid = customer._id.toString();
    customerSpend[cid] = (customerSpend[cid] || 0) + (status !== 'cancelled' ? pointsEarned : 0);

    orders.push({
      customer:            customer._id,
      items,
      subtotal,
      loyaltyPointsUsed:  0,
      loyaltyDiscount:    0,
      total:              subtotal,
      status,
      loyaltyPointsEarned: pointsEarned,
      createdAt: randDate(730),
    });
  }

  return { orders, customerSpend };
}

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  console.log('Clearing existing data...');
  await Promise.all([Customer.deleteMany({}), Product.deleteMany({}), Order.deleteMany({})]);

  console.log('Inserting 100 customers...');
  const customers = await Customer.insertMany(buildCustomers());

  console.log('Inserting ~500 products...');
  const products = await Product.insertMany(buildProducts());
  console.log(`  → ${products.length} products created`);

  console.log('Inserting 3000 orders...');
  const { orders, customerSpend } = buildOrders(customers, products, 3000);
  await Order.insertMany(orders);

  console.log('Updating loyalty points...');
  await Promise.all(
    customers.map(c => {
      const points = Math.floor((customerSpend[c._id.toString()] || 0) * 0.8);
      return Customer.findByIdAndUpdate(c._id, { loyaltyPoints: points });
    })
  );

  const counts = await Promise.all([Customer.countDocuments(), Product.countDocuments(), Order.countDocuments()]);
  console.log(`\n✅ Seed complete: ${counts[0]} customers, ${counts[1]} products, ${counts[2]} orders`);
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
