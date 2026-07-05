#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const Logger = require('../../utils/logger').Logger;

const TABLE_NAME = process.env.DYNAMODB_TABLE || 'oververseDB';
const DEV_STORE_PATH = path.resolve(__dirname, '..', '..', 'dev_dynamo_users.json');

async function cleanDevStore() {
  if (!fs.existsSync(DEV_STORE_PATH)) return;
  const raw = fs.readFileSync(DEV_STORE_PATH, 'utf8');
  const items = JSON.parse(raw || '[]');
  let changed = 0;
  for (const it of items) {
    if (it && it.itemType === 'FRIEND') {
      if (it.sender) { delete it.sender; changed++; }
      if (it.recipient) { delete it.recipient; changed++; }
    }
  }
  if (changed > 0) {
    fs.writeFileSync(DEV_STORE_PATH, JSON.stringify(items, null, 2), 'utf8');
    console.log(`Dev store cleaned: removed ${changed} embedded snapshot fields from FRIEND items`);
  } else {
    console.log('Dev store: no embedded snapshots found');
  }
}

async function cleanDynamoDb() {
  const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  const ddb = DynamoDBDocumentClient.from(client);
  let ExclusiveStartKey = null;
  let totalUpdated = 0;
  do {
    const params = { TableName: TABLE_NAME, Limit: 1000 };
    if (ExclusiveStartKey) params.ExclusiveStartKey = ExclusiveStartKey;
    const page = await ddb.send(new ScanCommand(params));
    const items = page.Items || [];
    for (const it of items) {
      try {
        if ((it.itemType && it.itemType === 'FRIEND') || (it.PK && String(it.PK).startsWith('FRIEND#'))) {
          // Build key
          const key = { PK: it.PK };
          if (it.SK) key.SK = it.SK;
          const removeAttrs = [];
          if (it.sender) removeAttrs.push('#sender');
          if (it.recipient) removeAttrs.push('#recipient');
          if (removeAttrs.length === 0) continue;
          const exprNames = {};
          if (it.sender) exprNames['#sender'] = 'sender';
          if (it.recipient) exprNames['#recipient'] = 'recipient';
          const updateExp = `REMOVE ${removeAttrs.join(', ')}`;
          await ddb.send(new UpdateCommand({ TableName: TABLE_NAME, Key: key, UpdateExpression: updateExp, ExpressionAttributeNames: exprNames }));
          totalUpdated++;
        }
      } catch (e) {
        console.warn('Failed to update item', e && e.message);
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey || null;
  } while (ExclusiveStartKey);

  console.log(`DynamoDB cleaned: removed embedded snapshots from ${totalUpdated} items (if any)`);
}

(async () => {
  try {
    console.log('Starting clean_friend_snapshots migration');
    await cleanDevStore();
    // Only attempt DynamoDB cleanup if AWS credentials appear to be present
    if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
      await cleanDynamoDb();
    } else {
      console.log('No AWS credentials detected; skipping DynamoDB cleanup');
    }
    console.log('Migration complete');
  } catch (err) {
    console.error('Migration failed', err && err.message);
    process.exit(1);
  }
})();
