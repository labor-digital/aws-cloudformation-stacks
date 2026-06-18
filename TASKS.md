# Code Review — `feature/update-cluster-additional-changes`

## Critical

- [ ] **`cloudfront-alb-distribution` — WAFv2 CLOUDFRONT scope requires `us-east-1`**
  The `AWS::WAFv2::WebACL` with `Scope: CLOUDFRONT` can only be created in `us-east-1`. No region guard exists. Deploying with `EnableWAF=true` (the default) in any other region causes a deploy-time failure and stack rollback. Fix: add a deploy-time assertion or split the WAF into a separate `us-east-1` stack.

- [ ] **`ecscluster-vpc-rds-asg` — `ManagedTerminationProtection: DISABLED` on `CapacityProvider`, no drain mechanism**
  When ECS Managed Scaling scales in, the ASG can terminate instances mid-task. The prior Lambda lifecycle hook that drained containers before termination was removed and not replaced. Fix: set `ManagedTerminationProtection: "ENABLED"`.

- [ ] **`ecscluster-vpc-rds-asg` — `BackupRetentionPeriod` reduced from 35 days to 1 day**
  A data corruption event not detected within 24 hours leaves no Aurora automated snapshot. The AWS Backup vault provides weekly snapshots only — up to 6 days of transactional data would be unrecoverable. Fix: restore to at least 7 days (35 preferred).

## High

- [ ] **`ecscluster-vpc-rds-asg` — IPv6 ingress rules dropped from ALB security group `SgPublicHttpHttps`**
  The old `SgPublicHttps` had four ingress rules (IPv4 + IPv6 × ports 80 + 443). The replacement has IPv4-only. Clients on IPv6-only networks receive a TCP refusal at the internet-facing ALB. Fix: add `::/0` ingress rules for ports 80 and 443.

- [ ] **`ecscluster-vpc-rds-asg/alb-logs-bucket` — S3 lifecycle rule missing `NoncurrentVersionExpiration`**
  Versioning is enabled, but the `DeleteLogs` lifecycle rule only expires current-version objects. Non-current versions (created on every ALB log write) accumulate indefinitely, silently defeating the DSGVO retention ceiling and causing unbounded storage growth. Fix: add a `NoncurrentVersionExpiration` rule matching `RetentionDays`, or disable versioning (ALB log objects are never overwritten, so versioning provides no benefit).

- [ ] **`dns-firewall/index.template` (top-level) — staged as Added but deleted on disk**
  `git status` shows `AD dns-firewall/index.template`. Committing now records a file that doesn't exist on disk; the live template is at `ecscluster-vpc-rds-asg/dns-firewall/index.template`. Fix: stage the deletion (`git add dns-firewall/index.template`) before committing.

## Medium

- [ ] **`ecscluster-vpc-rds-asg` — VPC Flow Logs changed from `ALL` to `REJECT`**
  Accepted traffic is no longer logged. A compromised container exfiltrating data over permitted paths leaves no flow log trail. Incident responders lose source/destination IP and byte-count evidence for successful connections. Consider keeping `ALL` or using `ACCEPT` to restore forensic capability, accepting the increased log volume.

- [ ] **`ecscluster-vpc-rds-asg/dns-firewall` — default `WhitelistDomains` covers only `*.in-addr.arpa`**
  The catch-all rule currently uses `ALERT` (not `BLOCK`), so nothing breaks today. But if the catch-all is ever switched to `BLOCK` (the intended final state per the Zero-Trust roadmap), the default whitelist allows only PTR queries and would immediately block all DNS for `*.amazonaws.com`, ECR, S3, RDS, and application dependencies. Fix: document that `WhitelistDomains` *must* be populated before switching to BLOCK, or provide a safer default covering essential AWS domains.

- [ ] **`ecscluster-vpc-rds-asg` — Seven cross-stack exports removed**
  Removed: `SgVpcMysqlAccess`, `SgVpcLoadbalancerports`, `SgVpcEfsAccess`, `SgLaborSsh`, `InstanceroleProfile`, `KeypairName`, `AscalegroupHookTermTopic`, `ImageId`. No internal consumers found, but any external stack referencing these via `Fn::ImportValue` will fail on its next update. Audit external stacks before merging.

## Low

