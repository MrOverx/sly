const fs = require('fs');
const path = require('path');

const base = process.env.BASE_URL || 'http://localhost:8080';
const devPath = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

async function postJson(route, body) {
  const url = `${base}${route}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { throw new Error(`Invalid JSON response from ${url}: ${text}`); }
}

(async function run() {
  try {
    console.log('Using base:', base);

    console.log('Registering sender...');
    const sender = await postJson('/auth/register', { userId: 'test_sender', userName: 'Test Sender', email: 'sender@example.com', password: 'password' });
    console.log('Sender registered:', sender && sender.user ? sender.user.userId : JSON.stringify(sender));

    console.log('Registering recipient...');
    const recipient = await postJson('/auth/register', { userId: 'test_recipient', userName: 'Test Recipient', email: 'recipient@example.com', password: 'password' });
    console.log('Recipient registered:', recipient && recipient.user ? recipient.user.userId : JSON.stringify(recipient));

    console.log('Sending friend request (sender -> recipient)...');
    const add = await postJson('/friends/add', { userId: 'test_sender', friendId: 'test_recipient' });
    console.log('Friend request response:', add);
    const requestId = add && add.requestId;
    if (!requestId) throw new Error('No requestId returned from friends/add');

    console.log('Accepting friend request as recipient...');
    const accept = await postJson(`/friends/request/${requestId}/accept`, { userId: 'test_recipient' });
    console.log('Accept response:', accept);

    console.log('Dev store snapshot (dev_dynamo_users.json):');
    if (fs.existsSync(devPath)) {
      console.log(fs.readFileSync(devPath, 'utf8'));
    } else {
      console.log('Dev store not found at', devPath);
    }

    console.log('Smoke test completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Smoke test failed:', err && err.message || err);
    process.exit(2);
  }
})();
