// netcheck.js - network data-plane diagnosis: SG rules, NACLs, route table associations, ALB ENI public mapping.
// Run: node aws/netcheck.js
//
// 每一項 separately try/catch：IAM 政策少哪個動作就只缺那一項，不會整個腳本掛掉。

import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  DescribeNetworkAclsCommand,
  DescribeSubnetsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
} from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { REGION, readState } from './aws-common.js';

const ec2 = new EC2Client({ region: REGION });
const alb = new ElasticLoadBalancingV2Client({ region: REGION });
const state = readState();
const byVpc = [{ Name: 'vpc-id', Values: [state.vpcId] }];

async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`${label} skipped : ${(err.__type || err.name)}（政策缺這個動作）`);
  }
}

await safe('ec2:DescribeSecurityGroups', async () => {
  const res = await ec2.send(new DescribeSecurityGroupsCommand({ Filters: byVpc }));
  for (const g of res.SecurityGroups || []) {
    // unmanaged 規則在 Permissions、authorize 寫進去的是 IpPermissions（受管）：
    // 只看 Permissions 會把「有規則的 SG」讀成空陣列
    console.log(`SG: ${g.GroupId} ${g.GroupName}`);
    console.log(`  managed   : ${JSON.stringify(g.IpPermissions)}`);
    console.log(`  unmanaged : ${JSON.stringify(g.Permissions)}`);
  }
});

await safe('ec2:DescribeNetworkAcls', async () => {
  const res = await ec2.send(new DescribeNetworkAclsCommand({ Filters: byVpc }));
  for (const a of res.NetworkAcls || []) {
    const entries = (a.NetworkAclEntries || []).map((e) => ({ dir: e.Direction, num: e.RuleNumber, proto: e.Protocol, cidr: e.CidrBlock, allow: e.Allow }));
    console.log(`NACL: ${a.NetworkAclId} default=${a.IsDefault} ${JSON.stringify(entries)}`);
    console.log(`  assoc: ${JSON.stringify((a.NetworkAclAssociations || []).map((x) => x.AssociationId))}`);
  }
});

await safe('ec2:DescribeSubnets', async () => {
  const res = await ec2.send(new DescribeSubnetsCommand({ Filters: byVpc }));
  for (const s of res.Subnets || []) {
    console.log(`subnet: ${s.SubnetId} ${s.AvailabilityZone} publicIpOnLaunch=${s.MapPublicIpOnLaunch}`);
  }
});

await safe('ec2:DescribeRouteTables', async () => {
  const res = await ec2.send(new DescribeRouteTablesCommand({ Filters: byVpc }));
  for (const t of res.RouteTables || []) {
    const routes = (t.Routes || []).map((r) => ({ d: r.DestinationCidrBlock, gw: r.GatewayId, state: r.State, assoc: r.AssociationState }));
    console.log(`RT: ${t.RouteTableId} default=${t.Default} routes=${JSON.stringify(routes)}`);
    console.log(`  assoc: ${JSON.stringify((t.Associations || []).map((a) => ({ id: a.AssociationId, subnet: a.SubnetId, gw: a.GatewayId, main: a.Main })))}`);
  }
});

await safe('elasticloadbalancing:DescribeLoadBalancers', async () => {
  // 有 state.albArn 就只查這一把；否則退回整清單（账号内多把 ALB 時不好對應）
  const res = await alb.send(new DescribeLoadBalancersCommand(
    state.albArn ? { LoadBalancerArns: [state.albArn] } : {}
  ));
  for (const b of res.LoadBalancers || []) {
    console.log(`ALB: ${b.LoadBalancerName} ${b.Scheme} ${b.DNSName} sg=${JSON.stringify(b.SecurityGroups)}`);
    const zones = (b.AvailabilityZones || []).map((z) => ({ zone: z.ZoneName, subnet: z.SubnetId, addresses: z.LoadBalancerAddresses }));
    console.log(`  zones: ${JSON.stringify(zones)}`);
  }
});

await safe('ec2:DescribeNetworkInterfaces', async () => {
  const res = await ec2.send(new DescribeNetworkInterfacesCommand({ Filters: byVpc }));
  for (const i of res.NetworkInterfaces || []) {
    const pub = (i.Association && i.Association.PublicIp) || 'none';
    console.log(`ENI: ${i.NetworkInterfaceId} ${i.PrivateIpAddress} public=${pub} sg=${(i.Groups || []).map((g) => g.GroupId).join(',')} ${i.Description}`);
  }
});
