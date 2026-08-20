# Open tasks

To-do list only. Rationale in [README.md](README.md) / [CHANGELOG.md](CHANGELOG.md); the detailed
analysis behind these items is recoverable via `git log -p TASKS.md`.

## Next up (2026-08-20)

1. **Verify WAF log delivery in Paris** — fails silently. `aws logs describe-log-streams --region
   eu-west-3 --log-group-name aws-waf-logs-labc-eu-w3-waf`; empty after real traffic = denied.
2. **`EnableEgressAnalysis=false` in Paris** — 29 days vs. intended 14, costs money.
3. **Cluster `1.3.0` → Frankfurt, then Paris.** Frankfurt = 5 WAF `Add` + 3 internal-ALB `Add` +
   2 outputs + the four-row AMI cascade. 104 KB → S3 or console (51,200-byte inline limit).
4. **`ecsservice` `1.3.0` in Frankfurt** — 20 stacks left.

WAF is inert by design: everything defaults to `count`; `RateLimitAction=block` is refused unless
`WafClientIpHeader` is set.

## Cluster state

| Change | Paris `labc-eu-w3` (staging) | Frankfurt `labc-eu-c1` (prod) |
|---|---|---|
| Cluster template | ✅ `1.3.0` | ⏳ on `1.2.0` |
| `ecsservice` → `1.3.0` | ✅ 15/15 | ⏳ 1/21 (`gwa-gut-web-p` `1.2.0`, `ado-lea-tut-p` `1.0.1`, 19 `None`) |
| `EnableEgressAnalysis` off | ⏳ overdue | ⏳ analyse, then off by 2026-08-28 |
| LII26-96 Phase 2 (whitelist) | ⚠️ overdue since 2026-07-16 | ⏳ since 2026-07-17 |
| Service RAM resizes | ✅ | ⏳ `gwa-gut-sol-p` (77%) |
| GuardDuty projected monthly cost | 🗓 | 🗓 |

Rows done in both regions get deleted.

## `ecsservice`

- [ ] **Frankfurt: 20 stacks → `1.3.0`**, `SkipImageResolver=false` explicit. Cluster stack first —
  the High alarms import `${ClusterStackName}-AlertTopicArn`.
  - Pre-flight per stack: `SkipImageResolver` + `InitialDockerImage`. 19 stacks predate the version
    stamp → expect more `skip=true` than Paris's 1-of-15; verify each tag still exists in ECR.
  - Paris reference change set: `Add AlarmHttp5xxTarget`, `Modify ServiceHigh{Cpu,Memory}Alarm`,
    cosmetic `Modify LoadbalancerRuleHttp`. **Stop on any `Task`/`Service` row** — the ImageResolver
    returned a non-running image, i.e. `CannotPullContainerError`.
  - Order: `ado-lea-tut-p` → `lab-web-fro-p` (first ≥2 tasks) → the 1/1 and 1/2 services →
    `dwk-zer-app-p` (baseline 0) → the five at baseline 3 last.
- [ ] **Decide the 4xx band on `gwa-gut-web-p`** (live at width `3`): graph `HTTPCode_Target_4XX_Count`
  at `Sum`/5 min over two weeks, count breaches over two consecutive periods, set the width. No warmup.
- `ListenerArnOverride` shipped in `1.3.0` (`8c76965`) without a version bump, so `1.3.0` means two
  template states depending on whether a stack was updated before or after it. Default empty, so it
  changes nothing for the other 35 stacks — see Solr §3 for the one service that uses it.
- [ ] **Harden ImageResolver:** on Update after a failed create the service is gone,
  `describe_services` finds nothing and the update hard-fails — needs a ~4-line fallback to
  `InitialDockerImage`. Present-but-unhealthy isn't detectable; `SkipImageResolver=true` stays the override.
- [ ] **Network anomaly detection** — `NetworkIn`/`NetworkOut` + the two new parameters. ~2 weeks warmup.
- Don't re-add `ServiceLogAnomalyAlarm` — Apache access lines collapse to one pattern.
- Don't wire SNS to `AlarmAutoscaleScaleDown` — red during every normal scale-in.
- `RdsErrorAlarm` threshold `0` fires on any `[ERROR]` line — likeliest noise source now e-mail is on.

