const mongoose = require('mongoose');

require('dotenv').config();

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing from .env');

  console.log('connecting with uri1', uri);
  await mongoose.connect(uri, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = mongoose.connection.db;
  const dbs = await db.admin().listDatabases();
  console.log('dbs', dbs.databases.map(d => d.name));
  console.log('current db1', db.databaseName);
  const coll1 = await db.listCollections().toArray();
  console.log('collections1', coll1.map(c => c.name));
  if (coll1.find(c => c.name === 'users')) {
    console.log('users count1', await db.collection('users').countDocuments());
  }

  await mongoose.disconnect();
}

run().then(() => process.exit(0)).catch(err => {console.error(err); process.exit(1);});