- [ ] **`alb-ecsservice-rule` + `ecsservice` — deploying both for the same service causes a listener rule priority conflict**
  Both templates create HTTP and HTTPS listener rules. Using them together for the same service creates duplicate rules at the same priority on the same listener, resulting in an `ALBListenerPriorityConflict` error that spans two independent stacks. Add a warning to the `alb-ecsservice-rule` README clarifying it is only for ECS services deployed outside the `ecsservice` template.

---

# Template Review — `ecscluster-vpc-rds-asg/index.template`

## Medium — ECS scaling

- **`CapacityProvider`** — `ManagedTerminationProtection: DISABLED`. Instances can be terminated mid-task during scale-down without draining. Change to `ENABLED`.
- **`CapacityProvider`** — `MaximumScalingStepSize: 2` is hardcoded and conservative. During traffic spikes the cluster can only add 2 instances per scaling action.

## Low — RDS hardening

- No `EnableIAMDatabaseAuthentication`.
- No `EnableCloudwatchLogsExports` for MySQL error/slow query logs.

---

## LII26-96: Weitere Härtung unserer Cluster (ausgehender Traffic)

### Overall Goal: Zero-Trust Outgoing Network Security

These tickets implement a **Zero-Trust security model** for **outgoing traffic** from AWS infrastructure. Currently, servers can connect to almost anything on the internet. This project locks that down so servers can ONLY connect to explicitly approved external services.

**Current state:** Servers have an "open door policy" - they can call out to anywhere on the internet.  
**Target state:** Servers have a "strict guest list" - they can only contact pre-approved destinations.

---

### Key Concepts

#### Route 53 DNS Firewall
Route 53 is AWS's DNS service - it translates domain names (like `google.com`) into IP addresses. **Route 53 DNS Firewall** controls and monitors which domain names servers are allowed to look up.

**Why this matters:**
- Even if you block IP addresses, servers can still look up new ones via DNS
- DNS logs show exactly what external services applications are trying to reach

#### Hard-coded IPs bypass DNS Firewall
DNS Firewall controls resolution only. If an application has a **cached or hard-coded IP address**, it connects directly without triggering a DNS lookup — the firewall rule is bypassed entirely. This is why Phase 3 (Security Group port restrictions) is a necessary complement: even if DNS is bypassed, the port-level egress rules still apply. For full IP-level protection, AWS Network Firewall can be added as an additional layer.

#### Security Groups
Security Groups are AWS's virtual firewalls controlling network traffic in/out of servers.

**Current problem:** Most setups have a blanket rule "allow ALL outgoing traffic to anywhere" (0.0.0.0/0):
- Servers can connect to ANY IP address on ANY port
- Malware can "phone home" to command servers
- Applications can make unexpected connections

---

### 4-Phase Implementation Plan

#### Phase 1: LII26-94 - Set Up DNS Monitoring (ALERT Mode)

**Objective:** Set up DNS Firewall in "spy mode" - watches and logs everything but doesn't block anything yet.

**Setup:**
1. Create an empty "allowed domains" list
2. Create two firewall rules:
   - **Rule 1:** If domain is on allowed list → let it through
   - **Rule 2:** If domain is NOT on list → log as ALERT (but still allow)
3. Turn on detailed DNS logging to CloudWatch or S3

**Why:** Before creating a whitelist, need to see what applications are actually using.

**Analogy:** Installing security cameras to record who's coming and going before deciding who gets keys.

---

#### Phase 2: LII26-93 - Analyze Logs & Create the Whitelist

**Objective:** After ~7 days in ALERT mode, analyze logs to identify legitimate external services.

**Process:**
1. Review CloudWatch logs for all ALERT entries
2. Identify most frequently requested domains
3. Separate legitimate services from unwanted ones:
   - ✅ **Keep:** `*.stripe.com` (payments), `*.ubuntu.com` (updates), `*.openai.com` (AI APIs)
   - ❌ **Remove:** Ad trackers, suspicious domains
4. Create final whitelist
5. Add approved domains to Route 53 Domain List

**Analogy:** After watching security footage, creating the actual guest list.

---

#### Phase 3: LII26-95 - Harden Security Groups (Port-Level Control)

