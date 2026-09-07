# Open tasks

Pending changes to the templates, plus one record of what the clusters currently run. Template
rationale lives in [README.md](README.md); the analysis behind these items — designs, measurements,
incident reconstructions — is in `git log -p TASKS.md`, the retired CHANGELOG in
`git show 81b6c0e:CHANGELOG.md`.

## Cluster state

> Paris read live **2026-09-06**; cluster on `1.5.0` since 2026-09-05, all 15 service stacks on `1.5.0` since 2026-09-06. Frankfurt has not been re-read since 2026-08-22 and is left blank
> rather than repeated from stale notes. This is the only place in the repo that describes deployed stacks.

| | Paris `labc-eu-w3` (staging) | Frankfurt `labc-eu-c1` (prod) |
|---|---|---|
| Cluster template version | `1.5.0` (2026-09-05) | ? |
| `ecsservice` versions | `1.5.0`, 15/15 (2026-09-06) | ? |
| `WafClientIpHeader` | **empty** | ? |
| WAF rule actions | all five on `count` | ? |
| WAF log delivery | ✅ ingesting, last 2026-09-04 21:50 UTC | verified 2026-08-22 |
| WAF volume | `CommonRuleSet` 549 counted / 24 h ≈ 2 per 5 min | ? |
| `EnableEgressAnalysis` | **still `true`** — ACCEPT log group exists and bills per GB | ? |
| DNS Firewall | 14 whitelist entries, catch-all still `ALERT` | ? |
| Cluster alarms | 9 exist, **all `ActionsEnabled: false`** — nothing notifies | ? |
| `ImageRegressionGuard` | on all 15 services and **live** — the ECR region bug is fixed | not deployed |
| Log retention drift | none, all groups at 14 | raised by hand |
| Other drift | `DnsQueryLoggingConfig`, `Rdscl`, `Rdsinstance1` — `Ascalegroup` was a moving value, aligned at update time | same four |

**After the `1.5.0` deploy the cluster is silent.** All four pre-existing alarms were switched from
notifying to `dashboard` by the template default, and the five new WAF alarms were created silent. Nothing
reaches `AlertEmail` from the cluster stack any more. Promote individual alarms to `alert` once their
threshold has been read against real traffic — and decide this deliberately for Frankfurt, where a silent
cluster over weeks is a different proposition than in staging.

**The `ecsservice` rollout was non-disruptive.** All 15 stacks were updated with
`SkipImageResolver=false`; the resolver read each service's running image and returned it unchanged, so
CloudFormation registered **no new task definition revision** and no service redeployed — every running
task predates the rollout and kept its revision. Verified three ways afterwards: task-definition image
against a pre-rollout snapshot, the image the running containers actually use, and the revision plus
`startedAt` of each task. The `MinimumHealthyPercent: 50` gap that single-task services would otherwise
see never occurred. The `ImageRegressionGuard` did not fire for its own introduction — its
EventBridge rule is created by the same change set that touches the service, with no ordering guarantee.
From the next deployment onward it is effective.

**Note for Frankfurt:** only five of the six WAF surge alarms are created while `WafClientIpHeader` is
empty — `RateLimitForwardedIpSurgeAlarm` is conditional on it. The two obsolete parameters
(`WafBlockedRequestAlarmThreshold`, `WafLogRetentionDays`) drop out by themselves; the console simply
stops offering them.

```bash
aws cloudformation describe-stacks --region <r> --stack-name <cluster> \
  --query "Stacks[0].{v:Outputs[?OutputKey=='TemplateVersion'].OutputValue|[0],p:Parameters}"
aws cloudformation describe-stacks --region <r> \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName,version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" \
  --output table
aws cloudformation detect-stack-drift --region <r> --stack-name <cluster>
```

`ecsservice` `1.6.0` is written but not deployed anywhere; Paris runs `1.5.0` on all 15.

---

## `ecscluster-vpc-rds-asg`

- [ ] **Promote alarms from `dashboard` to `alert` — evidence read 2026-09-06, Paris.** Not one decision
  but four, because the nine alarms fall into distinct cases:
  - **`dns-firewall-alert-surge` and `rds-error` are ready.** Both have real data and have never fired.
    DNS Firewall logs 22–348 ALERT queries per *day*, i.e. well under one per 5-minute window against a
    threshold of 100 — two orders of magnitude of headroom. `ErrorCount` publishes (sparsely, 5 of 14
    days) and is flat `0` against threshold `0`, so any `[ERROR]` line would notify.
  - **`vpc-rejected-surge` must not be promoted as configured.** 12 `to ALARM` transitions in three
    weeks, spread evenly and continuing after the `1.5.0` change (last 2026-09-06 05:41) — roughly one
    mail every two days. Average is ~140 rejects per 5-minute window against a threshold of 500. Raise
    the threshold off the measured distribution first (`Q52` in `paris-state.txt`).
  - **The five WAF alarms have one day of history** (created 2026-09-05). Their `0`s carry no weight yet.
  - **`rds-slow-queries` cannot fire at all.** See the item below.
