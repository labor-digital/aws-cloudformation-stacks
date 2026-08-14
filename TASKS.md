# Open tasks

## Cluster deployment timeline

Paris and Frankfurt are on different rollout stages — this table tracks open/in-flight changes per cluster (rows completed in both regions get removed). Frankfurt work is planned in ~2 weeks (from 2026-07-10); dates TBD.

| Change | Paris (labc-eu-w3) | Frankfurt (labc-eu-c1) |
|---|---|---|
| 7-day DNS ALERT baseline (Phase 1 wait) | ✅ complete ~2026-07-16 — ~4 weeks of data available as of 2026-08-07, analysis not yet run | ✅ complete ~2026-07-17 — same, analysis not yet run |
| `EnableEgressAnalysis=true` (Phase 3 Step A port baseline) | ✅ analysed 2026-08-07 over 28 days — full port list + destinations recorded in Phase 3 Step A. **Now switch off** (ran 29 days vs. the intended 14; ACCEPT flow logs bill per GB). | ⏳ not enabled — fix the saved query first, see Step A |
| `guardduty` stack (detector, quarantine SG, incident-response role) + data source verification | ✅ 2026-07-09; FlowLogs/DNSLogs/CloudTrail verified ENABLED 2026-07-10 | ⏳ |
| GuardDuty findings review | ✅ 2026-07-10 — 2× `Policy:IAMUser/RootCredentialUsage` (account owner checking cluster, verified benign, archived) | ⏳ |
| DNS ALERT data-flow sanity check (run saved query `DnsFireWallLogsSummary` over last 24h — confirm logs are flowing before the baseline ends) | ⏳ optional, anytime | ⏳ |
| GuardDuty projected monthly cost from Usage page (budget reporting) | 🗓 ~2026-07-14/15 | |
| LII26-96 Phase 2 — whitelist analysis, update `DnsFirewallWhitelistDomains`, deploy, correlate findings | ⚠️ overdue — unblocked since 2026-07-16, still open | ⏳ unblocked since 2026-07-17 |
| `ecsservice` alarm rework v1.0.0 | ✅ 2026-07-10 — all 14 services (fleet query), scale-in proven end-to-end on `tro-tro-web-s` | ⏳ services currently on pre-rework template (commit `4ccba95`, permanently-red scale-down alarms still active) |
| Service RAM resizes (high-memory) | ✅ 2026-07-09 (`lab-web-fro-s`, `gwa-gut-sol-s`) | ⏳ `labs-tin-fro-app-p` (**106%** — consider pulling this one forward, 5-min change), `gwa-gut-sol-p` (77%) |


---

- [ ] **Create new dashboards**
  Both clusters now have the template-provisioned Overview dashboard (`labc-eu-w3-Overview`, `labc-eu-c1-Overview`). Evaluate what else deserves a dashboard (e.g. per-service deep-dive, DNS Firewall/egress monitoring views) and add to the template so all clusters get them.

- [ ] **`guardduty` — Findings e-mail notification (interim until Phase 3 automation)**
  Findings are currently only seen when someone opens the console. Add to the guardduty template: EventBridge rule on GuardDuty findings with severity ≥ 4 (MEDIUM+) → SNS topic → e-mail subscription. Both regions get it with their guardduty stack. Superseded later by Phase 3 Step D (EventBridge → Lambda quarantine for HIGH), but the notification stays useful for MEDIUM findings even then. Also consider: an IAM identity for the account owner — root-usage findings will recur on every root console visit and pollute the findings signal.

- [ ] **`ecscluster-vpc-rds-asg` — Something bypasses the VPC resolver, so DNS Firewall never sees it**
  Found in the 2026-08-07 Paris egress analysis: 12 queries (NAT-deduplicated) to **`8.8.8.8`** over 28 days. Flow logs do not record queries to the Amazon-provided resolver, so anything appearing on port 53 at all is by definition going elsewhere. DNS Firewall only inspects traffic through the VPC resolver — these queries bypass the whitelist, the ALERT logging, and (after Phase 4) BLOCK enforcement entirely.

  **Almost certainly the OpenTelemetry agent.** The three sources querying `8.8.8.8` (`10.1.3.76`, `10.1.4.99`, `10.1.4.12`) are *exactly* the three sources exporting OTLP to `149.248.216.54:4318`, with matching relative magnitudes (6/4/2 DNS vs 8/3/3 OTLP). That is one container image deployed three times resolving its collector endpoint through a hardcoded resolver — so it is a single fix, not three. Check the agent container for a `dns` setting or a baked `resolv.conf`.

  **Must be fixed before Phase 3 Step C**, not after: the `53 → VPC CIDR only` rule will block these queries the moment it lands, and the agent then cannot resolve its collector. Fixing the agent first makes the rule a no-op for it; applying the rule first breaks telemetry.

