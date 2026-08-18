# Open tasks

Background, rationale and operational procedures live in [README.md](README.md) (per-template Best Practices) and [CHANGELOG.md](CHANGELOG.md). This file is the to-do list only.

## Cluster deployment timeline

Open/in-flight changes per cluster. Rows completed in both regions get removed.

| Change | Paris (labc-eu-w3) | Frankfurt (labc-eu-c1) |
|---|---|---|
| `EnableEgressAnalysis` | ⏳ **switch off** — ran 29 days vs. intended 14, analysis complete | ⏳ enabled 2026-08-14 — run the analysis, then **switch off by 2026-08-28** |
| LII26-96 Phase 2 — whitelist analysis + deploy | ⚠️ overdue — unblocked since 2026-07-16 | ⏳ unblocked since 2026-07-17 |
| `ecsservice` rollout to `1.0.1` | ✅ 14 services on `1.0.0` — need re-update for `1.0.1` | ⏳ 20 of 21 still on pre-rework template; `ado-lea-tut-p` on `1.0.0`, needs `1.0.1` |
| Service RAM resizes | ✅ 2026-07-09 | ⏳ `gwa-gut-sol-p` (77%). `labs-tin-fro-app-p` (106%) is on `labcluster-eu-c1-cl`, tracked separately |
| GuardDuty projected monthly cost from Usage page | 🗓 open | 🗓 open |
| DNS ALERT data-flow sanity check (`DnsFireWallLogsSummary`, last 24h) | ⏳ optional | ⏳ optional |

---

## Templates

- [ ] **`ecsservice` — finish the `1.0.1` rollout.** 20 of 21 Frankfurt services still on the pre-rework template; `ado-lea-tut-p` is on `1.0.0` and needs a second update for the anomaly detector. Paris is on `1.0.0` throughout. Suggested order: `ado-lea-tut-p` → `lab-web-fro-p` (first with ≥2 tasks) → the 1/1 and 1/2 services → `dwk-zer-app-p` (baseline 0, a working scale-in ends at zero tasks) → the five at baseline 3 last. Pass `SkipImageResolver=false` explicitly. Before each update compare live `MinCapacity` against the stack parameter (`aws application-autoscaling describe-scalable-targets --service-namespace ecs`) — verified clean for all 21 on 2026-08-14.

- [ ] **`ecsservice` — add the notification path, then continue the rollout.** Eight alarms have no `AlarmActions`: `DnsFirewallAlertAlarm`, `VpcFlowLogsRejectedAlarm`, `RdsErrorAlarm`, `RdsSlowQueryAlarm` (cluster) and `ServiceHighCpuAlarm`, `ServiceHighMemoryAlarm`, `ServiceLowCpuAlarm`, `ServiceLowMemoryAlarm` (service). No SNS topic exists in either template, so nothing notifies anyone — including the new log anomaly detector.
  - Cluster: `AlertTopic` + optional `AlertEmail` parameter (empty = no subscription, `LogsBucketName` convention), exported as `${AWS::StackName}-AlertTopicArn`; wire the four cluster alarms.
  - Service: import that ARN, wire the High/Low alarms plus a new anomaly alarm — metric `AnomalyCount`, dimensions `LogAnomalyDetector` (detector name) and `LogAnomalyPriority` = `HIGH`, `Sum`/`300`/`1`/`> 0`/`notBreaching`. **Namespace unverified** — check `aws cloudwatch list-metrics --metric-name AnomalyCount` before hardcoding `AWS/Logs`.
  - Do **not** wire SNS to `AlarmAutoscaleScaleDown` — it is red during every normal scale-in by design.
  - `email` subscriptions need a manual confirmation click; CloudFormation reports `CREATE_COMPLETE` while still `PendingConfirmation`. Verify with `aws sns list-subscriptions-by-topic`.
  - Point the GuardDuty findings rule below at this same topic. Do this **before** continuing the rollout, or 21 stacks get updated twice.

- [ ] **`guardduty` — findings e-mail notification.** EventBridge rule on findings with severity ≥ 4 (MEDIUM+) → the shared `AlertTopic`. Superseded later by Phase 3 Step D but stays useful for MEDIUM. Also: give the account owner an IAM identity, or `Policy:IAMUser/RootCredentialUsage` recurs on every root console visit.

