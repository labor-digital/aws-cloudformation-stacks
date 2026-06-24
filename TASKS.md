# Open tasks

- [ ] **`ecscluster-vpc-rds-asg/alb-logs-bucket` — S3 lifecycle rule missing `NoncurrentVersionExpiration`**
  Versioning is enabled, but the `DeleteLogs` lifecycle rule only expires current-version objects. Non-current versions accumulate indefinitely, silently defeating the DSGVO retention ceiling and causing unbounded storage growth. Fix: add a `NoncurrentVersionExpiration` rule matching `RetentionDays`, or disable versioning (ALB log objects are never overwritten, so versioning provides no benefit).
  **Reminder (2026-06-19):** Bucket is exactly 14 days old — first lifecycle expiration runs imminently. Toggle "Show versions" in S3 console to confirm whether delete markers and non-current versions appear. If they do, the fix is needed. If the list stays clean, the finding is invalid.

- [ ] **`ecscluster-vpc-rds-asg` — RDS uses static master password, no `EnableIAMDatabaseAuthentication`**
  Currently every application authenticates with the same static `RdsMasterPassword` passed as a stack parameter. With IAM auth enabled, ECS tasks use a short-lived token generated from their IAM role instead — no static credentials stored anywhere. Access can be revoked per-service via IAM without changing a shared password. Requires code changes in each application to use token-based connection strings. Worth doing as part of the zero-trust posture but not a quick fix.

- [ ] **`ecsservice` — Replace step scaling with Target Tracking to clean up alarm noise**
  Each service stack creates explicit `AlarmAutoscaleScaleDown` and `AlarmAutoscaleScaleUp` CloudWatch alarms as step scaling triggers. These alarms are permanently "In alarm" whenever CPU is low (i.e. the service is healthy), polluting the alarms dashboard and making it impossible to distinguish real problems from normal scaling activity. Fix: replace the step scaling policy + explicit alarms with a single Target Tracking scaling policy (e.g. target CPU at 50%). Target Tracking manages its own `TargetTracking-...` prefixed alarms internally, keeping operational alerts clean. Affects every deployed service stack — coordinate rollout.

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
