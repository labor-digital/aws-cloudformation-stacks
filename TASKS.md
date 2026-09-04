# Open tasks

Pending changes to the templates, plus one record of what the clusters currently run. Template
rationale lives in [README.md](README.md); the analysis behind these items — designs, measurements,
incident reconstructions — is in `git log -p TASKS.md`, the retired CHANGELOG in
`git show 81b6c0e:CHANGELOG.md`.

## Cluster state

> Paris read live **2026-09-05**. Frankfurt has not been re-read since 2026-08-22 and is left blank
> rather than repeated from stale notes. This is the only place in the repo that describes deployed stacks.

| | Paris `labc-eu-w3` (staging) | Frankfurt `labc-eu-c1` (prod) |
|---|---|---|
| Cluster template version | `1.4.0` | ? |
| `ecsservice` versions | `1.3.0`, 15/15 — one behind the template | ? |
| `WafClientIpHeader` | **empty** | ? |
| WAF rule actions | all five on `count` | ? |
| WAF log delivery | ✅ ingesting, last 2026-09-04 21:50 UTC | verified 2026-08-22 |
| WAF volume | `CommonRuleSet` 549 counted / 24 h ≈ 2 per 5 min | ? |
| `EnableEgressAnalysis` | **still `true`** — ACCEPT log group exists and bills per GB | ? |
| DNS Firewall | 14 whitelist entries, catch-all still `ALERT` | ? |
| Log retention drift | none, all groups at 14 | raised by hand |
| Other drift | `Ascalegroup`, `DnsQueryLoggingConfig`, `Rdscl`, `Rdsinstance1` | same four |

**Two parameters Paris still passes no longer exist in `1.5.0`:** `WafBlockedRequestAlarmThreshold` (`0`)
and `WafLogRetentionDays` (`14`). Drop both from the parameter list on the next deploy, or CloudFormation
rejects the update with *"Parameters … do not exist in the template"*.

```bash
aws cloudformation describe-stacks --region <r> --stack-name <cluster> \
  --query "Stacks[0].{v:Outputs[?OutputKey=='TemplateVersion'].OutputValue|[0],p:Parameters}"
aws cloudformation describe-stacks --region <r> \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName,version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" \
  --output table
aws cloudformation detect-stack-drift --region <r> --stack-name <cluster>
```

Cluster `1.5.0` and `ecsservice` `1.4.0` are written but not deployed anywhere.

---

## `ecscluster-vpc-rds-asg`

Drift confirmed in **both** regions (Paris 2026-09-05): `Ascalegroup /DesiredCapacity`,
`DnsQueryLoggingConfig /DestinationArn`, `EngineVersion` on `Rdscl` and `Rdsinstance1`. Only the
retention drift is Frankfurt-only.

- [ ] **Resolve the `EngineVersion` contradiction.** The template pins `8.0.mysql_aurora.3.08.2` *and*
  sets `AutoMinorVersionUpgrade: true`, so RDS moves ahead of the template. No downgrade can happen,
  but the next update touching **any** RDS property sends the pin and fails the stack. Set the template
  to the running version, or drop the pin.
- [ ] **`AscalegroupDesSize` fights managed scaling.** Its `MaxValue: 15` is below what ECS managed
  scaling actually runs, so every cluster update pushes desired capacity down and **terminates
  instances** — and tasks are dropped rather than drained, because `ManagedTerminationProtection` is
  `DISABLED`. Lift the bound and consider enabling termination protection.
- [ ] **Decide the log retention conflict — Frankfurt only, Paris is clean.** Two groups were raised by hand while the template says
  `14`; any edit to that line pushes `14` back and deletes the excess, and both hold personal data.
  Either accept 14 or raise the hardcoded value. A parameter is not the route — `WafLogRetentionDays`
  was removed on 2026-08-28 precisely so retention is not tunable per stack.
- [ ] **Add a `DnsFirewallCatchAllAction` parameter** (`ALERT`/`BLOCK`, default `ALERT`). The action is
  hardcoded today, so flipping it via the CLI is drift that the next stack update silently reverts.
  Prerequisite for Phase 4.
- [ ] **Enforce the origin-verify header on the listener rules** (`http-header` condition).
  `cloudfront-alb-distribution` already *sends* it; only enforcement is missing. Closes the Cloudflare
  **and** CloudFront bypass in one change, and is the remaining designed fix for the Solr exposure now
  that the internal ALB is gone. Design and limits: `git log -p TASKS.md`.
