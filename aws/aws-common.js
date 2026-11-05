// aws-common.js — SDK 版共用的基礎（bootstrap.js / deploy.js / rds.js / secret.js 都 import 這檔）
//
// 與 aws-common.ps1 的差別：這裡不依賴 aws CLI，改用 AWS SDK for JavaScript v3。
// 憑據的來源（SDK 的預設解析順序）：
//   1) 環境變數 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY（可加 AWS_PROFILE 指定 profile）
//   2) C:\Users\g01943\.aws\credentials（ini）與 C:\Users\g01943\.aws\config
// 沒裝 CLI 也能手動建這兩個檔，格式：
//   [default]
//   aws_access_key_id = ...
//   aws_secret_access_key = ...
//   region = ap-southeast-2

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGION = 'ap-southeast-2';
export const PROJECT = 'lucaaws';

const here = dirname(fileURLToPath(import.meta.url));

// aws/ 在 LucaAWS\aws\，專案根是上一層
export const projectRoot = join(here, '..');
export const stateDir = join(projectRoot, '.aws-state');
export const stateFile = join(stateDir, 'config.json');

function ensureStateDir() {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

export function newState() {
  ensureStateDir();
  if (existsSync(stateFile)) return readState();
  return { region: REGION, project: PROJECT };
}

export function readState() {
  ensureStateDir();
  if (!existsSync(stateFile)) {
    throw new Error('.aws-state/config.json 不存在。先跑一次 aws/bootstrap.js（或 aws/rds.js）');
  }
  return readStateRaw();
}

function readStateRaw() {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

export function saveState(state) {
  ensureStateDir();
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(`寫入 ${stateFile}`);
}

// task definition 模板：JSON 本身的欄位就是 RegisterTaskDefinitionCommand 的輸入，
// 所以解析後直接補值即可，不需要像 CLI 那樣把每個欄位拆成參數。
export function buildTaskDefinition(state, imageUri) {
  const tpl = JSON.parse(readFileSync(join(here, 'task-definition.json'), 'utf8'));

  tpl.containerDefinitions[0].image = imageUri;
  tpl.executionRoleArn = state.executionRoleArn;
  tpl.taskRoleArn = state.taskRoleArn;

  // DATABASE_URL 的兩種給法：
  //   1) dbSecretArn（推薦）→ Secrets Manager，task definition 內只寫 ARN，不含密碼
  //   2) databaseUrl（不推薦）→ 明文寫在 environment；只在私人 repo / 短期測試用
  if (state.dbSecretArn) {
    tpl.containerDefinitions[0].secrets = [{
      name: 'DATABASE_URL',
      valueFrom: state.dbSecretArn,
    }];
  } else if (state.databaseUrl) {
    console.log('警告：DATABASE_URL 明文寫在 task definition。正式區建議改用 dbSecretArn（Secrets Manager）');
    tpl.containerDefinitions[0].environment.push({ name: 'DATABASE_URL', value: state.databaseUrl });
  } else {
    console.log('警告：state 裡沒有 dbSecretArn / databaseUrl，任務啟動時 DATABASE_URL 會缺失');
  }

  tpl.containerDefinitions[0].environment.push({ name: 'DB_SSLMODE', value: 'require' });
  return tpl;
}
