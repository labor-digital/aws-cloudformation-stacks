# Open tasks

- [ ] **Create new dashboards**
  Paris has the template-provisioned `labc-eu-w3-cl-Overview` dashboard; Frankfurt gets `labc-eu-c1-Overview` with the cluster update. Evaluate what else deserves a dashboard (e.g. per-service deep-dive, DNS Firewall/egress monitoring views) and add to the template so all clusters get them.

- [ ] **Restart Frankfurt instances to pick up launch template updates** ✓ Done
  Existing instances rotated to latest AL2023 ECS AMI with `dnf-automatic` security updates.

- [ ] **`ecscluster-vpc-rds-asg` — RDS uses static master password, no `EnableIAMDatabaseAuthentication`**
  Currently every application authenticates with the same static `RdsMasterPassword` passed as a stack parameter. With IAM auth enabled, ECS tasks use a short-lived token generated from their IAM role instead — no static credentials stored anywhere. Access can be revoked per-service via IAM without changing a shared password. Requires code changes in each application to use token-based connection strings. Worth doing as part of the zero-trust posture but not a quick fix.

- [ ] **`ecsservice` — Roll out reworked autoscaling alarms to all deployed service stacks**
  Template work is done: Step Scaling at 65% up / 15% down, where the scale-down alarm is now a metric-math expression (`CPU < 15% AND HealthyHostCount > ServiceDesiredCount`) — it is OK in normal operation and red only while a scale-in is pending, so it doubles as the "extra tasks lingering" signal. Plus operational alarms HighCpu (20%), HighMemory (80%), opt-in LowCpu/LowMemory (0 = disabled). See README "Service-Autoscaling: Step Scaling mit zustandsbewusstem Scale-in-Alarm". Remaining: update every deployed service stack. **Note:** the pilot `ado-ael-adm-s` (Paris) currently runs the interim Target Tracking version and must be updated too (removes the permanently-red `TargetTracking-*-AlarmLow`). Scaling behavior stays 65%/15%; the change is alarm hygiene only.

- [ ] **Frankfurt — Resize high-memory services**
  From the 2026-07-09 metrics review: `labs-tin-fro-app-p` runs at **106% memory** (exceeds its soft limit, eats into the shared instance pool) and `gwa-gut-sol-p` at 77% (same app family as the Paris service that needed the same fix). Double `TaskMemory` for both, same as done for Paris (`lab-web-fro-s` 83.9%→11.5%, `gwa-gut-sol-s` 74.4%→36.8%). Watch list: `tro-cur-web-p` (71%), `labs-gru-web-sol-s` (71%).

- [ ] **`ecsservice` — Harden ImageResolver against failed-first-create retry loop**
  Report confirmed by code review: on a *fresh* create the resolver returns `InitialDockerImage` directly and cannot fail (`SkipImageResolver` is irrelevant there). The trap is the retry after a failed first create, when the resolver receives an **Update** event: (a) if the ECS service is gone (rolled back / deleted out-of-band), `describe_services` finds nothing and the Lambda hard-fails the whole stack update; (b) if the service exists but never became healthy, the resolver reads the *broken* image from the running task definition and resurrects it on every update — new `InitialDockerImage` values are ignored until `SkipImageResolver=true` forces them through. Fix for (a): in the Update branch, fall back to `InitialDockerImage` (with log line) instead of raising when the service is missing or has no task definition (~4 lines). (b) is not safely auto-detectable; `SkipImageResolver=true` stays the documented override for it.

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
- [ ] Create Quarantine Security Group (no egress rules whatsoever)
- [ ] Create Lambda function: on invocation, swap a target instance's security group to the Quarantine SG via AWS API
- [ ] Create EventBridge rule: GuardDuty finding with HIGH severity → trigger Lambda
- [ ] Test end-to-end using GuardDuty **Generate sample findings**
- [ ] Confirm the test instance was automatically moved to the Quarantine SG

---

### Phase 4 — LII26-92: Go Live (BLOCK Mode)

- [ ] Run `DnsFireWallLogsSummary` one final time — confirm no legitimate domains are still appearing as ALERT
- [ ] Edit DNS Firewall catch-all rule: change action from **ALERT → BLOCK** (response type: NXDOMAIN)
- [ ] Test all critical applications: Lieferchat, Matomo, email sending, time synchronisation
- [ ] Monitor CloudWatch for unexpected BLOCK events in the first 48h
- [ ] Store rollback command in the Jira ticket:
  ```
  aws route53resolver update-firewall-rule \
    --firewall-rule-group-id <id> \
    --firewall-domain-list-id <catch-all-id> \
    --action ALERT
  ```

---

### Related tickets

- **LII26-94:** Route 53 DNS Firewall im Audit-Modus (ALERT) aufsetzen
- **LII26-93:** Log-Analyse & Erstellung der FQDN-Whitelist
- **LII26-95:** Härtung der Security Groups & Aktives Port-Audit
- **LII26-92:** Go-Live & Scharfschaltung (Enforcement auf BLOCK)