- [ ] **`rds-slow-queries` is inert — decide whether that is acceptable.** The slow-query log group
  exists but holds **0 bytes**, so `SlowQueryCount` has never published a single datapoint, and with
  `TreatMissingData: notBreaching` the alarm sits permanently on `OK`. The cause is *not* a missing
  switch: the template does set `slow_query_log: "1"` on the cluster parameter group. The remaining
  candidate is `long_query_time`, which the template leaves at the Aurora default of 10 s — so the log
  is empty because nothing ran that long. The alarm is therefore technically functional and practically
  mute, and its threshold (5 such queries per 5 min) is unreachable. Lowering `long_query_time` to 1–2 s
  would give the log content to calibrate against. **Deliberately deferred 2026-09-06** — noted so the
  `OK` state is not mistaken for evidence of a healthy database.
- [ ] **Investigate the REJECT spike on 2026-09-05.** 61,234 rejected flows that day against ~40,000 on
  each of the 13 days around it. Noticed while reading the alarm history, not chased.

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
  Prerequisite for Phase 4. **`BlockResponse` has to come with it** — the property is absent from the
  rule group today because it is only meaningful for `BLOCK`, and Route 53 requires it once the action
  is `BLOCK`. Set `NXDOMAIN` so applications get a clean "domain not found" instead of a timeout;
  `NODATA` and `OVERRIDE` are the alternatives.
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
  - **`123/UDP` is not needed — verified on the hosts, not just inferred.** `chronyc -n sources` on all
    seven Paris instances (2026-09-05) shows `169.254.169.123` as the **selected** source (`^*`, poll 16 s)
    on every one. The four AWS public NTP servers are configured fallbacks (`^-`, poll 256-1024 s) and
    are what produced the ~27,000 flows in the log. Link-local traffic is answered by the hypervisor and
    is **not subject to security groups**, so dropping `123/UDP` removes the fallbacks and leaves the
    working clock untouched. Optional cleanup: remove the public servers from the chrony config as well,
    which stops the polling entirely — costs the redundancy, gains a quieter egress profile.
  - **`4460/TCP` (NTS-KE) comes only from the standalone box**, never from cluster instances — stays out.
  - **`80/TCP` was used by no cluster instance in 28 days**, only by the standalone Ubuntu box (apt over
    HTTP to Canonical, AWS and Cloudflare). The OCSP/CRL argument is theoretical here: keep the rule as
    cheap insurance, or drop it and accept that a sporadic OCSP fetch over plain HTTP would fail.
  - **`53/UDP` to `8.8.8.8` confirmed from three cluster hosts** — and exactly those three are the ones
    sending OTLP to the external collector, so the attribution to the OTel agent holds. (A fourth source
    in the 4318 data turned out to be the NAT gateway ENI, i.e. the same traffic counted again after
    translation; ALB ENIs show up there for the same reason. No additional emitter.) The fix is a real
    blocker for the VPC-CIDR-only rule, not a theoretical one.
  - **But "one image, deployed three times" is wrong** (checked 2026-09-05): all 15 Paris services run
    **distinct** ECR repositories, none appears twice. With ~2 tasks per instance the three hosts carry up
    to six different services, so the emitter is not identified yet. Fastest routes: ask the collector at
    `149.248.216.54` which `service.name`s report to it, or find which Doppler projects set an
    `OTEL_EXPORTER_OTLP_*` key — the endpoint is not in the task definition, so it has to come from there.
    Only then is it clear whether the fix is one base image or several.
  - The SMTP relay has a **fixed** address, so `587/TCP` gets that host, not `0.0.0.0/0`.
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
   (`3724/TCP → 145.239.131.113`, OVH — **did not occur in Paris at all in the 28 days to 2026-09-05**,
   so probably gone; confirm against Frankfurt, then close) and on the OTel resolver fix.