- [ ] **Make the listeners' default action a `fixed-response` 403.** Both currently forward to the
  empty `Deftarget`, which yields 503 — harmless only by accident.
- [ ] **Replace the blanket `Egress: ALL → 0.0.0.0/0`** with the target set: `443/TCP` anywhere;
  `80/TCP` anywhere (OCSP/CRL — **dropping this breaks TLS validation**); `587/TCP` to the SMTP relay;
  `4318/TCP` to the OTLP collector; `53/UDP+TCP` to the **VPC CIDR only**, which closes the `8.8.8.8`
  bypass.
  - ⚠️ **All three instance SGs must be restricted or this is a no-op** — `SgVpcMysqlAccess`,
    `SgVpcLoadbalancerports` and `SgVpcEfsAccess` all sit on the launch template, none defines
    `SecurityGroupEgress`, and SG rules are additive. Restrict all three, or add one dedicated egress SG.
  - Blocked on: fixing the OTel agent's hardcoded `8.8.8.8` resolver first (one image, deployed three
    times), and confirming the `80/TCP` destinations really are OCSP/CRL.
- [ ] **Restrict `SgPublicHttpHttps` to the proxy ranges.** It is open to `0.0.0.0/0` today, so the
  ALB stays directly reachable and `cf-connecting-ip` is forgeable — which defeats both the rate limit
  and any header-based origin check. A layer, not the only control: the ranges are shared by every
  Cloudflare tenant and the list needs refreshing. Blocked on the inventory of which sites are proxied.
- [ ] **`CommonRuleSet` needs rule exclusions before it can ever block:** `SizeRestrictions_BODY`
  (>8 KB, so every backend file upload), `GenericRFI_BODY` (`://` in a body — pasted URLs),
  `CrossSiteScripting_BODY` (rich-text editors), `NoUserAgent_HEADER` (API clients, cron).
- [ ] **Protect login endpoints.** Signature groups inspect content and a wrong-password POST is
  well-formed; 2,000/IP/5 min lets 300 attempts/min through. Preferred: a **failed-login metric filter
  per service log group → `AlertTopic`** — it counts failures, which no rate limit measures.
  Alternatives: `AWSManagedRulesATPRuleSet` (paid per request, needs login path and field names per
  app), or a scoped rate limit — deferred, because `/xmlrpc.php` beats `/wp-login.php`, `/typo3/` also
  matches real editor sessions, and Matomo's login is `/index.php?module=Login`, invisible to a
  `UriPath` rule.
- [ ] **Launch-time AMI resolution + scheduled instance refresh.** Nothing replaces a running instance,
  so hosts drift; `dnf-automatic` installs security patches only and never reboots. The blocker:
  `{{resolve:ssm:…}}` is a *CloudFormation* reference and bakes a literal AMI into the launch template,
  so a scheduled refresh relaunches the same image — it must become
  `{"Fn::Sub": "resolve:ssm:${AmiSsmParameter}"}`. Full design (promotion gate, refresh settings, the
  `ManagedDraining` replacement hazard): `git log -p TASKS.md`.
- [ ] **Gateway VPC Endpoint for S3** on `RoutetablePrivate`. The saving is small; the reason is that
  the egress rules above can then match the S3 **managed prefix list** instead of `443 → 0.0.0.0/0` for
  ECR pulls, and EFS-restore uploads stop paying NAT.
- [ ] **Add an EFS lifecycle policy** — everything stays in Standard indefinitely, the largest storage
  cost lever in the stack. `TransitionToIA: AFTER_30_DAYS` + `TransitionToPrimaryStorageClass:
  AFTER_1_ACCESS`, but check access patterns first: IA charges per GB retrieved, which is
  counterproductive if something walks the whole tree on a cron.
- [ ] **Give `BackupRole` a restore path, or record the split.** It carries only
  `…ForBackup`; practice today is the console's account-wide `AWSBackupDefaultServiceRole`, created
  outside CloudFormation.
- [ ] **Dashboard widgets** — an `alarm` widget listing every cluster alarm (they are spread across four
  stacks with no single view); an HTTP status widget using **`Sum`, never `Average`** (the ALB emits one
  datapoint of value `1` per response, so `Average` is a flat line at 1.0 that looks broken); and
  `RequestCount` with an anomaly band, which covers the blind spot where traffic is swallowed upstream
  and every alarm stays green while the site is down.
