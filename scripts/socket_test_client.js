const io = require('socket.io-client');
const axios = require('axios');

const SERVER = process.env.SERVER || 'http://localhost:8080';

async function run() {
  const socket = io(SERVER, { transports: ['websocket'] });

  socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
  });

  socket.on('friend_request', (payload) => {
    console.log('Received friend_request payload:');
    console.dir(payload, { depth: null });
    socket.disconnect();
    process.exit(0);
  });

  socket.on('connect_error', (err) => {
    console.error('connect_error', err.message);
    process.exit(1);
  });

  // Wait a moment to ensure we are connected, then POST a friend request from test users
  await new Promise(r => setTimeout(r, 1000));

  try {
    const res = await axios.post(`${SERVER}/friends/add`, {
      userId: 'test-sender',
      friendId: 'test-recipient'
    }, { timeout: 5000 });
    console.log('HTTP POST /friends/add response status:', res.status);
  } catch (err) {
    console.error('HTTP POST failed:', err.message);
    process.exit(1);
  }
}

run();