3. **Phase 4 — flip to `BLOCK`.** Requires the `DnsFirewallCatchAllAction` parameter above. Re-run
   `DnsFireWallLogsSummary`, confirm no legitimate domain still ALERTs, then set `BLOCK`. Test the
   applications, e-mail, time sync **and image pulls**; watch 48 h. Rollback is `ALERT`.

## `ecsservice`

- [x] **`1.5.0` rolled to Paris** (2026-09-06, all 15 stacks, template-only, all parameters kept).
  Nothing moved: identical task-definition revision *and* image on all 15 afterwards, and no task
  restarted — the oldest `startedAt` still predates the rollout. That is the resolver behaving as
  designed, since CloudFormation invokes a custom resource only when one of its properties changes and
  a template swap changes none of them.

  What `1.5.0` fixes, and how it was accepted:
  `1.4.0`'s guard was inert in Paris — its Lambda built the ECR client without a region, so it looked in
  the cluster's region (`eu-west-3`) while the repositories live in `eu-central-1`, and every check past
  the "same image" branch died on `RepositoryNotFoundException` and was skipped silently. Found
  2026-09-05 by forcing a real regression on `lab-dev-ema-s`; a forced redeployment alone could not have
  shown it, because that path returns before ECR is touched. `1.5.0` derives region and account from the
  image reference, raises both Lambdas to `MemorySize: 256` (the guard used 96 of 128 MB on the
  *early-return* path), lets a deliberately changed `InitialDockerImage` win over the running image
  (detected via `OldResourceProperties`, so a targeted deploy no longer needs the `SkipImageResolver=true`
  detour), and logs in every branch which image it picked and why.
  **Accepted 2026-09-05/06 on `lab-dev-ema-s`** in six updates: the template-only update left the
  resolver untouched; an `ECSHealthCheckGracePeriod` change hit the ECS branch and kept the running image;
  a changed `InitialDockerImage` won twice, once without effect and once registering a new revision; the
  guard ran cross-region cleanly, published on a deliberately provoked regression and reached
  `AlertEmail`, and stayed silent on the way forward; a final grace-period change proved the ECS branch
  still works after the operator branch had been exercised.
  Two mechanics worth remembering: the guard hangs off an EventBridge rule on
  `SERVICE_DEPLOYMENT_IN_PROGRESS`, so it stays out of any update that does not change the image, and it
  publishes to SNS directly rather than through a CloudWatch alarm, so `ActionsEnabled: false` does not
  mute it.

- [ ] **Frankfurt gets `1.5.0` directly, never `1.4.0`.** The ECR region bug does not bite there since
  cluster and registry share a region, but under `1.4.0` passing `InitialDockerImage` alongside
  `SkipImageResolver=false` is **inert**: the parameter wakes the resolver (it *is* a trigger property)
  and the resolver then discards the value that triggered it, reading ECS instead. Paris' `1.4.0` rollout
  ended up correct only because the value passed happened to equal what the resolver reads anyway.

- [ ] **Verify the non-ECR skip in Frankfurt.** `1.5.0` makes the guard skip images outside ECR instead
  of failing on them. Paris could not prove it: the only such stack is `gwa-gut-sol-s` (`solr:9.9`), and
  it runs at `desiredCount=0`, so no deployment event ever reaches the guard.