## WAF (cluster template `1.2.0`+, Paris deployed, count mode)

`CommonRuleSet`, `KnownBadInputs`, `SQLi`, `WordPress` + 2 rate rules (2,000/IP/5 min, all paths).
**1202 of 1500 WCU** — budget from the 298 headroom. Promotion is a parameter flip (`*Action`:
`off`/`count`/`block`), no template edit.

- [ ] **Deploy to Frankfurt in count mode** (rides `1.3.0`) — prod is where the counts mean something.
- [ ] **`WafClientIpHeader=cf-connecting-ip`** (lowercase enforced), else proxied requests aggregate
  onto Cloudflare's IPs and `RateLimitAction=block` takes out every proxied site.
- [ ] **Restrict `SgPublicHttpHttps` to Cloudflare's ranges.** One change: Cloudflare unavoidable,
  header trustworthy, bypass closed. A layer, not the only control — those ranges are shared by all
  Cloudflare tenants and the list needs refreshing.
- [ ] **Record which sites are Cloudflare-proxied vs. direct**, and what each zone has enabled.
  Nothing in the repo distinguishes them, and it changes what every rule inspects.
- [ ] **After ~1 week read `CountedRequests` per `Rule`, then flip `KnownBadInputsAction=block` only**
  — narrow and payload-specific. Near-zero counts = safe; steady volume = false-positive source.
  - [ ] **Set `WafBlockedRequestAlarmThreshold` in the same deploy** — at `0` no alarm is created and
    the first real block is invisible.
  - [ ] Watch `BlockedRequests` per rule 48 h, then `SqliRuleSetAction` → `WordPressRulesAction`
    (check it misses Matomo tracking POSTs) → rate rules → `CommonRuleSetAction` last.
  - `CommonRuleSet` needs *exclusions*: `SizeRestrictions_BODY` (>8 KB = every backend file upload),
    `GenericRFI_BODY` (`://` in body — pasted URLs), `CrossSiteScripting_BODY` (rich-text editors),
    `NoUserAgent_HEADER` (API clients, cron).
- [ ] **Login endpoints are unprotected** — signature groups inspect content and a wrong-password POST
  is well-formed, while 2,000/IP/5 min lets 300 attempts/min through. None of these are built:
  - **Failed-login metric filter per service log group → `AlertTopic` — cheapest, best fit.** Counts
    *failures*, which no rate limit measures. Pairs with app lockout (TYPO3 native, WordPress plugin).
  - **`AWSManagedRulesATPRuleSet`** — purpose-built for credential stuffing; paid per request, needs
    login path + field names per app.
  - **Scoped rate limit — deferred**, path list unsettled; misses slow-and-low and credential stuffing.
    Traps: `/xmlrpc.php` beats `/wp-login.php` (`system.multicall` = hundreds of guesses in one
    request); `CONTAINS /typo3/` also counts real editor sessions; **Matomo's login is
    `/index.php?module=Login`, invisible to a `UriPath` rule**; omit `NORMALIZE_PATH` and
    `//wp-login.php` walks past.
- **Removed 2026-08-20, re-evaluate rather than forget:** `BlockWpBatchRoute` (`batch/v1` is a core
  route the block editor uses when saving), `BlockWpUserCreation` (WAF can't tell an admin from a
  forger), `PHPRuleSet` (overlaps Common + WordPress), `AmazonIpReputationList` (source-IP only, so it
  inspects Cloudflare for proxied sites), `RestrictAdminPaths` + `WafAdminAllowedCidrs` (clients edit
  their own content, and a direct request carries no header so it fails the allowlist).