- [ ] **`ecscluster-vpc-rds-asg` — RDS uses static master password, no `EnableIAMDatabaseAuthentication`**
  Currently every application authenticates with the same static `RdsMasterPassword` passed as a stack parameter. With IAM auth enabled, ECS tasks use a short-lived token generated from their IAM role instead — no static credentials stored anywhere. Access can be revoked per-service via IAM without changing a shared password. Requires code changes in each application to use token-based connection strings. Worth doing as part of the zero-trust posture but not a quick fix.

- [ ] **`ecsservice` — Roll out reworked autoscaling alarms to all deployed service stacks**
  Template work is done: Step Scaling at 65% up / 15% down, where the scale-down alarm is now a metric-math expression (`CPU < 15% AND HealthyHostCount > ServiceDesiredCount`) — it is OK in normal operation and red only while a scale-in is pending, so it doubles as the "extra tasks lingering" signal. Plus operational alarms HighCpu (20%), HighMemory (80%), opt-in LowCpu/LowMemory (0 = disabled). See README "Service-Autoscaling: Step Scaling mit zustandsbewusstem Scale-in-Alarm". Remaining: **Frankfurt rollout** (Paris completed 2026-07-10 — all 14 services on template v1.0.0, scale-in validated end-to-end on `tro-tro-web-s`). Watch after each update: a scale-down alarm staying red >10 min means scalable-target drift (compare live min/max vs. stack params — see the `tro-tro-web-s` case, where a console-set MinCapacity=3 from June 26 blocked scale-in invisibly for two weeks) or stuck scale-in. Progress check per region: `aws cloudformation describe-stacks --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName, version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" --output table`.

- [ ] **`ecsservice` — Verify the scale-in alarm's `HealthyHostCount` statistic across AZs**
  The metric-math scale-in alarm reads `HealthyHostCount` with `"Stat": "Average"` and without the `AvailabilityZone` dimension. The ALB publishes that metric per AZ, so averaging across AZs returns the per-AZ mean rather than the total — and `PlacementStrategies` spreads tasks across AZs. Two tasks split one-per-AZ could therefore read as `1`, making `tasks > ServiceDesiredCount` false so scale-in never fires. Paris validated scale-in end-to-end on `tro-tro-web-s`, so it does work there — plausibly because `binpack` kept the extra task in one AZ, leaving the other with no datapoint to average against. That makes the behaviour placement-dependent rather than broken. Verify on the first Frankfurt service running ≥2 tasks (`lab-web-fro-p`, min 2 / max 3): open the alarm and confirm the `tasks` metric shows the true task count. If it shows the per-AZ mean, switch the stat to `Sum`. The README's `HealthyHostCount` rationale explains the metric choice but not the statistic.

- [ ] **`ecscluster-vpc-rds-asg` — `BackupRole` cannot perform restores**
  `BackupRole` carries only `AWSBackupServiceRolePolicyForBackup`. A restore job additionally needs `AWSBackupServiceRolePolicyForRestores`, so choosing `BackupRole` under "Choose an IAM role" in the restore dialog fails on permissions. Current practice is the console's **Default role** (`AWSBackupDefaultServiceRole`) — created outside CloudFormation, account-wide, valid for all supported resource types. Decide whether to keep it that way (splitting backup and restore permissions is the better posture, and the role having no owning template is then intentional) or add a scoped restore role to the cluster template. Either way, record the decision — the restore procedure itself is in README "EFS-Restore".

- [ ] **Frankfurt — Resize high-memory services**
  From the 2026-07-09 metrics review: `labs-tin-fro-app-p` runs at **106% memory** (exceeds its soft limit, eats into the shared instance pool) and `gwa-gut-sol-p` at 77% (same app family as the Paris service that needed the same fix). Double `TaskMemory` for both, same as done for Paris (`lab-web-fro-s` 83.9%→11.5%, `gwa-gut-sol-s` 74.4%→36.8%). Watch list: `tro-cur-web-p` (71%), `labs-gru-web-sol-s` (71%).