- [ ] **`ecsservice` — harden ImageResolver against the failed-first-create retry loop.** On an Update event after a failed create: (a) if the ECS service is gone, `describe_services` finds nothing and the Lambda hard-fails the stack update; (b) if the service exists but never became healthy, the broken image is read from the running task definition and resurrected on every update. Fix (a) with a ~4-line fallback to `InitialDockerImage` in the Update branch. (b) is not safely auto-detectable — `SkipImageResolver=true` stays the documented override. Mitigated 2026-07-10 by defaulting `SkipImageResolver` to `true`; still worthwhile for stacks already switched to `false`.

- [ ] **Add `TemplateVersion` output to the remaining templates.** Only `ecsservice` (`1.0.1`) and `ecscluster-vpc-rds-asg` (`1.0.0`) have it. Without it, "which template is this stack on?" costs a `LastUpdatedTime` comparison plus git archaeology instead of one query. Order: `guardduty` and `alb-logs-bucket` (per region), then `backup-vaults-mirror`, then the leaf templates. Note each template needs its own filter for a fleet query — the `ecsservice` one keys on the `TargetGroupArn` output.

- [ ] **`ecscluster-vpc-rds-asg` — add a Gateway VPC Endpoint for S3.** No VPC endpoints exist, so all S3 traffic exits via NAT.
  ```json
  { "Type": "AWS::EC2::VPCEndpoint", "Properties": {
      "VpcId": { "Ref": "Vpc" },
      "ServiceName": { "Fn::Sub": "com.amazonaws.${AWS::Region}.s3" },
      "VpcEndpointType": "Gateway",
      "RouteTableIds": [ { "Ref": "RoutetablePrivate" } ] } }
  ```
  The direct cost saving is a few euros a year at our volumes — the real reasons are that it lets Step C match the S3 **managed prefix list** instead of allowing `443 → 0.0.0.0/0` for ECR layer pulls, and that EFS-restore uploads stop paying NAT. Gateway endpoints cover S3/DynamoDB in-region only. ECR/SSM **interface** endpoints are deliberately out of scope: they bill per hour per AZ plus per GB, which exceeds the NAT traffic they would replace.

- [ ] **`ecscluster-vpc-rds-asg` — RDS uses a static master password, no `EnableIAMDatabaseAuthentication`.** Every application authenticates with the same `RdsMasterPassword` stack parameter. IAM auth would give each ECS task a short-lived token from its role, revocable per service without rotating a shared secret. Requires connection-string changes in every application — not a quick fix.

- [ ] **`ecscluster-vpc-rds-asg` — `BackupRole` cannot perform restores.** It carries only `AWSBackupServiceRolePolicyForBackup`; a restore also needs `...ForRestores`. Current practice is the console's `AWSBackupDefaultServiceRole` (account-wide, created outside CloudFormation). Decide: keep the split (better posture, and the unowned role is then intentional) or add a scoped restore role. Record the decision either way.

- [ ] **Create new dashboards.** Both clusters have the template-provisioned Overview dashboard. Evaluate what else earns one (per-service deep-dive, DNS Firewall/egress views) and add it to the template so every cluster gets it.

- [ ] **`ecsservice` — CloudWatch anomaly detection for network throughput.** Add `NetworkIn`/`NetworkOut` anomaly detection with `EnableNetworkAnomalyDetection` and `NetworkAnomalyThreshold` parameters. CloudWatch learns the baseline over ~2 weeks, then alerts on >2σ deviation — adapts per service without hardcoded thresholds. Needs the warmup before it is useful.

- [ ] **Detecting compromise of an ephemeral container.** GuardDuty Malware Protection for EC2 does not close this gap: it scans EBS only (so the EFS mount at `VolumeMountPath` is never scanned), a scan only starts after GuardDuty already raised a finding — and a file written inside a container is invisible to flow logs, DNS logs and CloudTrail — and the container writable layer is discarded on the next deploy, taking the evidence with it. Container contents *are* in scope where they sit on EBS, attributed as `Execution:ECS/MaliciousFile`. Durable evidence today: ALB access logs (verified enabled in Frankfurt 2026-08-16), DNS firewall logs, flow logs, container logs. Missing: anything recording *execution*.
  - Evaluate **GuardDuty Runtime Monitoring** (`RUNTIME_MONITORING`, currently `DISABLED`, sub-options `EC2_AGENT_MANAGEMENT` / `ECS_FARGATE_AGENT_MANAGEMENT`) — agent-based, emits a finding at execution time that outlives the container and covers EFS paths. Check ECS-on-EC2 support, agent footprint on `t3.small`, cost.
  - Enable `EBS_MALWARE_PROTECTION` anyway via the guardduty template (not the console) — 30-day free trial, small per-GB cost on 30 GB root volumes, and it incidentally checks ECR image contents. Do not record it as covering application data.
  - Per service, determine which paths are image vs EFS. For the `-typ` TYPO3 and Matomo services it matters whether extension directories sit inside the image (scanned, not persistent) or on the EFS mount (persistent, unscanned). Check `sudo ls -la /mnt/efs/<service-stack-name>/`.
  - Everything has 14-day retention, so no investigation reaches back further than two weeks. Deliberate DSGVO tradeoff, but it means alerting inside the window matters more than analysis run eventually.

