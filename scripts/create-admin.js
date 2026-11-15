// Prints the SQL to create the first owner account. The password never leaves your machine in plain text.
//   node scripts/create-admin.js you@example.com "Your Name"            (prompts for the password)
//   wrangler d1 execute bonashub --remote --command "<printed SQL>"
import { createInterface } from 'node:readline/promises';
import { hashPassword, uuid } from '../src/lib/crypto.js';
const [email, name] = process.argv.slice(2);
if (!email || !name) { console.error('Usage: node scripts/create-admin.js <email> "<full name>"'); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pw = await rl.question('Choose a password (10+ characters, letters and numbers): ');
rl.close();
if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) { console.error('Password too weak.'); process.exit(1); }
const now = new Date().toISOString(), q = (s) => `'${String(s).replace(/'/g, "''")}'`;
console.log(`INSERT INTO users (id, email, password_hash, role, staff_role, full_name, email_verified_at, created_at) VALUES (${q(uuid())}, ${q(email.toLowerCase())}, ${q(await hashPassword(pw))}, 'admin', 'owner', ${q(name)}, ${q(now)}, ${q(now)});`);