- Rule group versions are **unpinned** — signatures arrive free, and can arrive broken. A choice.
- AWS enables `OnSourceDDoSProtectionConfig` by default, but only *during* a detected DDoS.
- [ ] **`cloudfront-alb-distribution` scope trap** (README's "ungelöst — siehe TASKS.md"): `EnableWAF`
  defaults `true` and a `CLOUDFRONT` WebACL only exists in `us-east-1`, so deploying elsewhere fails
  `WAFInvalidOperationException`. CloudFront is Ohio-only today → if no distribution stack exists, the
  fix is a `Description` note + README correction; otherwise deploy that stack in `us-east-1`.

## Origin-verify header — designed, deferred (2026-08-20)

Closes the Cloudflare *and* CloudFront bypass in one template change (an `http-header` condition on
the listener rules; `cloudfront-alb-distribution` already *sends* the header, only enforcement is
missing). Not now — scope is Solr, and the internal ALB removes the need there. **Full design,
prerequisites and the honest limits: `git log -p TASKS.md`, section "Origin-verify header".**

- [ ] Adjacent and cheap: both listeners' `DefaultActions` forward to the empty `Deftarget` → 503.
  Make it a `fixed-response` 403; the 503 is only harmless by accident.

## Alerting

Cluster `1.1.0` gives `AlertTopic` + the `-AlertTopicArn` export in both regions; service `1.2.0`+
routes alarms to it. Test with `aws cloudwatch set-alarm-state` — it exercises the topic policy,
`sns publish` doesn't. `email` subscriptions need a confirmation click while CFN already says
`CREATE_COMPLETE`.

- [ ] **GuardDuty findings → `AlertTopic`** (EventBridge, severity ≥ 4), **before continuing the
  service rollout** or 21 stacks get updated twice. Test with `create-sample-findings`. Also give the
  account owner an IAM identity, or `Policy:IAMUser/RootCredentialUsage` recurs on every root login.
- [ ] **Slack — `chatbot-slack/index.template` written, blocked on one manual step.** One
  account-wide stack for both clusters; touches no alarm or service stack.
  - [ ] **A Slack workspace admin must authorize the AWS app once** (console → *Amazon Q Developer in
    chat applications*) to get `SlackWorkspaceId`. **Does Philipp have admin rights?** Check first:
    `aws chatbot describe-slack-workspaces --region us-east-2`.
  - [ ] Confirm the region — the Chatbot API seems to resolve only in `us-east-2`/`us-west-2`/
    `eu-west-1`. If so deploy in `eu-west-1` and note it in the README.
  - [ ] Deploy with full topic ARNs for both regions (exports don't cross regions) and
    `CAPABILITY_NAMED_IAM`. Private channel → the app must be invited or delivery fails silently.
  - **Fallback if the admin step stalls:** SNS → Lambda → webhook. Two stacks (topics are regional),
    URL in SSM `SecureString`, **Lambda outside the VPC**, DLQ required (SNS retries twice then drops
    silently). A plain `https` SNS subscription to a webhook does not work.
  - Per-channel either way, so per-client channels mean another relay plus a rule to split the stream.
  - Cloudflare blocks stay invisible from AWS — separate console, nothing on the topic.

## Solr

Probed 2026-08-20: **credential side closed, network side open.** Auth correctly enforced everywhere,
index holds public data only, logs clean, running 9.9.0. The single `labor` user — **plaintext in
WordPress `wp_options` (`wpsolr_solr_indexes`)**, also in the EFS and DB dumps, missed by the Aug-2026
rotation list — was split into `gwa_search` (query/index only) and a fresh admin secret.

- [ ] **Audit `wp_options` for other plaintext third-party credentials.** `gwa_search` lives in the
  same place, so assume it's compromised in any future WordPress breach — hence the split.
- [ ] **Confirm and close the ALB-direct bypass — the real remaining risk, untested.** If the ALB
  answers a `Host: suche.gwa.de` request, Cloudflare's WAF, rate limiting and DDoS shielding are
  sidestepped, leaving BasicAuth in front of a Java service with an RCE history.
  `curl -k -o /dev/null -w '%{http_code}' -H 'Host: suche.gwa.de' https://<alb-dns>/solr/` — `401`
  from Solr = bypass open; `404` from the ALB default = only the Cloudflare path works. Probe staging
  (`gwa-gut-sol-s`) the same way.
- [ ] **Verify Cloudflare SSL mode is Full (strict)** — Solr speaks plain HTTP, so the credential
  crosses the ALB→task hop in cleartext. The ALB already has an ACM cert.
- [ ] **Document the `security.json`** — auth works but is expressed nowhere in this repo, so the next
  image bump could silently remove the only thing in front of the index. Credential in Doppler/SSM.
- [ ] Consider a Cloudflare WAF rule on `/solr/` admin paths; keep Solr on the latest 9.9.x.
- The AWS WAF doesn't help (PHP rule groups, Java service), and upstream declines to treat Admin-UI
  XSS as vulnerabilities *because* they assume no exposure — "we run a patched 9.9" is not a defence.

### Fix: internal ALB (scope = Solr only), Paris first

- [x] **1. Internal ALB in the cluster stack** — `1.3.0`, Paris verified (private subnets, HTTP-only
  listener with a 404 default, exports `-InternalListenerArnHttp`/`-InternalAlbDns`). Frankfurt pending.
- [x] **2. No DNS record** — use the exported hostname, `ListenerRuleHost=*`. Trade-off: an ALB
  *replacement* changes the name and staleness in `wp_options`; rare, fails loudly.
- [x] **3. `ecsservice`: `ListenerArnOverride`** — shipped in `8c76965`, still `1.3.0`. Keeps the
  target group, so `AlarmAutoscaleScaleDown` still reads `HealthyHostCount`; `LoadbalancerRuleHttp` is
  conditioned on `NoListenerOverride` because the 80→443 redirect must not exist on an HTTP-only
  internal ALB. Not yet applied to any service — that is step 4.
- [ ] **4. Update `gwa-gut-sol-s`**, verify from an instance via SSM:
  `curl -u gwa_search:… 'http://<internal-alb-dns>/solr/<core>/select?q=*:*&rows=1'`
- [ ] **5. WordPress cutover** — WPSolr → Settings → Solr index: `http`, internal host, `80`,
  `/solr/<core>`, same credential; ping, then a front-end search. **Note the old values first.**
- [ ] **6. Remove the public exposure** (step 3 moves the rules, so it's gone on deploy), then delete
  the `suche.gwa.de` Cloudflare record — or leave it a week pointing nowhere as a canary.
- **Snags:** changing `ListenerArn` *replaces* the listener rule and CFN creates before deleting, so
  the target group is briefly on two load balancers — use a window. Health checks move to the internal
  ALB via `ECSHealthCheckPath`, which `/solr/` only satisfies via the static shell.
- Until cutover, **whitelist `suche.gwa.de` for Phase 4** — the app resolves it via NAT, so a `BLOCK`
  catch-all breaks search silently.
- [ ] **Record which services are meant to be internal.** `ecsservice` can't express a private service
  at all (`Target`/`LoadbalancerRule*` unconditional, `ListenerRuleHost` required, no `source-ip`
  condition anywhere, `SgPublicHttpHttps` open to `0.0.0.0/0`). `gwa-gut-sol-p` is next once Paris
  proves the pattern.

## LII26-96: Zero-Trust Outgoing Network Security

Per cluster: **Paris → Frankfurt.** Phase 1 (LII26-94) ✅ both regions, baselines 2026-07-16/17.
Remaining: LII26-93 (Ph. 2), LII26-95 (Ph. 3), LII26-92 (Ph. 4).

### Phase 2 — whitelist

- [ ] Run `DnsFireWallLogsSummary`, group ALERT'd domains by frequency, split legitimate from noise,
  aggregate by root domain. Wildcards match **one** level (`*.example.com` ≠ `foo.bar.example.com`).
- [ ] **Registry domains are the trap** — a `BLOCK` catch-all breaks the **image pull at the next task
  placement**, not the running container, so the Phase 4 application test passes while nothing can
  restart or scale.
  - **ECR is in `eu-central-1` for *both* regions** (verified across all 15 Paris stacks): needs
    `*.dkr.ecr.eu-central-1.amazonaws.com`, that region's API endpoint, and the layer-storage S3
    endpoints it redirects to — take hostnames from the ALERT logs, don't assume.
  - **Docker Hub** for `lab-ana-mat-p` (`matomo:5.8`) and `gwa-gut-sol-p` (`solr:9.9`):
    `registry-1.docker.io`, `auth.docker.io`, layer CDN. Plus `suche.gwa.de` until the Solr cutover.
- [ ] Update `DnsFirewallWhitelistDomains` and deploy; correlate GuardDuty findings with the DNS logs;
  record projected GuardDuty monthly cost. Optional: DNS ALERT data-flow sanity check per region.
- Cross-region pulls bill as NAT transfer per placement and a VPC endpoint can't help (wrong region);
  if it ever matters, replicate repositories into `eu-west-3`.

### Phase 3 — security groups

**Step A** ✅ Paris 2026-08-07, 28 days (result table in git history). The query's two defects
(inbound replies, NAT double-counting) were fixed 2026-08-14 but **not yet deployed to Paris**. The
128 apparent dead ports were our RSTs hitting inbound scanners; no egress rules needed.

- [ ] Run the analysis in Frankfurt, then `EnableEgressAnalysis=false` in **both** regions
- [ ] Identify `3724/TCP → 145.239.131.113` (OVH) from `10.1.3.7` — the last unknown

**Step B** ✅ 2026-08-07: hosts use Amazon Time Sync (invisible to flow logs), and all external
NTP/NTS-KE/SSH/OVH traffic comes from `10.1.3.7` = `lab-dev-llm-s-EC2`, a standalone box — so
`123/UDP`, `4460/TCP`, `22/TCP`, `3724/TCP` leave Step C entirely.

- [ ] `lab-dev-llm-s` needs its own egress policy — separate stack, tracked there.

**Step C — target egress set:**

| Rule | Destination | Why |
|---|---|---|
| 443/TCP | `0.0.0.0/0` | ~99% of egress; GuardDuty watches for anomalies |
| 80/TCP | `0.0.0.0/0` | OCSP/CRL — **dropping this breaks TLS validation** |
| 587/TCP | `95.217.210.26/32` | SMTP relay, from `10.1.3.45` |
| 4318/TCP | `149.248.216.54/32` | OTLP telemetry, from 3 of 9 hosts |
| 53/UDP+TCP | VPC CIDR **only** | internal DNS; closes the `8.8.8.8` bypass |

**⚠️ All three instance SGs must be restricted or this is a no-op** — `SgVpcMysqlAccess`,
`SgVpcLoadbalancerports` and `SgVpcEfsAccess` are all on the launch template, none defines
`SecurityGroupEgress`, and SG rules are additive. Restrict all three, or add one dedicated egress SG.

- [ ] **Fix the OTel agent's hardcoded `8.8.8.8` resolver first** — the `53 → VPC CIDR` rule blocks it
  on landing and it can't then reach its collector. One image deployed three times = one fix.
- [ ] Confirm the `80/TCP` destinations really are OCSP/CRL before allowing plaintext egress
- [ ] Delete the blanket `Egress: ALL → 0.0.0.0/0` and apply the table

**Step D.** `guardduty` already exports the zero-egress Quarantine SG, the execution role and detector ID.

- [ ] Lambda swapping an instance's SG to Quarantine + EventBridge rule on HIGH findings; test with
  sample findings and confirm the instance moved

### Phase 4 — BLOCK mode

- [ ] **First** add a `DnsFirewallCatchAllAction` parameter (`ALERT`/`BLOCK`, default `ALERT`) — the
  action is hardcoded, so a CLI flip is drift the next stack update silently reverts
- [ ] Re-run `DnsFireWallLogsSummary`, confirm no legitimate domain still ALERTs, then set `BLOCK`
- [ ] Test Lieferchat, Matomo, e-mail, time sync **and image pulls**; watch 48 h. Rollback = `ALERT`

## Cluster template — other

- [ ] **Instance refresh + launch-time AMI resolution.** Nothing replaces a running instance, so hosts
  drift — `dnf-automatic` installs security updates only and never reboots.
  - **`ImageId` must resolve at launch:** `{{resolve:ssm:…}}` is a *CloudFormation* reference and bakes
    a literal AMI into the LT, so a scheduled refresh relaunches the same image. Use
    `{"Fn::Sub": "resolve:ssm:${AmiSsmParameter}"}` — no braces around `resolve`. Side effect: the
    four-row AMI cascade disappears, so the README note needs rewriting.
  - **Paris canaries, Frankfurt runs what Paris validated.** Both resolving `recommended` independently
    would land Frankfurt on images Paris never ran. Paris → AWS's `…/recommended/image_id`;
    Frankfurt → `/labor/ecs-ami/al2023/production`, one explicit AMI ID we own. **Promotion is the
    gate:** after a clean week, read what Paris is *actually* running (`describe-instances` by ASG tag,
    not a re-read of `recommended`) and `put-parameter --overwrite`. Keep it manual.
  - **Schedule** via `AWS::Scheduler::Schedule` → `…aws-sdk:autoscaling:startInstanceRefresh`, no
    Lambda, gated behind `EnableScheduledInstanceRefresh`. Paris `cron(0 3 1,15 * ? *)` / Frankfurt
    `cron(0 3 8,22 * ? *)`, `Europe/Berlin` — alternating weeks, Paris first.
  - **Settings:** `MinHealthyPercentage: 100` + `Max 200` (at 1–2 instances terminate-first leaves a
    real hole), `InstanceWarmup: 300`, `SkipMatching: true`, `AlarmSpecification` on the
    `AlarmHttp5xxTarget` alarms, checkpoints + `BakeTime`. **No `AutoRollback`** for SSM-parameter LTs
    — the alarms still *fail* a refresh, they just won't revert what was replaced.
  - **`ManagedDraining` is `ENABLED`** in both regions from the ECS API default, and the design depends
    on it. **Don't add it to the template without a change set** — if CFN treats it as create-only the
    capacity provider is *replaced*, which is disruptive.
  - Keep `dnf-automatic` for the 0–14 day gap on host processes that restart; don't add
    `reboot = when-needed` — an unannounced reboot doesn't drain ECS tasks, a refresh does.
  - Scanner caveat: patches on disk + old kernel = every package-version scanner calls the CVE fixed.
    `rpm -q --last kernel` vs. `uname -r` is the honest check.
- [ ] **Gateway VPC Endpoint for S3** (`com.amazonaws.${AWS::Region}.s3` on `RoutetablePrivate`) — the
  saving is small; the reasons are that Step C can then match the S3 **managed prefix list** instead of
  `443 → 0.0.0.0/0` for ECR pulls, and EFS-restore uploads stop paying NAT. Interface endpoints cost
  more than the NAT they'd replace.
- [ ] **RDS: static shared master password**, no `EnableIAMDatabaseAuthentication`. IAM auth would give
  each task a revocable short-lived token; needs connection-string changes in every application.
- [ ] **`BackupRole` can't restore** (only `…ForBackup`); practice today is the console's account-wide
  `AWSBackupDefaultServiceRole`, created outside CFN. Keep the split or add a scoped restore role —
  record it either way.
- [ ] **Add `TemplateVersion` to the remaining templates** (four have it): `backup-vaults-mirror`, the
  leaf templates, `efs-access`. Each needs its own fleet-query filter.
- [ ] **`scripts/bootstrap-cluster.sh`** — a new cluster is four stacks in a required order
  (`alb-logs-bucket` → `ecscluster-vpc-rds-asg` → `guardduty`, skipped if a detector exists →
  `backup-vaults-mirror` cross-region), and what goes wrong is the order and hand-copied ARNs. **Weigh
  against frequency** — at once a year the README is already the checklist. Merging the satellites
  isn't the alternative: one detector per account *per region*, `alb-logs-bucket` is `Retain`-policied.

## Detection and inventory

- [ ] **Evaluate GuardDuty Runtime Monitoring** (`RUNTIME_MONITORING` `DISABLED`) — the only thing that
  records *execution*; ALB, DNS, flow and container logs can't see a file written inside a container,
  and the writable layer is discarded on the next deploy. Also flags the container-escape precondition
  for the EFS item below. Check ECS-on-EC2 support, agent footprint on `t3.small`, and **pricing — it
  bills per vCPU-hour**, unlike the base detector.
- [ ] **Enable `EBS_MALWARE_PROTECTION`** via the template, not the console. Does **not** cover
  application data: EBS only, so EFS is never scanned, and only after a finding already exists.
- [ ] **Per service, map which paths are image vs. EFS** — for the `-typ` TYPO3 and Matomo services it
  matters whether extension dirs are in the image (scanned, not persistent) or on EFS (unscanned).
- [ ] **Know what's running before a CVE lands** — nothing maps services to image versions, so "are we
  affected?" starts with `describe-task-definition` across 36 stacks. Options: ECR enhanced scanning,
  a documented inventory, or extending `TemplateVersion` to the app image.
- 14-day retention everywhere, so alerting inside the window matters more than later analysis.

## EFS

### Root-mount exposure — decided: nothing further for now

The fstab mount of the EFS **root** was removed 2026-08-19 (cluster `1.2.0`; needs an instance refresh
to take effect on running hosts). What remains needs a container breakout, and neither the SG nor a
partial IAM policy can gate it (`bridge` mode means the agent mounts over the *host* ENI; IAM has no
condition key for the mounted path). Runtime Monitoring above is the better marginal spend.

- [ ] Enforcement, if ever wanted, is per-service EFS access points + `Iam: ENABLED` then one
  `FileSystemPolicy` flip — reversible per stack until the flip, and it would ride the fleet rollout
  that is owed anyway. **Design, the `PosixUser` trap and the AWS Backup restore-path consequence:
  `git log -p TASKS.md`, section "EFS root-mount exposure".**

### `efs-access` stack — written 2026-08-18, never deployed or tested

Throwaway stack for pulling data off EFS: EC2 in a public subnet, EFS at `/mnt/efs`, SSH/SFTP to one
operator CIDR, then delete. Deciding property: **no copy of the data lands outside EFS**. An access
point enforces `PosixUid`/`PosixGid`, which is what makes the files readable at all.

- [ ] **Re-apply the `SgVpcEfsAccess` export patch**
  (`ecscluster-vpc-rds-asg/efs-access/SgVpcEfsAccess-export.patch`, dropped so the SNS-only `1.1.0`
  could deploy alone) and deploy the cluster to both regions — **otherwise the mount silently has no
  security group.** Fold into the `1.3.0` deploy.
- [ ] **First deploy, all untested:** that the `accesspoint=fsap-…` fstab option mounts; that the
  AL2023 SSM AMI alias resolves; that the `shutdown -h +$(( … ))` arithmetic works (CFN can't
  multiply, so it's done in bash); and that the access point's `RootDirectory` **already exists** — no
  `CreationInfo`, so a missing `EfsSubPath` fails the mount instead of creating the directory.
- [ ] **Confirm which file system belongs to which cluster before exposing one** —
  `fs-03238bbb2aabd19a4` (73.1 GiB) and `fs-030d8ad5d3cf5e7b5` (73.9 GiB) in Frankfurt, unconfirmed.
- Rejected transports (detail in git history): S3 staging and DataSync (second copy of personal data,
  DSGVO minimisation), Transfer Family on EFS (good but overkill), VPN + NFS (`cp` has no resume at
  73 GiB), Instance Connect Endpoint (also a managed relay). The original slowness was SSM Session
  Manager, a single framed WebSocket — EFS itself is not the bottleneck.

### No lifecycle policy

All ~73 GiB per file system stays in Standard indefinitely across four file systems — the largest
storage cost lever in the stack.

- [ ] Check access patterns, then add `TransitionToIA: AFTER_30_DAYS` +
  `TransitionToPrimaryStorageClass: AFTER_1_ACCESS`. IA raises first-byte latency and charges per GB
  retrieved — fine for old uploads, counterproductive if something walks the whole tree on a cron.

## S3 and IAM

Audit 2026-08-20, all 17 buckets: **no accidental public exposure.** Two public by design
(`labor.media`, `s3-ado-lea-rad-p` — website buckets), 13 fully protected, 2 without a BPA backstop.

- [ ] **Apply BPA to the two `cf-templates-ingduevmfvm0-*` buckets** (`eu-central-1`, `us-east-2`) —
  the only two where a stray policy would make them public with nothing to stop it. Zero risk; CFN
  only reaches them in-account. They're live infrastructure (every cluster deploy stages the 104 KB
  template there) and nothing prunes them. Optional: a 30–90 day lifecycle expiry, and `--s3-bucket`
  on CLI deploys.
- [ ] **Read `S3FS-Policy` and `AzureAD_SSOUserRole_Policy`** — a blanket `s3:*` on `*` makes every
  bucket setting irrelevant. First suggests s3fs-fuse (commonly far too broad), second is what humans
  get through SSO. Also check AWS-managed grants, which `--scope Local` misses.
- [ ] **Check what's inside the two public buckets** — the risk is a dump, backup or `.env` uploaded
  alongside the assets.
- [ ] **Enable IAM Access Analyzer** (free) — the only thing evaluating policy, ACL and BPA together,
  and it catches cross-account grants, which are exposure without ever showing `IsPublic=true`.
- [ ] **Consider AWS Config drift rules** (`s3-bucket-public-read-prohibited` and siblings) →
  `AlertTopic`; detection substitutes for prevention, since account-level BPA can't be enabled.
- **Don't enable account-level BPA** — it would immediately break the two website buckets. Only
  possible once those move behind CloudFront + OAC (which would also give them TLS). A project.
- Presigned URLs are undetectable retroactively — only CloudTrail data events record use, and they're off.

### `alb-logs-bucket` hardening (both regions deployed)

- [ ] **TLS-only deny** — BPA blocks public access but not an authenticated caller over plain HTTP.
  `Deny`/`Principal: "*"`/`s3:*` with `aws:SecureTransport=false`; `"*"` in a *Deny* is safe.
- [ ] **Declare `OwnershipControls: BucketOwnerEnforced`** — live state is correct only because it's
  the current S3 default.
- [ ] **Add `aws:SourceAccount`** to the log-delivery statement as a confused-deputy guard.

## Cluster dashboard

Metric widgets only today. Nothing here is blocking; it is all about shortening the next investigation.

- [ ] **An `alarm` widget listing every cluster alarm** — 18 alarms across four stacks, no single view.
  Cheapest useful addition: a list of ARNs, no metric maths.
- [ ] **HTTP status widget** (`HTTPCode_Target_2XX/4XX/5XX_Count` + `HTTPCode_ELB_5XX_Count`) using
  **`Sum`, never `Average`** — the ALB emits one datapoint of value `1` per response, so `Average` is
  a flat line at 1.0 that looks broken (cost real time on 2026-08-19).
- [ ] **`RequestCount` with an anomaly band** — the blind spot: traffic swallowed upstream leaves 4xx
  and 5xx at zero, CPU low, health checks passing and every alarm green while the site is down.
- [ ] Then `TargetResponseTime` p90/p99, a WAF `CountedRequests`/`BlockedRequests`-per-`Rule` widget,
  the 4xx band via `ANOMALY_DETECTION_BAND`, and a template-version `custom` widget (viewers need
  `lambda:InvokeFunction` — custom widgets run with the *viewer's* credentials). **Details:
  `git log -p TASKS.md`, section "Cluster dashboard".**
- A malformed widget renders as an error box instead of failing the deploy — add one at a time and look.

## Settled — don't reopen

- **AWS Firewall Manager: no** (2026-08-19). Multi-account governance needing Organizations, an admin
  account and Config everywhere in scope. This is one account with CFN as source of truth, so FMS
  would apply rules out of band. Revisit only with a multi-account structure.
- **`AlarmHttp5xxElb`** — shipped in service `1.2.0`, removed in `1.3.0`; LB-side 5xx isn't a case we
  need alarmed. Stacks on `1.2.0` lose it on their next update.
- **WAF and the internal ALB as separate stacks** — both merged into the cluster template; split
  stacks are for things optional per cluster and iterated often.
- **A private hosted zone in the cluster template** — the `-InternalAlbDns` export is better discovery.
- **Cloudflare-range allowlists as the *only* control** — their ranges are shared by every tenant.
- **Cloud Map instead of an internal ALB** — `bridge` mode + dynamic ports needs SRV records most HTTP
  clients can't resolve, and it breaks the scale-in alarm's `HealthyHostCount`.