- [ ] **RDS uses a static shared master password**, no `EnableIAMDatabaseAuthentication`. IAM auth would
  give each task a revocable short-lived token but needs connection-string changes in every application.

### WAF — promotion path

Every rule ships as `count`, so the WebACL is inert on arrival. Promotion is a parameter change, never
a template edit, and the order matters:

1. **Set `WafClientIpHeader` first.** Without it `RateLimitForwardedIp` does not exist and
   `RateLimitSourceIp` keys on the proxy's own addresses — every day of counting produces unusable
   data. (`RateLimitAction=block` is refused outright while it is empty; the template's `Rules` section
   enforces that.)
2. **Verify log delivery once per region — it fails silently.**
   `aws logs describe-log-streams --log-group-name aws-waf-logs-<cluster>-waf`; still empty after real
   traffic means the delivery is denied.
3. **Read `CountedRequests` per `Rule` for about a week.** Near-zero on legitimate traffic means the
   rule is safe to enforce; steady volume means it is a false-positive source and needs exclusions or a
   scope-down first.
4. **Promote one rule at a time**, raising its `*AlarmAction` from `dashboard` to `alert` in the same
   update — otherwise the first real block notifies nobody. Order: `KnownBadInputsAction` (narrow and
   payload-specific) → 48 h watching `BlockedRequests` → `SqliRuleSetAction` → `WordPressRulesAction`
   (check it misses Matomo tracking POSTs) → the rate rules → `CommonRuleSetAction` last, and only
   after its exclusions are in.
5. **Restricting `SgPublicHttpHttps` (above) is a prerequisite for trusting the header at all** —
   otherwise anyone can set `cf-connecting-ip` themselves and walk past the rate limit.

### DNS Firewall — path to BLOCK

The catch-all is hardcoded `ALERT`, so today the firewall only logs. Three phases, per cluster:

1. **Phase 2 — build the whitelist.** Run `DnsFireWallLogsSummary`, group ALERT'd domains by frequency,
   split legitimate from noise, aggregate by root domain, then update `DnsFirewallWhitelistDomains`.
   Wildcards match **one** level (`*.example.com` ≠ `foo.bar.example.com`).
   **Registry domains are the trap** — a `BLOCK` catch-all breaks the **image pull at the next task
   placement**, not the running container, so an application test passes while nothing can restart or
   scale. ECR is in `eu-central-1` for *both* regions: its API endpoint, `*.dkr.ecr.eu-central-1.amazonaws.com`,
   and the layer-storage S3 endpoints it redirects to — take the hostnames from the ALERT logs, don't
   assume. Docker Hub for the Matomo and Solr images: `registry-1.docker.io`, `auth.docker.io`, layer
   CDN. `suche.gwa.de` stays whitelisted permanently — the application resolves it via NAT, so a
   `BLOCK` catch-all breaks search silently.
   **The current Paris whitelist does not cover the registry hostnames** (checked 2026-09-05):
   `*.amazonaws.com` matches one level only, so it covers **neither** `api.ecr.eu-central-1.amazonaws.com`
   **nor** `*.dkr.ecr.eu-central-1.amazonaws.com` **nor** the layer-storage S3 endpoints, and
   `*.docker.com` does not cover `production.cloudflare.docker.com`. `registry-1.docker.io` and
   `auth.docker.io` are covered by `*.docker.io`. Harmless while the catch-all is `ALERT` — with
   `BLOCK` the next image pull breaks.

2. **Phase 3 — security groups.** The egress-rule replacement above. It needs a baseline first: set
   `EnableEgressAnalysis=true` for 7–14 days to get ACCEPT-mode flow logs, then back to `false` — they
   bill per GB and dominate logging cost while they run. Blocked on identifying the last unknown flow
   (`3724/TCP → 145.239.131.113`, OVH) and on the OTel resolver fix.
3. **Phase 4 — flip to `BLOCK`.** Requires the `DnsFirewallCatchAllAction` parameter above. Re-run
   `DnsFireWallLogsSummary`, confirm no legitimate domain still ALERTs, then set `BLOCK`. Test the
   applications, e-mail, time sync **and image pulls**; watch 48 h. Rollback is `ALERT`.

## `ecsservice`

