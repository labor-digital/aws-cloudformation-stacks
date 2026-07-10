# Open tasks

## Cluster deployment timeline

Paris and Frankfurt are on different rollout stages — this table tracks open/in-flight changes per cluster (rows completed in both regions get removed). Frankfurt work is planned in ~2 weeks (from 2026-07-10); dates TBD.

| Change | Paris (labc-eu-w3) | Frankfurt (labc-eu-c1) |
|---|---|---|
| 7-day DNS ALERT baseline (Phase 1 wait) | ⏱ running — complete ~2026-07-16 | ⏱ running — complete ~2026-07-17 |
| `guardduty` stack (detector, quarantine SG, incident-response role) + data source verification | ✅ 2026-07-09; FlowLogs/DNSLogs/CloudTrail verified ENABLED 2026-07-10 | ⏳ |
| GuardDuty findings review | ✅ 2026-07-10 — 2× `Policy:IAMUser/RootCredentialUsage` (account owner checking cluster, verified benign, archived) | ⏳ |
| DNS ALERT data-flow sanity check (run saved query `DnsFireWallLogsSummary` over last 24h — confirm logs are flowing before the baseline ends) | ⏳ optional, anytime | ⏳ |
| GuardDuty projected monthly cost from Usage page (budget reporting) | 🗓 ~2026-07-14/15 | |
| LII26-96 Phase 2 — whitelist analysis, update `DnsFirewallWhitelistDomains`, deploy, correlate findings | 🗓 from ~2026-07-16 | |
| `ecsservice` alarm rework v1.0.0 | ✅ 2026-07-10 — all 14 services (fleet query), scale-in proven end-to-end on `tro-tro-web-s` | ⏳ services currently on pre-rework template (commit `4ccba95`, permanently-red scale-down alarms still active) |
| Service RAM resizes (high-memory) | ✅ 2026-07-09 (`lab-web-fro-s`, `gwa-gut-sol-s`) | ⏳ `labs-tin-fro-app-p` (**106%** — consider pulling this one forward, 5-min change), `gwa-gut-sol-p` (77%) |


---

- [ ] **Create new dashboards**
  Both clusters now have the template-provisioned Overview dashboard (`labc-eu-w3-Overview`, `labc-eu-c1-Overview`). Evaluate what else deserves a dashboard (e.g. per-service deep-dive, DNS Firewall/egress monitoring views) and add to the template so all clusters get them.

- [ ] **`guardduty` — Findings e-mail notification (interim until Phase 3 automation)**
  Findings are currently only seen when someone opens the console. Add to the guardduty template: EventBridge rule on GuardDuty findings with severity ≥ 4 (MEDIUM+) → SNS topic → e-mail subscription. Both regions get it with their guardduty stack. Superseded later by Phase 3 Step D (EventBridge → Lambda quarantine for HIGH), but the notification stays useful for MEDIUM findings even then. Also consider: an IAM identity for the account owner — root-usage findings will recur on every root console visit and pollute the findings signal.

- [ ] **`ecscluster-vpc-rds-asg` — RDS uses static master password, no `EnableIAMDatabaseAuthentication`**
  Currently every application authenticates with the same static `RdsMasterPassword` passed as a stack parameter. With IAM auth enabled, ECS tasks use a short-lived token generated from their IAM role instead — no static credentials stored anywhere. Access can be revoked per-service via IAM without changing a shared password. Requires code changes in each application to use token-based connection strings. Worth doing as part of the zero-trust posture but not a quick fix.

- [ ] **`ecsservice` — Roll out reworked autoscaling alarms to all deployed service stacks**
  Template work is done: Step Scaling at 65% up / 15% down, where the scale-down alarm is now a metric-math expression (`CPU < 15% AND HealthyHostCount > ServiceDesiredCount`) — it is OK in normal operation and red only while a scale-in is pending, so it doubles as the "extra tasks lingering" signal. Plus operational alarms HighCpu (20%), HighMemory (80%), opt-in LowCpu/LowMemory (0 = disabled). See README "Service-Autoscaling: Step Scaling mit zustandsbewusstem Scale-in-Alarm". Remaining: **Frankfurt rollout** (Paris completed 2026-07-10 — all 14 services on template v1.0.0, scale-in validated end-to-end on `tro-tro-web-s`). Watch after each update: a scale-down alarm staying red >10 min means scalable-target drift (compare live min/max vs. stack params — see the `tro-tro-web-s` case, where a console-set MinCapacity=3 from June 26 blocked scale-in invisibly for two weeks) or stuck scale-in. Progress check per region: `aws cloudformation describe-stacks --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName, version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" --output table`.

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
- [ ] Update `DnsFirewallWhitelistDomains` stack parameter and deploy
- [ ] Check GuardDuty findings console — correlate any findings with DNS logs
- [ ] Document projected GuardDuty monthly cost from Usage page

---

### Phase 3 — LII26-95: Security Group Hardening

**Prerequisites:** Phase 1 and Phase 2 complete. GuardDuty active and verified.

**Step A — Port audit (collect baseline):**
- [ ] Set `EnableEgressAnalysis=true` in the cluster stack and deploy
- [ ] Let run 7–14 days, then run `VpcEgressPortsAnalysis` saved query in CloudWatch Logs Insights
- [ ] For every port found outside 443/587/123: decide whether to tunnel to 443, replace with a VPC Endpoint, or write an explicit exception rule

**Step B — NTP evaluation:**
- [ ] Confirm whether EC2 instances already use Amazon Time Sync Service (`169.254.169.123`)
  - If yes → no outbound port 123 rule needed, skip it
  - If no → add port 123/UDP egress rule, or migrate instances to Amazon Time Sync

**Step C — Apply egress rules (replace blanket allow-all):**
- [ ] Delete the blanket outbound rule (Egress: ALL to 0.0.0.0/0)
- [ ] Add Port 443/TCP → 0.0.0.0/0 — web/APIs (GuardDuty monitors for anomalous connections)
- [ ] Add Port 587/TCP → 0.0.0.0/0 — SMTP (restrict to specific relay IPs if known and static)
- [ ] Add Port 123/UDP → 0.0.0.0/0 — NTP (omit if Amazon Time Sync adopted in Step B)
- [ ] Add Port 53/UDP+TCP → VPC CIDR — internal DNS resolution
- [ ] Set `EnableEgressAnalysis=false` and deploy to remove the temporary ACCEPT flow log

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