**Objective:** Close the "IP address loophole" by controlling WHICH PORTS servers can use for outgoing connections.

**Current problem:** Security Groups typically allow ALL ports to ALL destinations (0.0.0.0/0).

**The fix - Replace with specific rules:**

1. **Port 443 (HTTPS)** - For web APIs and secure connections
   - Most modern services use HTTPS (Stripe, OpenAI, etc.)

2. **Port 587 (SMTP Submission)** - For sending transactional emails via SES
   - Transactional emails: password resets, notifications
   - Note: AWS blocks **Port 25 outbound from EC2 by default** to prevent spam — Port 587 is what you actually need

3. **Port 123 (NTP)** - For time synchronization (only if not using Amazon Time Sync Service)
   - Servers need accurate time for security certificates
   - **Prefer:** Use the Amazon Time Sync Service (`169.254.169.123`) — a link-local address that never leaves the VPC. If adopted, this outbound rule is not needed at all.

4. **Delete the blanket "allow all" rule**

**Why this matters:**
- Even with an IP address, can't connect on unusual ports
- Can audit exactly which ports are being used
- Dramatically limits attack surface

**Analogy:** Not just controlling WHO can visit, but also WHAT DOORS they can use.

---

#### Phase 4: LII26-92 - Go Live (Switch to BLOCK Mode)

**Objective:** Flip from "monitoring" to "enforcing" - DNS Firewall blocks unauthorized domains.

**The change:**
- DNS Firewall Rule 2 changes from **ALERT** to **BLOCK**
- Any domain NOT on whitelist gets blocked with `NXDOMAIN` response

**Critical testing:**
- Lieferchat (chat system)
- Matomo (analytics)
- Email sending
- All other applications

**Why test thoroughly:** If a legitimate domain was missed in Phase 2, that service will break.

**Analogy:** Locking the doors and only letting in people with keys.

---

### Security Benefits

1. **Prevents Data Exfiltration** - Attackers can't send data to external servers
2. **Blocks Command & Control** - Malware can't "phone home" for commands
3. **Detects Anomalies** - Any blocked DNS request is immediately suspicious and logged
4. **Compliance** - Many security frameworks require egress traffic controls
5. **Principle of Least Privilege** - Servers can ONLY access what they need

---

### Deployment Strategy

- **Paris:** Testing ground - implement gradually, relatively short work
- **Frankfurt:** Main production environment - more work, especially whitelist creation (more complex applications = more external dependencies)

---

### Related Tickets

- **LII26-94:** Route 53 DNS Firewall im Audit-Modus (ALERT) aufsetzen
- **LII26-93:** Log-Analyse & Erstellung der FQDN-Whitelist  
- **LII26-95:** Härtung der Security Groups & Aktives Port-Audit
- **LII26-92:** Go-Live & Scharfschaltung (Enforcement auf BLOCK)

---

## Evaluation of the “Zero‑Trust Outgoing Network Security” Roadmap (LII26‑96)

1. High‑level Assessment
   Aspect	What’s Strong	Where It Needs Tightening
   Scope & Goal	Clear, concrete Zero‑Trust target: only pre‑approved outbound destinations. The 4‑phase structure follows a safe “monitor → refine → harden → enforce” pattern.	The roadmap does not explicitly call out fallback / rollback procedures if a production block breaks a critical service.
   Phasing	 Phase 1 (spy mode) gives you real‑world traffic data before any disruption. <br>Phase 2 builds a data‑driven whitelist. <br>Phase 3 adds port‑level SG hardening, reducing the “IP‑only” loophole. <br>Phase 4 flips to enforcement only after validation.	 The order of Phase 3 and Phase 4 could be swapped or overlapped: you may want to enforce the SG changes before you start blocking DNS, because SG changes are less visible to callers (they’ll get immediate connection‑refused errors) and can surface missing ports earlier.
   Granularity	Uses Route 53 DNS Firewall for FQDN‑level control—a newer, more manageable construct than raw IP ACLs.	DNS‑Firewall only controls resolution; applications that already have cached IPs or use hard‑coded IPs won’t be affected. A complementary VPC Egress VPC Endpoint / NAT‑Gateway policy is not mentioned.
   Observability	DNS logs to CloudWatch/S3, plus SG rule changes → clear audit trails.	No mention of metrics/alarms (e.g., CloudWatch metric for number of BLOCKED DNS queries) that would surface a sudden spike after Phase 4 goes live.
   Testing	Lists key services (Lieferchat, Matomo, email) for validation.	No systematic canary / blue‑green rollout plan or a defined test‑automation suite (e.g., synthetic “curl” probes from each AZ).
   Environment Rollout	Starts in Paris (smaller) then Frankfurt (larger) – good risk‑mitigation.	Should also consider a sandbox / dev environment first (if not already covered by Paris) to catch any config‑drift before any production traffic hits the firewall.
   Documentation & Governance	Whitelist is documented in Route 53 domain list – easy to version‑control.	No explicit ownership for whitelist maintenance (who updates it when a new third‑party service is added?) and change‑approval workflow (e.g., change‑request ticket, peer‑review).
