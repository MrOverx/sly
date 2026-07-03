const fs = require('fs');
const path = require('path');

const DEV_PATH = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

function normalizeEmail(e) {
  if (!e || typeof e !== 'string') return null;
  return e.trim().toLowerCase();
}

function load() {
  if (!fs.existsSync(DEV_PATH)) return [];
  const raw = fs.readFileSync(DEV_PATH, 'utf8');
  try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
}

function save(items) {
  fs.writeFileSync(DEV_PATH, JSON.stringify(items, null, 2), 'utf8');
}

function migrate() {
  const items = load();
  let updated = 0;
  let totalUsers = 0;
  for (const it of items) {
    if (it && it.itemType === 'USER') {
      totalUsers++;
      const email = it.email || null;
      const eLower = normalizeEmail(email);
      if (eLower && (!it.emailLower || String(it.emailLower).trim() === '')) {
        it.emailLower = eLower;
        updated++;
      }
    }
  }
  save(items);
  console.log(`Migration complete. users=${totalUsers}, updated=${updated}`);
}

migrate();