- [ ] **`ecsservice` — Harden ImageResolver against failed-first-create retry loop**
  Report confirmed by code review: on a *fresh* create the resolver returns `InitialDockerImage` directly and cannot fail (`SkipImageResolver` is irrelevant there). The trap is the retry after a failed first create, when the resolver receives an **Update** event: (a) if the ECS service is gone (rolled back / deleted out-of-band), `describe_services` finds nothing and the Lambda hard-fails the whole stack update; (b) if the service exists but never became healthy, the resolver reads the *broken* image from the running task definition and resurrects it on every update — new `InitialDockerImage` values are ignored until `SkipImageResolver=true` forces them through. Fix for (a): in the Update branch, fall back to `InitialDockerImage` (with log line) instead of raising when the service is missing or has no task definition (~4 lines). (b) is not safely auto-detectable; `SkipImageResolver=true` stays the documented override for it. **Mitigation shipped 2026-07-10:** `SkipImageResolver` default changed to `true` — new services skip the resolver during creation/iteration entirely; operators set it to `false` once the service runs successfully. The Lambda hardening remains worthwhile for stacks already switched to `false`.

- [ ] **`ecsservice` — Add CloudWatch Anomaly Detection for network throughput**
  Future enhancement: add network throughput (NetworkIn/NetworkOut metrics) anomaly detection to each service. CloudWatch learns normal traffic patterns over 2 weeks, then alerts when traffic deviates >2σ from baseline — adapts per-service without hardcoded thresholds. Useful for detecting unusual traffic patterns or traffic spikes. Add parameters `EnableNetworkAnomalyDetection` and `NetworkAnomalyThreshold` to ecsservice template. Requires 2-week warmup before becoming effective.

---

## LII26-96: Zero-Trust Outgoing Network Security

Repeatable rollout checklist — execute per cluster in order: **Paris (labc-eu-w3) → Frankfurt (labc-eu-c1)**.

---

### Phase 1 — LII26-94: DNS Monitoring (ALERT Mode)

- [ ] Deploy DNS Firewall into the cluster stack:
  - Rule 1: ALLOW if domain is on whitelist
  - Rule 2: ALERT catch-all for everything else
  - Route 53 Resolver Query Logging → CloudWatch log group
  - CloudWatch metric filter + alarm on ALERT surge
- [ ] **Enable AWS GuardDuty** in the cluster's region
  - Verify **VPC Flow Logs** is an active data source
  - Verify **Route 53 DNS Logs** is an active data source
  - Document projected monthly cost from GuardDuty Usage page for budget reporting
- [ ] Run for minimum 7 days before proceeding to Phase 2

---

### Phase 2 — LII26-93: Log Analysis & Whitelist

- [ ] Run `DnsFireWallLogsSummary` saved query in CloudWatch Logs Insights
- [ ] Group ALERT'd domains by frequency — identify legitimate services, filter ad trackers and suspicious domains
- [ ] Build whitelist (aggregate by root domain, use wildcards carefully — `*.example.com` covers all subdomain depths in Route 53 DNS Firewall)
- [ ] **Whitelist the container registry domains — not just ECR.** Most services pull from `848331400135.dkr.ecr.<region>.amazonaws.com`, but two pull from Docker Hub: `lab-ana-mat-p` (`matomo:5.8`) and `gwa-gut-sol-p` (`solr:9.9`). A `BLOCK` catch-all breaks the **image pull at the next task placement**, not the running container — so the Phase 4 "test all critical applications" step would pass while the services are already unable to restart or scale. Needs `registry-1.docker.io`, `auth.docker.io` and the layer CDN; confirm the exact hostnames from the ALERT logs rather than assuming, and check the ECR/S3 endpoints the ECR pull path uses too. Full list of images per stack: `aws cloudformation describe-stacks --query "Stacks[?Parameters[?ParameterKey=='ServiceDesiredCount']].{stack:StackName,image:(Parameters[?ParameterKey=='InitialDockerImage'].ParameterValue)[0]}" --output table`.
- [ ] Update `DnsFirewallWhitelistDomains` stack parameter and deploy
- [ ] Check GuardDuty findings console — correlate any findings with DNS logs
- [ ] Document projected GuardDuty monthly cost from Usage page