2. Detailed Phase Review & Recommendations
   Phase 1 – DNS Firewall in ALERT (LII26‑94)
   What works well

Empty whitelist + “allow‑all‑but‑log” rule is the textbook way to collect baseline data without breaking anything.*
Recommendations

Recommendation	Why / How
Enable Forward‑Query Logging to both CloudWatch and S3 (dual sink).	CloudWatch gives near‑real‑time visibility for quick triage; S3 provides durable storage for longer‑term analytics (e.g., weekly “top‑10 domains”).
Tag the Log Group with environment, project, and security‑owner.	Simplifies cost‑allocation and IAM permissions for downstream analysts.
Add a “default‑deny” rule for known‑bad domains (e.g., internal blocklists for ad‑trackers, known C2 domains).	Even in “spy” mode you can pre‑empt obvious malicious traffic with “BLOCK‑LOG” rather than just “ALLOW‑LOG”.
Set up a metric filter for “ALERT” events and an alarm on a surge (> 2× baseline).	Early warning if a compromised workload suddenly starts contacting many unknown domains.
Capture the “resolver IP” (VPC‑wide) – ensure you are logging from the VPC DNS Resolver and not from an external resolver that bypasses the firewall.	Guarantees full coverage.
Phase 2 – Log Analysis & Whitelist Creation (LII26‑93)
What works well

Seven‑day collection period gives a decent sample of normal traffic.*
Recommendations

Recommendation	Why / How
Automate the analysis with a lightweight Lambda / Athena query that produces a frequency‑by‑domain table (requests, unique source IPs, ports).	Reduces manual effort and provides a reproducible baseline.
Classify domains into “required”, “optional”, and “review‑later”.	Supports a staged whitelist: start with “required” (core services) for Phase 4, then gradually expand.
Cross‑reference against known‑good public lists (e.g., AWS-managed amazon-aws.com, cloudfront.net, gcr.io).	Avoids missing ubiquitous AWS services that your workloads already depend on.
Document each whitelist entry – source service, reason, owner, and expiration date.	Future audits and “who‑owns‑this‑entry” questions become trivial.
Add a “review‑window” (e.g., 30 days) after Phase 4 where any newly BLOCKED domain triggers a ticket for whitelist addition.	Prevents long‑term service outages when new legitimate dependencies appear.
Consider “wildcard” vs. explicit FQDN carefully.** Wildcards (*.stripe.com) are convenient but may unintentionally open up sub‑domains you don’t need.**	Wherever possible, list explicit sub‑domains (e.g., api.stripe.com) and keep a separate “catch‑all” rule for “known‑good‑provider‑wildcards”.
Phase 3 – Security‑Group Port Hardening (LII26‑95)
What works well

Replaces “allow‑all‑outbound” with a concise set of ports.*
Recommendations

