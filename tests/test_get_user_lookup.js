const { getUserByEmail } = require('../utils/dynamoDBService');

async function run() {
  const cases = [
    { email: 'mroverxk@gmail.com', expect: true },
    { email: 'nonexistent@example.com', expect: false },
  ];
  for (const c of cases) {
    const u = await getUserByEmail(c.email);
    const ok = Boolean(u) === Boolean(c.expect);
    console.log(`${c.email} -> ${u ? u.userId : 'null'} : ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
      console.error('Case failed for', c.email);
      process.exitCode = 2;
    }
  }
}

run().catch(e => { console.error('Error', e); process.exit(1); });
