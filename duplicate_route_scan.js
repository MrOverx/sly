const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'ws_server.js');
const text = fs.readFileSync(file, 'utf8');
const regex = /app\.(get|post|put|delete|patch)\(([^)]*)\)/g;
const counts = new Map();
let m;
while ((m = regex.exec(text)) !== null) {
  const args = m[2].trim();
  let route = args.split(',')[0].trim();
  if (route.startsWith('[') && route.endsWith(']')) route = route.slice(1, -1).trim();
  if ((route.startsWith("'") && route.endsWith("'")) || (route.startsWith('"') && route.endsWith('"'))) {
    route = route.slice(1, -1);
  }
  const key = `${m[1]} ${route}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}
for (const [route, count] of counts) {
  if (count > 1) console.log(count, route);
}