Recommendation	Why / How
Apply SG changes before DNS enforcement (or at least in a canary wave).	A blocked DNS lookup yields a “NXDOMAIN” error, which some apps treat as “transient”; a blocked outbound port gives a clearer “connection‑refused” and surfaces missing ports earlier.
Add an explicit “allow‑all‑outbound to VPC DNS resolver (53/udp,53/tcp)” rule.	Prevents accidental lock‑out of internal DNS resolution (especially if you later move to a private Resolver endpoint).
Include Port 443 with destination security group (or prefix list) limited to the whitelist CIDR ranges derived from the DNS analysis.	Tightens the “any‑IP” allowance – you can pair SG with a prefix‑list of approved CIDRs (e.g., the public CIDRs for *.stripe.com).
Add port 123 (NTP) only if you are not using Amazon Time Sync Service (169.254.169.123). If you switch to the native service, you can drop NTP entirely.
Create a “SG‑Egress‑Audit” tag and a scheduled Lambda that checks for any SG that still has 0.0.0.0/0 outbound.	Guarantees you catch drift (new SGs created later).
Document the just‑in‑time rationale for each port (e.g., “Port 25 for transactional email sent via SES – endpoint is email-smtp.<region>.amazonaws.com).	Makes future reviewers understand why a rule exists.
Consider using VPC Endpoints for AWS services (S3, DynamoDB, CloudWatch). Then you can completely remove internet egress for those services.	Further reduces the attack surface.
Phase 4 – Switch to BLOCK Mode (LII26‑92)
What works well

The final “lock‑down” operation is clearly defined.*
Recommendations

Recommendation	Why / How
Canary rollout: enable BLOCK for one private subnet or one AZ first, monitor for failed DNS lookups (CloudWatch metric Route53ResolverQueryBlockedCount).	Gives you a safety net before a full‑scale flip.
Run a synthetic health‑check (e.g., a Lambda that resolves a known‑good domain from each subnet) after the switch.	Spot any missing entries immediately.
**Enable “fail‑open” fallback for critical services (e.g., temporarily whitelist *.amazonaws.com and *.cloudfront.net) during the first 24 h, then remove them after confirming stability.	Prevents catastrophic outages in case a critical internal service relies on an un‑whitelisted domain.
Create a “quick‑add” process (e.g., a lightweight ServiceNow ticket that triggers an automated Lambda to add a domain to the whitelist) with a < 15 min SLA.	Reduces downtime when an unexpected domain is needed.
Post‑deployment audit: run a “blocked‑query” report for the first 48 h and share with owners of each service.	Drives rapid remediation of any missed entries.
Document the rollback plan: a single CLI step (aws route53resolver update-firewall-rule-group --firewall-domain-list-id … --action ALLOW) – store the command in the ticket.	Guarantees you can revert quickly if a major outage is discovered.
3. Missing Pieces / Additional Controls
   Area	Gap	Suggested Action
   Network‑Level Egress Controls	Only SGs + DNS Firewall – no NAT‑gateway / firewall‑instance policies.	Deploy an AWS Network Firewall or NAT‑gateway with egress security policy for another layer of protection (IP‑level block).
   VPC Endpoint for DNS	The default VPC resolver can forward to the internet; without a VPC DNS endpoint you still have a “last‑resort” path.	Set up Resolver inbound/outbound endpoints with firewall rules that only allow whitelisted domain lists.
   IAM / Role‑Based Access	No mention of limiting which IAM roles can modify the DNS firewall / SGs.	Enforce IAM policies so only a dedicated “Network‑Sec” role can update the whitelist.
   Change‑Management Integration	No explicit link to change‑management tool (e.g., ServiceNow, Jira) for whitelist updates.	Create a Jira workflow (or ServiceNow) that ties a “Whitelist‑Update” ticket to a CI/CD pipeline (e.g., aws route53resolver CLI in a CodePipeline step).
   Metrics & Alerting	Only logs mentioned.	Add CloudWatch dashboards: total DNS queries, ALERT vs BLOCK counts, SG outbound hits, and alerts for spikes.
   Compliance Mapping	No direct mapping to frameworks (PCI‑DSS, ISO 27001).	Create a matrix that maps each phase to relevant controls (e.g., PCI‑DSS 1.2.1 – “Restrict inbound/outbound traffic”).
   Testing Automation	Manual “test the chat system, Matomo, email” is error‑prone.	Build synthetic tests with AWS CloudWatch Synthetics or a small Lambda suite that runs every 5 min to verify connectivity to each whitelisted domain.
   Documentation & Training	Not explicitly covered.	Produce a runbook describing how to read the DNS‑firewall logs, add a domain, and roll back. Conduct a short knowledge‑transfer session with the Ops team.