---

### Phase 3 — LII26-95: Security Group Hardening

**Prerequisites:** Phase 1 and Phase 2 complete. GuardDuty active and verified.

**Step A — Port audit (collect baseline):**
- [x] Set `EnableEgressAnalysis=true` in the cluster stack and deploy — Paris: 2026-07-09, still running as of 2026-08-07 (29 days). Frankfurt: not yet enabled.
- [x] Run `VpcEgressPortsAnalysis` — **Paris analysed 2026-08-07 over 28 days.** Result below.
- [x] Resolve destinations per port (`dport`/`dstaddr`/`srcaddr` query) — done 2026-08-07, results in the table below.
- [ ] **Set `EnableEgressAnalysis=false` and deploy** — analysis is complete and recorded here; the ACCEPT flow log is now pure cost (29 days vs. the intended 14).
- [ ] Identify `3724/TCP → 145.239.131.113` (OVH) — the one remaining unknown destination. 9 connections / 1.56 KB in 28 days, originating from `10.1.3.7`.
- [x] Scan-noise assessment confirmed 2026-08-07 by bidirectional query — see below.

**⚠️ Two defects in the saved query — fix in the template before Frankfurt runs it.**

1. **It counts reply traffic.** `VpcEgressPortsAnalysis` filters `srcaddr like /^10\./ and dstaddr not like /^10\./`, which also matches the ALB/tasks *answering* inbound requests (`srcport=443`, `dstport=<client ephemeral>`). Every answered request contributes one more "port", so the result grows without bound instead of converging on the ports actually in use. In Paris it added 180,534 connections / 5.55 GB and **9,950 phantom ports out of a 10,000-row result** — and that result was still truncated, so the true count was higher. Adding `| filter srcport != 443 and srcport != 80` collapsed it to 138 ports, complete down to a single connection. If a run returns a suspiciously round number of rows, this is why.
2. **NAT gateway double-counting.** Every flow through the NAT gateway is recorded twice — once at the task ENI, once at the gateway ENI (`10.1.1.202` in Paris, `eni-0918a8815b4f80842`). Verified exactly: for `4318`, the three instance sources sum to the gateway row (8+3+3 = 14 connections, 166,726+54,221+53,080 = 274,027 B). **All raw figures are ~2× reality.** Add `| filter srcaddr != "<nat-private-ip>"` — the NAT IP differs per region, so parameterise it.

Also cast before any numeric range filter (`dstport * 1`): `parse` yields strings, so `dstport >= 5000` compares lexicographically and silently drops 4-digit ports.

**Step A result — Paris, 28 days, initiated egress only. Connection counts are NAT-deduplicated (raw ÷ 2).**

| Port | Conns (dedup) | Bytes | Destination | Source | Verdict |
|---|---|---|---|---|---|
| 443/TCP | ~978,000 | ~6.60 GB | 0.0.0.0/0 | all | allow |
| 123/UDP | ~50,300 | ~4.9 MB | Ubuntu NTP pool | `10.1.3.7` | see Step B |
| 80/TCP | ~216 | ~658 KB | — | all | likely OCSP/CRL — confirm destinations before dropping |
| 4318/TCP | 14 | 274 KB | `149.248.216.54` | `10.1.3.76`, `10.1.4.99`, `10.1.4.12` | OTLP/HTTP telemetry export |
| 22/TCP | 14 | 83.5 KB | `185.166.143.48/.49/.50` | `10.1.3.7` | legitimate SSH, round-robin trio |
| 4460/TCP | 5 | 5.5 KB | `91.189.91.111-113`, `185.125.190.122-123` (Canonical) | `10.1.3.7` | **NTS-KE** (RFC 8915) — see Step B |
| 3724/TCP | 9 | 1.56 KB | `145.239.131.113` (OVH) | `10.1.3.7` | **unidentified** |
| 587/TCP | 2 | 6.2 KB | `95.217.210.26` (Hetzner) | `10.1.3.45` | **SMTP — real. Do not remove.** |
| 53/UDP | 12 | 960 B | `8.8.8.8` | `10.1.3.76`, `10.1.4.99`, `10.1.4.12` | DNS Firewall bypass — separate task |
| ICMP | 3 | 264 B | — | — | ping |

