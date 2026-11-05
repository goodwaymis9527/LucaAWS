// secret.js — 把 DATABASE_URL 放進 Secrets Manager，並把 dbSecretArn 寫進 .aws-state/config.json（SDK 版）
//
// deploy.js 每次 register task definition 時讀 config.json 的 dbSecretArn，
// task definition 內只寫 ARN（不含密碼），ECS 啟動時把值注入成環境變數 DATABASE_URL。
//
// 三種給法（挑一種）：
//   1) 從檔讀（推薦，密碼不會留在 shell history；檔放倉庫外，例如 C:\secrets\）
//      node aws/secret.js --from-file=C:\secrets\lucaaws-db.txt
//   2) 直接傳字串
//      node aws/secret.js --url="postgresql://luca:pw@ep.ap-southeast-2.rds.amazonaws.com:5432/lucaaws?sslmode=require"
//   3) 交互輸入密碼，用 config.json 的 rdsEndpoint / rdsUser 組 URI
//      node aws/secret.js

import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { REGION, PROJECT, ACCOUNT, arn, newState, saveState, whoami } from './aws-common.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};

const secretName = opt('name', `${PROJECT}/database`);
const fromFile = opt('from-file');
let databaseUrl = opt('url');

const sm = new SecretsManagerClient({ region: REGION });
const state = newState();
state.account = await whoami();

if (!databaseUrl) {
  if (fromFile) {
    databaseUrl = readFileSync(fromFile, 'utf8').trim();
  } else if (state.rdsEndpoint) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const pw = await rl.question('RDS 密碼: ');
    rl.close();
    databaseUrl = `postgresql://${state.rdsUser}:${pw}@${state.rdsEndpoint}:5432/${state.rdsDbName}?sslmode=require`;
  } else {
    throw new Error('沒有 --url / --from-file，且 config.json 裡也沒有 rdsEndpoint。先跑 node aws/rds.js，或直接傳 --url=');
  }
}

if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
  throw new Error('DATABASE_URL 看起來不是 PostgreSQL 連線字串（應以 postgresql:// 開頭）');
}

const host = new URL(databaseUrl).hostname;
console.log(`將寫入 secret: ${secretName}`);
console.log(`期望的 ARN: ${arn('secretsmanager', 'secret:' + secretName, state.account)}`);
console.log(`connection string host: ${host}`);   // 只印 host，不印密碼

const existing = ((await sm.send(new ListSecretsCommand({}))).SecretsList || []).find((s) => s.Name === secretName);

let secretArn;
if (existing) {
  secretArn = existing.ARN;
  if (!secretArn.includes(`:${state.account || ACCOUNT}:`)) {
    console.log(`注意：既有 secret 屬於另一個帳號（${secretArn}）`);
  }
  await sm.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: databaseUrl }));
  console.log('更新既有 secret 的值');
} else {
  const created = await sm.send(new CreateSecretCommand({
    Name: secretName,
    Description: 'lucaaws DATABASE_URL',
    SecretString: databaseUrl,
  }));
  secretArn = created.ARN;
  console.log(`建立 secret: ${secretArn}`);
}

state.dbSecretArn = secretArn;
saveState(state);

console.log('');
console.log('完成。node aws/deploy.js 會把 DATABASE_URL 以 secrets 區塊（valueFrom=ARN）帶進 task definition。');
