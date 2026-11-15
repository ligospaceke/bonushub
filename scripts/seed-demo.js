// Fills the LOCAL dev database with clearly-fake demo sellers, products and one buyer. Never run against production.
//   npm run seed      (safe to run twice: it skips if the demo owner already exists)
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, migrate } from './d1-shim.js';
import { handleApi } from '../src/index.js';
import { hashPassword, uuid } from '../src/lib/crypto.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = createD1(process.env.DB_FILE || join(root, '.dev', 'bonashub.sqlite'));
migrate(DB);
const env = { DB, DEV_MODE: true };
const DEMO_PASSWORD = 'Demo-pass-12345';

if (await DB.prepare("SELECT 1 FROM users WHERE email = 'owner@bonashub.local'").first()) { console.log('Demo data already present.'); process.exit(0); }

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await handleApi(new Request('http://localhost' + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const j = await res.json();
    if (!j.ok) throw new Error(`${method} ${path}: ${j.error.message} ${JSON.stringify(j.error.fields || '')}`);
    return j.data;
  };
  return { post: (p, b = {}) => call('POST', p, b), get: (p) => call('GET', p) };
}

const now = new Date().toISOString();
await DB.prepare("INSERT INTO users (id, email, password_hash, role, staff_role, full_name, email_verified_at, created_at) VALUES (?,?,?,'admin','owner','Demo Owner',?,?)").bind(uuid(), 'owner@bonashub.local', await hashPassword(DEMO_PASSWORD), now, now).run();
const admin = client(); await admin.post('/api/auth/login', { email: 'owner@bonashub.local', password: DEMO_PASSWORD });

const sellers = [
  { email: 'rift@demo.local', name: 'Rift Equipment Ltd (demo)', town: 'Nairobi', cats: ['cat_construction_machinery', 'cat_industrial'], products: [
    { name: 'Tracked excavator, 21 tonne', cat: 'cat_construction_machinery', model: 'quote', origin: 'China' },
    { name: 'Concrete mixer, 350 L diesel', cat: 'cat_construction_machinery', price: 16800000, stock: 6, origin: 'India' },
    { name: 'Air compressor, 7.5 kW', cat: 'cat_industrial', price: 14200000, stock: 4, origin: 'Italy' } ] },
  { email: 'savanna@demo.local', name: 'Savanna Agro Supplies (demo)', town: 'Kajiado', cats: ['cat_agri_machinery', 'cat_agri_inputs'], products: [
    { name: 'Walk-behind power tiller', cat: 'cat_agri_machinery', price: 18500000, stock: 12, origin: 'China' },
    { name: 'NPK 17:17:17 fertiliser, 50 kg', cat: 'cat_agri_inputs', price: 460000, stock: 400, moq: 20, origin: 'Kenya' } ] },
  { email: 'build@demo.local', name: 'Kajiado Build Mart (demo)', town: 'Kimana', cats: ['cat_building_materials', 'cat_wholesale'], products: [
    { name: 'Portland cement 42.5N, 50 kg', cat: 'cat_building_materials', price: 78000, stock: 2000, moq: 100, origin: 'Kenya' },
    { name: 'Long grain rice, 25 kg', cat: 'cat_wholesale', price: 315000, stock: 300, moq: 40, origin: 'Pakistan' } ] },
];
for (const s of sellers) {
  const c = client();
  const r = await c.post('/api/auth/register', { role: 'seller', fullName: 'Demo Contact', email: s.email, phone: '0722000111', password: DEMO_PASSWORD, country: 'Kenya', county: 'Kajiado', town: s.town, businessName: s.name, regNo: 'DEMO-0001', location: s.town, description: 'Demo supplier. Not a real business.', categoryIds: s.cats, consent: true });
  await admin.post(`/api/admin/sellers/${r.user.id}/decision`, { action: 'approve' });
  for (const p of s.products) {
    const made = await c.post('/api/seller/products', { name: p.name, categoryId: p.cat, priceModel: p.model || 'fixed', unitPriceMinor: p.price, stockQty: p.stock ?? null, moq: p.moq || 1, unit: p.moq ? 'bag' : 'unit', originCountry: p.origin, deliveryOptions: 'both', specs: [{ label: 'Condition', value: 'New' }], description: 'Demo listing for design review.' });
    await admin.post(`/api/admin/products/${made.id}/decision`, { action: 'approve' });
  }
}
const buyer = client();
await buyer.post('/api/auth/register', { role: 'buyer', fullName: 'Demo Buyer', email: 'buyer@demo.local', phone: '0712345678', password: DEMO_PASSWORD, country: 'Kenya', county: 'Kajiado', town: 'Kimana', accountType: 'individual', consent: true });
console.log(`Demo data created.\n  Owner:  owner@bonashub.local\n  Seller: rift@demo.local | savanna@demo.local | build@demo.local\n  Buyer:  buyer@demo.local\n  Password for all: ${DEMO_PASSWORD}`);