**The 128 "dead ports" are replies to inbound scanning, not outbound activity — verified, not inferred.**

Each remote host maps to exactly one fixed port (`46141`↔`46.201.166.109` ×29, `19044`↔`213.231.52.175` ×18, `8096`↔`37.27.131.99` ×15, …) at 40 bytes per record. A bidirectional query on `46.201.166.109` proved the direction:

- `46.201.166.109:46141 → 10.1.1.202:2283` (ACCEPT, 29 flows) and the reply `10.1.1.202:2283 → 46.201.166.109:46141` (29 flows, 40 B/packet = RST, nothing listening). The remote uses its ephemeral port as *source* against our port 2283 — inbound-initiated.
- The same remote, from the same source port `37523`, hits `10.1.1.202` (ACCEPT — NAT gateways have no security group), `10.1.2.103` (REJECT) and `10.1.1.173` (REJECT). One remote host fanning out across our private address space while security groups reject it.

So what the egress query reported as "destination port 46141" was our RST landing on the scanner's fixed source port — `masscan`/`zmap` send from a fixed source port by design. Source IPs fit the profile (`147.185.221.22` is Censys). The failed SSH attempts to `23.106.55.199`, `91.124.63.12`, `54.36.246.226` are the same pattern with source port 22. **No egress rules needed, nothing inside the VPC originating it, no compromise indicated.** GuardDuty has flagged nothing since 2026-07-09.

Note: instance IPs *do* appear in these flows, but as REJECT recipients of inbound packets — not as originators. The REJECT records also confirm the permanent REJECT flow log and the temporary ACCEPT flow log share one log group, so `EnableEgressAnalysis=false` removes only the ACCEPT stream.

**Step B — NTP evaluation:**
- [x] **Resolved 2026-08-07: the logged port-123 traffic did NOT go to Amazon Time Sync.** Flow logs exclude traffic to `169.254.169.123` ([flow log limitations](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs-limitations.html)), so anything visible on port 123 went to an external server by definition. Which host that was is the next bullet — it is not the ECS fleet.
- [x] **The ECS hosts are already on Amazon Time Sync.** The launch template uses `{{resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id}}` and the UserData never touches chrony, so ASG instances run the AL2023 default (`169.254.169.123`), which flow logs do not record.
- [x] **The external NTP is not cluster traffic.** `10.1.3.7` = `i-06ffc732f73a20005` = **`lab-dev-llm-s-EC2`**, a `t3a.large` running **Ubuntu 26.04**, launched 2026-07-06 from its own CloudFormation stack `lab-dev-llm-s`, with its own security group (`lab-dev-llm-s-EC2SecurityGroup-FoLTBWyqVBSI`) and subnet. It returns empty from `aws ecs list-container-instances` — not an ASG member. NTS key establishment (`4460/TCP` to Canonical space, RFC 8915) plus NTP over `123/UDP` is stock Ubuntu behaviour.
- [x] **Four ports leave Step C entirely.** `123/UDP`, `4460/TCP`, `22/TCP` (→ `185.166.143.48-50`) and `3724/TCP` (→ OVH box `145.239.131.113`) all originate from `lab-dev-llm-s-EC2`, not from the cluster. No cluster egress rules needed for any of them.
- [ ] **`lab-dev-llm-s` needs its own egress policy** — separate stack, separate SG, outside this repo. The cluster's Step C rules do not reach it. Track there, not here.

**Step C — Apply egress rules (replace blanket allow-all):**

Target rule set, derived from the Step A results. Five rules, two of them `/32`-scoped, one scoped to the VPC CIDR (down from seven after `22`, `123`, `4460` and `3724` turned out to originate from `lab-dev-llm-s`, see Step B):

Scope confirmed 2026-08-07: the VPC runs 9 `labc-eu-w3` instances plus exactly one outsider, `lab-dev-llm-s-EC2` (`10.1.3.7`). All remaining egress sources (`10.1.3.45`, `10.1.3.76`, `10.1.4.12`, `10.1.4.99`) are cluster members, so the traffic below is genuinely containerised.

