// rds.js — 建立 RDS PostgreSQL（正式區資料庫）與它的 security group（SDK 版）
//
// 做四件事：
//   1) 找 default VPC / subnets，必要時建 RDS DB subnet group
//   2) 建 SG：lucaaws-task（Fargate 任務）與 lucaaws-rds（只放行來自 task SG 的 5432）
//   3) 建 RDS instance（private，不公開存取）
//   4) 把 rdsEndpoint / SG id 寫進 .aws-state/config.json
//
// 執行（密碼走環境變數或 --password，不要寫死在檔內）：
//   $env:RDS_PASSWORD = '你的密碼'
//   node aws/rds.js
//   node aws/rds.js --instance-class=db.t4g.micro --storage=20

import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
} from '@aws-sdk/client-ec2';
import {
  RDSClient,
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
} from '@aws-sdk/client-rds';

import { REGION, PROJECT, newState, saveState } from './aws-common.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};

const dbName = opt('dbname', 'lucaaws');
const user = opt('user', 'luca');
const password = opt('password', process.env.RDS_PASSWORD);
const instanceClass = opt('instance-class', 'db.t4g.micro');
const storage = Number(opt('storage', 20));

if (!password) {
  throw new Error('請用 $env:RDS_PASSWORD 或 --password= 傳入密碼（這個值不會寫進倉庫）');
}

const ec2 = new EC2Client({ region: REGION });
const rds = new RDSClient({ region: REGION });
const state = newState();

console.log('=== 1) VPC / subnets / DB subnet group ===');
const vpc = ((await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }))).Vpcs || [])[0];
if (!vpc) throw new Error('此區域沒有 default VPC');

const subnets = (await ec2.send(new DescribeSubnetsCommand({
  Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }, { Name: 'state', Values: ['available'] }],
}))).Subnets.map((s) => s.SubnetId);
if (!subnets.length) throw new Error('VPC 內沒有可用 subnet');

state.region = REGION;
state.project = PROJECT;
state.vpcId = vpc.VpcId;
state.vpcCidr = vpc.CidrBlock;
state.subnets = subnets;

let snGroup = ((await rds.send(new DescribeDBSubnetGroupsCommand({}))).DBSubnetGroups || []).find((g) => g.DBSubnetGroupName === state.project);
if (!snGroup) snGroup = ((await rds.send(new DescribeDBSubnetGroupsCommand({}))).DBSubnetGroups || []).find((g) => g.VpcId === vpc.VpcId);
if (!snGroup) {
  snGroup = (await rds.send(new CreateDBSubnetGroupCommand({
    DBSubnetGroupName: state.project,
    DBSubnetGroupDescription: 'lucaaws RDS subnets',
    SubnetIds: subnets,
  })).DBSubnetGroup);
  console.log(`建立 DB subnet group: ${snGroup.DBSubnetGroupName}`);
} else {
  console.log(`DB subnet group: ${snGroup.DBSubnetGroupName}`);
}

console.log('=== 2) Security groups ===');
async function ensureSg(name, description) {
  const existing = (await ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }, { Name: 'group-name', Values: [name] }],
  })).SecurityGroups || [])[0];
  if (existing) return existing.GroupId;
  const created = await ec2.send(new CreateSecurityGroupCommand({ GroupName: name, Description: description, VpcId: vpc.VpcId }));
  console.log(`建立 SG: ${name}`);
  return created.GroupId;
}

const taskSg = await ensureSg(`${state.project}-task`, 'ECS Fargate task ENI');
const rdsSg = await ensureSg(`${state.project}-rds`, 'RDS PostgreSQL');

// task SG 要讓 ALB 打到 3000；RDS 只接受來自 task SG 的 5432
try {
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: taskSg, IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, SourceGroup: taskSg,
  }));
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: taskSg, IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, CidrIp: vpc.CidrBlock,
  }));
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: rdsSg, IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, SourceGroup: taskSg,
  }));
} catch (err) {
  if (err.name !== 'InvalidPermissionDuplicate') throw err;
  console.log('（SG 規則已存在，略過）');
}

state.taskSgId = taskSg;
state.rdsSgId = rdsSg;

console.log('=== 3) RDS instance ===');
let inst = ((await rds.send(new DescribeDBInstancesCommand({}))).DBInstances || []).find((d) => d.DBInstanceIdentifier === state.project);
if (inst) {
  console.log(`RDS 已存在: ${inst.DBInstanceIdentifier}`);
} else {
  const created = await rds.send(new CreateDBInstanceCommand({
    DBInstanceIdentifier: state.project,
    Engine: 'postgres',
    EngineVersion: '17',
    DBName: dbName,
    MasterUsername: user,
    MasterUserPassword: password,
    DBInstanceClass: instanceClass,
    AllocatedStorage: storage,
    StorageType: 'gp3',
    VpcSecurityGroupIds: [rdsSg],
    DBSubnetGroupName: snGroup.DBSubnetGroupName,
    PubliclyAccessible: false,
    MultiAZ: false,
    StorageEncrypted: true,
    BackupRetentionPeriod: 7,
  }));
  inst = created.DBInstance;
  console.log('RDS 建立中（約 5–10 分鐘）；用 node aws/status.js 或控制台看狀態');
}

if (inst.Endpoint) state.rdsEndpoint = inst.Endpoint.Address;
state.rdsDbName = inst.DBName || dbName;
state.rdsUser = inst.MasterUsername || user;

saveState(state);
console.log('');
console.log(`endpoint: ${state.rdsEndpoint || '（尚未 available，稍後再看）'}`);
console.log('下一步：node aws/secret.js');
