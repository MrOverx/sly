const { getUserByEmail, isDevStoreEnabled } = require('../utils/dynamoDBService');

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node debug_get_user.js email@example.com');
    process.exit(2);
  }
  try {
    console.log('Dev store enabled:', isDevStoreEnabled());
    const user = await getUserByEmail(email);
    console.log('Result for', email, JSON.stringify(user, null, 2));
  } catch (err) {
    console.error('Error:', err && err.message || err);
    process.exit(1);
  }
}

main();