- [ ] **Move `DOPPLER_TOKEN` from `Environment` to `Secrets`** (SSM Parameter Store or Secrets Manager).
  **One change, three problems:** the token stops being a plaintext value readable via
  `ecs:DescribeTaskDefinition`; rotation becomes an SSM update instead of a stack update; and
  `ProjectToken` stops affecting the task definition, which permanently closes the ImageResolver blind
  spot instead of working around it. If the parameter *name* is passed as a stack parameter, add it to
  the resolver's properties — a name is not secret.
- [ ] **Harden the ImageResolver** — on Update after a failed create the service no longer exists,
  `describe_services` finds nothing and the update hard-fails. ~4 lines of fallback to
  `InitialDockerImage`.
- [ ] **Log the resolved image.** The Lambda prints only on error, so a successful resolve leaves no
  record of what it chose — which is why the stale-image incident needed an ECS/CloudTrail
  reconstruction.
- [ ] **Set a real default for the 4xx anomaly band width.** Graph `HTTPCode_Target_4XX_Count` at
  `Sum`/5 min over two weeks and count breaches over two consecutive periods. No warmup needed, the
  metric is retained 15 months.
- [ ] **Network anomaly detection** — `NetworkIn`/`NetworkOut` alarms plus their parameters,
  ~2 weeks warmup.
- [ ] **The template cannot express a private service.** `Target` and `LoadbalancerRule*` are
  unconditional, `ListenerRuleHost` is required, and there is no `source-ip` condition anywhere — so
  anything that should not be public has no way to say so.

## `ecscluster-vpc-rds-asg/guardduty`

- [ ] **Route findings to `AlertTopic`** (EventBridge rule, severity ≥ 4). Findings currently notify
  nobody. Test with `create-sample-findings`.
- [ ] **Quarantine automation** — Lambda swapping an instance's SG to the Quarantine SG on HIGH
  findings. The template already exports the Quarantine SG, the execution role and the detector ID.
- [ ] **Enable `EBS_MALWARE_PROTECTION`** via the template, not the console. EBS only, so EFS is never
  scanned, and only after a finding already exists.
- [ ] **Evaluate Runtime Monitoring** (`RUNTIME_MONITORING` is `DISABLED`) — the only thing that records
  *execution*; ALB, DNS, flow and container logs cannot see a file written inside a container. Check
  ECS-on-EC2 support, agent footprint on `t3.small`, and **pricing — it bills per vCPU-hour**, unlike
  the base detector.

## `ecscluster-vpc-rds-asg/alb-logs-bucket`

- [ ] **TLS-only `Deny`** (`aws:SecureTransport=false`) — BPA blocks public access but not an
  authenticated caller over plain HTTP. `"*"` in a *Deny* is safe.
- [ ] **Declare `OwnershipControls: BucketOwnerEnforced`** — the live state is correct only because it
  is the current S3 default.
- [ ] **Add `aws:SourceAccount`** to the log-delivery statement as a confused-deputy guard.

## Other templates

- [ ] **`chatbot-slack` — does not exist.** Slack delivery is not implemented; the directory is empty
  and never held a template. Until one exists, alarms reach only each cluster's `AlertEmail`, and only those switched to
  `alert`. Needs a `SlackChannelConfiguration` with topic ARNs as parameters (exports do not cross
  regions), `GuardrailPolicies` on `ReadOnlyAccess`, and a named IAM role. **Blocked on a manual step:**
  a Slack workspace admin must authorize the AWS app once to produce `SlackWorkspaceId`. Confirm the
  region first — the Chatbot API seems to resolve only in `us-east-2`/`us-west-2`/`eu-west-1`.
  Fallback if that stalls: SNS → Lambda → webhook, URL in SSM `SecureString`, Lambda outside the VPC,
  DLQ required. A plain `https` subscription to a webhook does not work.
- [ ] **`efs-access` — does not exist**, designed but never written. A throwaway stack for pulling data off EFS (EC2 in a
  public subnet, SFTP to one operator CIDR, then delete); the deciding property is that **no copy of the
  data lands outside EFS**. Until it exists the only route out is the S3 path in the README's
  EFS-Restore runbook, which does create a second copy. **Prerequisite: the cluster template must export
  `SgVpcEfsAccess`, which it does not** — without it the mount would silently have no security group.
  Design and rejected transports: `git log -p TASKS.md`.
- [ ] **`TemplateVersion` output** on `backup-vaults-mirror` and the leaf templates — four templates
  have it, the rest cannot be version-queried at all.