| Rule | Destination | Rationale |
|---|---|---|
| 443/TCP | `0.0.0.0/0` | web/APIs — 99% of egress; GuardDuty monitors for anomalous connections |
| 80/TCP | `0.0.0.0/0` | OCSP/CRL revocation checks — **dropping this breaks TLS validation** |
| 587/TCP | `95.217.210.26/32` | SMTP relay (Hetzner), from `10.1.3.45` |
| 4318/TCP | `149.248.216.54/32` | OTLP/HTTP telemetry export (Fly.io), from 3 of 9 hosts |
| 53/UDP+TCP | VPC CIDR **only** | internal DNS; scoping to the VPC CIDR is what closes the `8.8.8.8` bypass |

Dropped from this list — all `lab-dev-llm-s`, not cluster traffic: ~~`22/TCP`~~, ~~`123/UDP`~~, ~~`4460/TCP`~~, ~~`3724/TCP`~~.

**⚠️ All three instance security groups must be restricted, or this is a no-op.** The launch template attaches `SgVpcMysqlAccess`, `SgVpcLoadbalancerports` and `SgVpcEfsAccess`. **None of them define `SecurityGroupEgress`**, so each inherits CloudFormation's default allow-all. Security group rules are additive — if even one still allows all egress, restricting the other two changes nothing. Add the rule set to all three, or introduce a single dedicated egress SG and strip allow-all from the rest.

- [ ] Fix the OTel agent's resolver so `53` traffic goes to the VPC resolver, otherwise the `53 → VPC CIDR` rule breaks telemetry
- [ ] Confirm the `80/TCP` destinations really are OCSP/CRL before shipping a rule that allows plaintext egress to the internet
- [ ] Delete the blanket outbound rule (Egress: ALL to 0.0.0.0/0) and apply the table above
- [ ] Set `EnableEgressAnalysis=false` and deploy to remove the temporary ACCEPT flow log

**Ordering matters:** the `53 → VPC CIDR` rule will block the OTel agent's `8.8.8.8` queries the moment it lands. Fix the agent's DNS config *before* applying Step C, or telemetry export fails when the agent can no longer resolve `149.248.216.54`.

**Step D — Automated incident response:**
- [ ] ~~Create Quarantine Security Group~~ — already provided by the `guardduty` stack (export `<stack>-QuarantineSgId`), zero egress rules
- [ ] Create Lambda function: on invocation, swap a target instance's security group to the Quarantine SG via AWS API — execution role already provided by the `guardduty` stack (export `<stack>-IncidentResponseRoleArn`)
- [ ] Create EventBridge rule: GuardDuty finding with HIGH severity → trigger Lambda (detector ID available as export `<stack>-DetectorId`)
- [ ] Test end-to-end using GuardDuty **Generate sample findings**
- [ ] Confirm the test instance was automatically moved to the Quarantine SG

---

### Phase 4 — LII26-92: Go Live (BLOCK Mode)

**Template prerequisite (do first):** the catch-all rule's `ALERT` action is currently **hardcoded** in the cluster template. Changing it via CLI/console would be out-of-band drift — the next cluster stack update would silently revert BLOCK → ALERT and disarm enforcement. Add a parameter (e.g. `DnsFirewallCatchAllAction`, AllowedValues `ALERT`/`BLOCK`, default `ALERT`) to the cluster template before go-live.

- [ ] Add `DnsFirewallCatchAllAction` parameter to the cluster template (see above)
- [ ] Run `DnsFireWallLogsSummary` one final time — confirm no legitimate domains are still appearing as ALERT
- [ ] Go live via stack update: set `DnsFirewallCatchAllAction=BLOCK` (response type: NXDOMAIN)
- [ ] Test all critical applications: Lieferchat, Matomo, email sending, time synchronisation
- [ ] Monitor CloudWatch for unexpected BLOCK events in the first 48h
- [ ] Rollback = stack update with `DnsFirewallCatchAllAction=ALERT` (no out-of-band CLI needed; document in the Jira ticket)

---

### Related tickets

- **LII26-94:** Route 53 DNS Firewall im Audit-Modus (ALERT) aufsetzen
- **LII26-93:** Log-Analyse & Erstellung der FQDN-Whitelist
- **LII26-95:** Härtung der Security Groups & Aktives Port-Audit
- **LII26-92:** Go-Live & Scharfschaltung (Enforcement auf BLOCK)