---

## LII26-96: Zero-Trust Outgoing Network Security

Execute per cluster in order: **Paris (labc-eu-w3) → Frankfurt (labc-eu-c1)**.

**Phase 1 — LII26-94: DNS monitoring (ALERT mode)** — ✅ complete in both regions. DNS Firewall, Route 53 query logging, metric filter and alarm deployed; GuardDuty active with FlowLogs/DNSLogs/CloudTrail verified; 7-day baselines finished 2026-07-16 (Paris) and 2026-07-17 (Frankfurt).

### Phase 2 — LII26-93: Log analysis & whitelist

- [ ] Run `DnsFireWallLogsSummary`, group ALERT'd domains by frequency, separate legitimate services from trackers and noise
- [ ] Build the whitelist, aggregating by root domain. Wildcards match a single subdomain level only — `*.example.com` covers `foo.example.com` but not `foo.bar.example.com`
- [ ] **Include the container registry domains, not just ECR.** `lab-ana-mat-p` (`matomo:5.8`) and `gwa-gut-sol-p` (`solr:9.9`) pull from Docker Hub. A `BLOCK` catch-all breaks the **image pull at the next task placement**, not the running container — so the Phase 4 application test would pass while those services silently cannot restart or scale. Needs `registry-1.docker.io`, `auth.docker.io` and the layer CDN; confirm exact hostnames from the ALERT logs.
- [ ] Update `DnsFirewallWhitelistDomains` and deploy
- [ ] Correlate GuardDuty findings with the DNS logs
- [ ] Record projected GuardDuty monthly cost from the Usage page

### Phase 3 — LII26-95: Security group hardening

**Prerequisites:** Phase 1 and 2 complete, GuardDuty verified.

**Step A — port audit.** ✅ Paris analysed 2026-08-07 over 28 days. The saved query's two defects (counting inbound replies, and NAT double-counting) were fixed in the template on 2026-08-14 by narrowing the source filter to the private subnets (`/^10\.1\.[34]\./`) plus a `srcport != 443/80` backstop, with `limit` raised to 500 — **not yet deployed to Paris**. The 128 apparent "dead ports" were verified as our RSTs landing on inbound scanners' fixed source ports (masscan/zmap profile, Censys among the sources) — inbound-initiated, no egress rules needed, no compromise indicated.

Result (connection counts NAT-deduplicated, raw ÷ 2):

| Port | Conns | Bytes | Destination | Source | Verdict |
|---|---|---|---|---|---|
| 443/TCP | ~978,000 | ~6.60 GB | `0.0.0.0/0` | all | allow |
| 123/UDP | ~50,300 | ~4.9 MB | Ubuntu NTP pool | `10.1.3.7` | not cluster traffic |
| 80/TCP | ~216 | ~658 KB | — | all | likely OCSP/CRL — confirm before dropping |
| 4318/TCP | 14 | 274 KB | `149.248.216.54` | `10.1.3.76`, `10.1.4.99`, `10.1.4.12` | OTLP telemetry export |
| 22/TCP | 14 | 83.5 KB | `185.166.143.48-50` | `10.1.3.7` | not cluster traffic |
| 4460/TCP | 5 | 5.5 KB | Canonical NTS-KE | `10.1.3.7` | not cluster traffic |
| 3724/TCP | 9 | 1.56 KB | `145.239.131.113` (OVH) | `10.1.3.7` | **unidentified** |
| 587/TCP | 2 | 6.2 KB | `95.217.210.26` (Hetzner) | `10.1.3.45` | **SMTP — real, do not remove** |
| 53/UDP | 12 | 960 B | `8.8.8.8` | `10.1.3.76`, `10.1.4.99`, `10.1.4.12` | DNS Firewall bypass — see below |
| ICMP | 3 | 264 B | — | — | ping |