- [ ] **`cloudfront-alb-distribution` scope trap** — `EnableWAF` defaults `true`, but a `CLOUDFRONT`
  WebACL exists only in `us-east-1`, so deploying elsewhere fails with `WAFInvalidOperationException`.
  Either a `Description` note or deploy that stack in `us-east-1`.

## Open questions outside the templates

- [ ] **Confirm and close the ALB-direct bypass for Solr — the real remaining risk, untested.** If the
  ALB answers a `Host: suche.gwa.de` request, Cloudflare's WAF, rate limiting and DDoS shielding are
  sidestepped, leaving BasicAuth in front of a Java service with an RCE history.
  `curl -k -o /dev/null -w '%{http_code}' -H 'Host: suche.gwa.de' https://<alb-dns>/solr/` — `401` from
  Solr means open, `404` from the ALB default means only the Cloudflare path works.
- [ ] **Record which sites are Cloudflare-proxied and which are direct.** Nothing distinguishes them,
  and it changes what every WAF rule inspects — and whether `cf-connecting-ip` can be trusted at all.
- [ ] **Audit `wp_options` for plaintext third-party credentials** — the Solr query user lives there, so
  assume it is compromised in any future WordPress breach.
- [ ] **Verify Cloudflare SSL mode is Full (strict)** — Solr speaks plain HTTP, so its credential
  crosses the ALB→task hop in cleartext.
- [ ] **Document Solr's `security.json`** — auth works but is expressed nowhere in this repo, so the
  next image bump could silently remove the only thing in front of the index.
- [ ] **Know what is running before a CVE lands** — nothing maps services to image versions, so "are we
  affected?" starts with `describe-task-definition` across every stack.
- [ ] **Read `S3FS-Policy` and `AzureAD_SSOUserRole_Policy`** — a blanket `s3:*` on `*` makes every
  bucket setting irrelevant. Also check AWS-managed grants, which `--scope Local` misses.
- [ ] **Apply BPA to the two `cf-templates-*` buckets** and check what is inside the two
  public-by-design website buckets — the risk there is a dump or `.env` uploaded alongside the assets.
- [ ] **Enable IAM Access Analyzer** (free) — the only thing evaluating policy, ACL and BPA together,
  and it catches cross-account grants, which are exposure without ever showing `IsPublic=true`.

## Settled — don't reopen

- **AWS Firewall Manager: no** (2026-08-19). It needs Organizations, an admin account and Config
  everywhere in scope. This is one account with CloudFormation as the source of truth, so FMS would
  apply rules out of band. Revisit only with a multi-account structure.
- **Internal ALB for VPC-only services: removed again** (2026-08-22), before any service used it.
  Reopening means re-doing `8c76965`, not patching around it — and the Solr exposure it was meant to
  close is back on the list above.
- **`AlarmHttp5xxElb`** — shipped and removed again; load-balancer-side 5xx is not a case we need
  alarmed.
- **Log anomaly detection** — Apache access lines all collapse into one pattern, so the feature is
  blind on our logs. Do not re-add without changing the log format first.
- **Don't wire SNS to `AlarmAutoscaleScaleDown`** — it is red during every normal scale-in.
- **WAF as a separate stack** — merged into the cluster template; split stacks are for things that are
  optional per cluster and iterated often.
- **Cloudflare-range allowlists as the *only* control** — the ranges are shared by every tenant.
- **EFS root-mount exposure: nothing further for now.** The fstab root mount was removed 2026-08-19.
  What remains needs a container breakout, and neither the SG nor a partial IAM policy can gate it
  (`bridge` mode means the agent mounts over the *host* ENI). Enforcement, if ever wanted, is
  per-service EFS access points + `Iam: ENABLED`.
- **`RdsErrorAlarm` threshold `0`** fires on any `[ERROR]` line — that is the point of it. Calibrate
  with `dashboard`, don't raise it blindly.
- **WAF rule group versions stay unpinned** — signatures arrive free, and can arrive broken. A choice.
- **Removed WAF rules, re-evaluate rather than forget:** `BlockWpBatchRoute` (`batch/v1` is a core route
  the block editor uses when saving), `BlockWpUserCreation` (WAF cannot tell an admin from a forger),
  `PHPRuleSet` (overlaps Common + WordPress), `AmazonIpReputationList` (source-IP only, so on proxied
  sites it inspects Cloudflare), `RestrictAdminPaths` + `WafAdminAllowedCidrs`.