- [x] **`ProjectToken` is a resolver property as of `1.6.0`** (built 2026-09-07, not yet rolled out).
  Tested 2026-09-07 on `lab-dev-ema-s` with a throwaway template variant: the long-standing claim that
  CloudFormation refuses `NoEcho` values as custom resource properties is **wrong**. It accepts them,
  hands the value to the Lambda **in plaintext** (`present-53chars`, not `masked`), and a rotation of
  `ProjectToken` alone **does** invoke the resolver — old and new values are both visible, so the diff is
  detected. One property line would close regression case 1 outright.
  The test also produced the case live: the cached resolver value was a day old
  (`…9c76916a`) while the pipeline had moved the service to `…468f466f`. Because this update woke the
  resolver, CloudFormation picked up the current image. A `ProjectToken`-only rotation under the shipped
  template would have written the stale one back.
  **Exposure question settled 2026-09-07:** a change set that touches the `ImageResolver` reports
  `ProjectToken` as `****` in both `BeforeContext` and `AfterContext` (`describe-change-set
  --include-property-values`). CloudFormation masks the value in *outputs* while passing it in the clear
  to the custom resource, which matches the documentation. So the property adds **no surface with a new
  audience** — only the Lambda event, which is not persisted and is reachable only by someone who
  already has `ecs:DescribeTaskDefinition` and can read the token there in plaintext.
  **The remaining trap is ordering:** adding the property and later moving the token to `Secrets` would
  leave a plaintext path the migration was meant to remove. It largely self-closes — if the migration
  replaces the `ProjectToken` parameter, `{"Ref": "ProjectToken"}` becomes an invalid reference and the
  template fails validation. Only a migration that *keeps* the parameter is dangerous; rule that variant
  out in the migration ticket below. The corrected reasoning sits in the `ImageResolver` `Metadata.Note`
  and in the README; the full test log is in `noecho-probe.txt`.
  `1.6.0` adds the one property line, bumps `TemplateVersion`, and rewrites the `ProjectToken`
  description — it carried a warning that a standalone rotation reverts the image, which is no longer
  true from `1.6.0` on and stays documented for `1.5.0` and earlier.

  **Checked and consciously not closed** (2026-09-07): with `1.6.0` all seven task-affecting parameters
  are resolver properties, and the only `Fn::If` in the task block hangs off `ContainerCommand`, which is
  one. Two non-parameter inputs remain. `TaskRole.Arn` is deterministic (`${AWS::StackName}-TaskRole`)
  and cannot change without a new stack. `Fn::ImportValue: ${ClusterStackName}-Efs` feeds
  `FilesystemId` directly, so replacing the cluster's EFS would rewrite the task definition in all 15
  service stacks at once while no resolver property changes — case 1, fifteen times over. Passing the
  import as an extra resolver property would close it; judged not worth it. Related: **removing the EFS
  volume from the template is itself a case 2** — it changes the task block without touching a property,
  so that change has to carry a fresh `InitialDockerImage`.

- [ ] **Roll `1.6.0` to Paris**, 15 stacks. Same shape as the `1.5.0` rollout: template-only, all
  parameters kept. This one *will* wake the resolver on every stack, because the property set changes —
  so unlike `1.5.0` expect a new task-definition revision and a rolling deployment wherever the cached
  value has fallen behind the running image. That is the point, not a side effect: it also clears the
  accumulated drift. `lab-dev-ema-s` still carries the throwaway `noecho-test.template` with
  `ECSHealthCheckGracePeriod: 210`; rolling `1.6.0` there with the parameter back at `180` replaces both
  in one step, after which `ecsservice/noecho-test.template` can be deleted.
- [ ] **Move `DOPPLER_TOKEN` from `Environment` to `Secrets`** (SSM Parameter Store or Secrets Manager).
  **One change, three problems:** the token stops being a plaintext value readable via
  `ecs:DescribeTaskDefinition`; rotation becomes an SSM update instead of a stack update; and
  `ProjectToken` stops affecting the task definition, which permanently closes the ImageResolver blind
  spot instead of working around it. If the parameter *name* is passed as a stack parameter, add it to
  the resolver's properties — a name is not secret.
- [ ] **Harden the ImageResolver** — on Update after a failed create the service no longer exists,
  `describe_services` finds nothing and the update hard-fails. ~4 lines of fallback to
  `InitialDockerImage`.
- [ ] **Images outside ECR stay uncovered by the guard.** Fixed in `1.5.0` to skip them cleanly instead
  of raising, but skipped is skipped: Solr's `solr:9.9` gets no regression check. It additionally runs on
  a **mutable tag**, so a moved upstream tag changes the image on the next task start with nothing to
  notice it. Either pin by digest, mirror into ECR, or accept it knowingly.
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

- [ ] **Confirm and close the ALB-direct bypass for Solr — the real remaining risk, untested.**
  **Has to be done in Frankfurt:** `gwa-gut-sol-s` runs at `desiredCount=0` in Paris (checked
  2026-09-05) — deliberately off, so the probe cannot be answered there. If the
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
  affected?" starts with `describe-task-definition` across every stack. The manual recipe now exists in
  `paris-state.txt` (stack → image → ECR push date, three loops); what is missing is having it run
  regularly and somewhere readable. Measured in Paris 2026-09-05: image ages spread from one week to
  four months, all still present in ECR.
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
- **EFS root-mount exposure: nothing further for now.** The fstab root mount was removed 2026-08-19
  (cluster `1.2.0`); **Paris verified clean on all hosts 2026-09-05** after the last pre-change instance
  was drained and replaced. Frankfurt has not been checked — run the same `AWS-RunShellScript` sweep
  (`grep -c efs /etc/fstab`) across every instance there before assuming it, one host in Paris had
  survived six weeks of scaling.
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