4. Risk Matrix
   Risk	Likelihood	Impact	Mitigation
   Service breakage after BLOCK (missing domain)	Medium (depends on whitelist completeness)	High (customer‑facing outages)	Canary rollout, synthetic health‑checks, fast‑add process, 24‑h monitoring window
   Drift – new SGs with 0.0.0.0/0	Medium	Medium	Automated Lambda audit + alert on any SG with 0.0.0.0/0 egress
   AWS DNS‑Firewall rule limit reached (if many domains)	Low‑Medium (wildcards limit)	Low	Consolidate domains by provider, use wildcard carefully, monitor rule count
   Cache‑eviction issues (clients using cached IPs)	Low	Medium	Reduce TTL on resolver (if possible), educate devs to clear caches during rollout
   Accidental removal of internal DNS domains	Low	Medium	Scope firewall rules to public‑only zones (use BLOCK only for external queries)
   Insufficient logging retention	Low	Low	Set S3 lifecycle to retain logs for at least 90 days (or compliance period)
   Human error during whitelist updates	Medium	Medium	Require PR review for any whitelist change, automate via CI pipeline
5. Suggested Timeline (with Buffer)
   Week	Activity	Owner	Deliverable
   1‑2	Phase 1 – Deploy DNS‑Firewall in ALERT, configure logging, metric alarms	Network Sec / CloudOps	Firewall ID, CloudWatch Log Group, alarm definitions
   3‑4	Phase 2 (first half) – Collect logs, start automated analysis (Athena query)	Data Engineer + SecOps	Daily “Top‑20 domains” report
   5‑6	Phase 2 (second half) – Final whitelist draft, stakeholder approval, create domain list in Route 53	SecOps + Application Owners	Approved DomainListId with versioned documentation
   7‑8	Phase 3 – Harden SGs (port‑level), implement automated drift detector	CloudOps	Updated SGs, Lambda audit script, audit report
   9‑10	Phase 4 – Canary – Enable BLOCK on a single AZ/subnet, run synthetic probes	CloudOps + QA	Block mode enabled for canary, monitoring dashboard
   11‑12	Full BLOCK rollout – Switch all AZs, update runbooks, publish “quick‑add” workflow	CloudOps	Global BLOCK mode, runbook, knowledge‑transfer session
   13+	Post‑deployment – Ongoing monitoring, quarterly whitelist review, SG audit	SecOps	Monthly “blocked‑query” report, quarterly whitelist refresh
   Add a 2‑day rollback buffer after each major change (especially after the canary and the full BLOCK switch).

6. Quick‑Start Checklist (for the team)
   Create IAM role aws-guard-dnsfirewall with least‑privilege permissions (route53resolver:*DomainList*, route53resolver:*RuleGroup*, logs:Put*).
   Deploy empty domain list → note the DomainListId.
   Create Rule Group:
   Rule 1 → ACTION ALLOW → MATCH DOMAIN LIST (the empty list).
   Rule 2 → ACTION ALERT → MATCH NOT IN DOMAIN LIST.
   Associate Rule Group with VPC resolver endpoint (or the default VPC resolver).
   Enable DNS query logging → CloudWatch Log Group dns-firewall-logs.
   Set up CloudWatch metric filter for ALERT events → alarm on > 2× baseline.
   Run Athena query (or quick Lambda) to produce a daily “Top 20 domains” CSV saved to S3.
   Iterate whitelist → add entries (*.stripe.com, *.ubuntu.com, *.openai.com, etc.).
   Update SGs: remove 0.0.0.0/0 outbound, add port‑specific egress rules (443, 25/587, 53, 123).
   Create a canary SG (or use a single subnet) and flip Rule 2 from ALERT → BLOCK.
   Validate: run health‑checks, watch block metrics; if anything fails, add the domain to whitelist via the quick‑add Lambda.
   Full rollout and hand‑off documentation.
7. Bottom Line
   The roadmap is well‑structured and follows a classic “monitor‑then‑enforce” approach, which minimizes risk. By tightening a few key gaps—automatic log analysis, staged SG changes, canary rollout, robust alerting, and clear ownership of the whitelist—you’ll achieve a smooth transition to a Zero‑Trust egress posture with minimal production impact.

Implement the additional controls and the checklist above, and you’ll have a solid, auditable, and maintainable solution that satisfies both security & operational teams.