- [ ] Run the analysis in Frankfurt, then set `EnableEgressAnalysis=false` in **both** regions
- [ ] Identify `3724/TCP → 145.239.131.113` — the one remaining unknown, from `10.1.3.7`

**Step B — NTP.** ✅ Resolved 2026-08-07. The ECS hosts already use Amazon Time Sync (`169.254.169.123`, which flow logs do not record). All external NTP, NTS-KE, SSH and the OVH traffic originate from `10.1.3.7` = `lab-dev-llm-s-EC2`, a `t3a.large` Ubuntu box from its own stack, not an ASG member — so `123/UDP`, `4460/TCP`, `22/TCP` and `3724/TCP` leave Step C entirely.

- [ ] `lab-dev-llm-s` needs its own egress policy — separate stack, separate SG, outside this repo. Track it there.

**Step C — apply egress rules.** Target set, five rules:

| Rule | Destination | Rationale |
|---|---|---|
| 443/TCP | `0.0.0.0/0` | web/APIs, ~99% of egress; GuardDuty watches for anomalies |
| 80/TCP | `0.0.0.0/0` | OCSP/CRL — **dropping this breaks TLS validation** |
| 587/TCP | `95.217.210.26/32` | SMTP relay, from `10.1.3.45` |
| 4318/TCP | `149.248.216.54/32` | OTLP telemetry, from 3 of 9 hosts |
| 53/UDP+TCP | VPC CIDR **only** | internal DNS; this is what closes the `8.8.8.8` bypass |

**⚠️ All three instance security groups must be restricted or this is a no-op.** The launch template attaches `SgVpcMysqlAccess`, `SgVpcLoadbalancerports` and `SgVpcEfsAccess`, and **none defines `SecurityGroupEgress`** — so each inherits allow-all. SG rules are additive: if one still allows everything, restricting the other two changes nothing. Either add the set to all three, or introduce one dedicated egress SG and strip allow-all from the rest.

- [ ] Fix the OTel agent's hardcoded resolver **first** — the `53 → VPC CIDR` rule blocks its `8.8.8.8` queries the moment it lands, and it then cannot resolve its collector. Three sources (`10.1.3.76`, `10.1.4.99`, `10.1.4.12`) are the same image deployed three times, so it is one fix. Until then those queries bypass the whitelist, the ALERT logging and later BLOCK enforcement entirely.
- [ ] Confirm the `80/TCP` destinations really are OCSP/CRL before allowing plaintext egress to the internet
- [ ] Delete the blanket `Egress: ALL → 0.0.0.0/0` rule and apply the table above

**Step D — automated incident response.** The `guardduty` stack already provides the Quarantine SG (`<stack>-QuarantineSgId`, zero egress), the execution role (`-IncidentResponseRoleArn`) and the detector ID (`-DetectorId`).

- [ ] Lambda: swap a target instance's security group to the Quarantine SG
- [ ] EventBridge rule: GuardDuty finding with HIGH severity → the Lambda
- [ ] Test end-to-end with sample findings and confirm the instance moved to the Quarantine SG

### Phase 4 — LII26-92: Go live (BLOCK mode)

- [ ] **First:** add a `DnsFirewallCatchAllAction` parameter (`ALERT`/`BLOCK`, default `ALERT`) to the cluster template. The action is currently hardcoded, so flipping it by CLI would be drift that the next stack update silently reverts — disarming enforcement.
- [ ] Run `DnsFireWallLogsSummary` once more; confirm no legitimate domain still appears as ALERT
- [ ] Set `DnsFirewallCatchAllAction=BLOCK` (response NXDOMAIN) via stack update
- [ ] Test critical applications: Lieferchat, Matomo, email, time sync — and image pulls
- [ ] Monitor for unexpected BLOCK events for 48h. Rollback = same parameter back to `ALERT`

---

### Related tickets

- **LII26-94:** Route 53 DNS Firewall im Audit-Modus (ALERT) aufsetzen
- **LII26-93:** Log-Analyse & Erstellung der FQDN-Whitelist
- **LII26-95:** Härtung der Security Groups & Aktives Port-Audit
- **LII26-92:** Go-Live & Scharfschaltung (Enforcement auf BLOCK)
