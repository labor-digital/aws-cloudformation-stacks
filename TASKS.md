# Open tasks

Concrete next actions only. An entry is a title plus the one thing that will bite — the reasoning belongs
in the parameter's own `Description` or `Metadata.Note`, where it is read at the moment the value is set,
and the evidence belongs in the commit message.

- Template rationale: [README.md](README.md)
- Query blocks behind the measurements: [queries.md](queries.md)
- Anything older: `git log -p TASKS.md`. The 2026-09-08 incident reconstruction and the rollout logs were
  removed on 2026-09-15 once their findings had landed in the templates; they are in that history.

---

## Cluster state

> Paris read live **2026-09-11**, Frankfurt **2026-09-07**. The only place in the repo describing deployed
> stacks — it goes stale silently, so re-read before trusting it.

| | Paris `labc-eu-w3` (staging) | Frankfurt `labc-eu-c1` (prod) |
|---|---|---|
| Cluster template | `1.7.0` | `1.5.0` |
| `ecsservice` | `1.6.0`, 15/15 | `1.0.1` ×1, `1.2.0` ×1, no `TemplateVersion` ×17 |
| WAF rule actions | `KnownBadInputs` + `SQLi` **block**, rest `count` | all five `count` |
| DNS Firewall | catch-all `ALERT`, 48 domains, redirection `TRUST` | catch-all `ALERT`, 14 domains |
| Egress | `SgEgress` exists, `EgressPolicy=open` | not present |
| Cluster alarms | 11; WAF-KnownBadInputs, WAF-SQLi, dns-firewall, vpc-rejected, rds-slow-queries notify | 9; dns-firewall, rds-error, rds-slow-queries notify |
| Service alarms | HighCpu/HighMemory/5xx `alert`, 4xx band `dashboard`, Low* `off` | pre-`1.3.0`, no switches |
| `ImageRegressionGuard` | on all 15, live | on none of the 19 |
| `WafClientIpHeader` | empty | empty |
| `EnableEgressAnalysis` | **still `true`** — bills per GB, baseline period long over | `false`, never enabled |
| Known drift | `DnsQueryLoggingConfig`, `Rdscl`, `Rdsinstance1` | same four, plus log retention raised by hand |

---

## Next: arm Paris

Four parameter updates, in this order, with time between them. Each is reversible by setting the parameter
back. **Test each with a forced deployment, not by loading a site** — a blocked resolution or a missing
port does not disturb a running container, it breaks the next task placement.

- [ ] **1. Attach `SgEgress` to the running instances.** It arrives via the launch template and the ASG has
  no `UpdatePolicy`, so a template update does not roll the fleet. Instances on an older launch template
  version never receive it, while neutralising the three old groups hits their ENIs at once — flipping
  before every instance carries it removes **all** outbound access from those instances.
- [ ] **2. `EgressPolicy=restricted`,** then read the REJECT flow log. It is a signal only from this point
  on, because legitimate traffic stops producing rejections.
- [ ] **3. Add the LibreChat endpoints to `DnsFirewallWhitelistDomains`** from `librechat.yaml` and the MCP
  server list. No log can show an endpoint nobody used during the observation window.
- [ ] **WAF: `WordPressRulesAction=block` und `WordPressRulesAlarmAction=alert`.** Unabhängig von den vier
  Schritten oben, reines Parameter-Update. Messung 2026-09-15 über 14 Tage Pariser WAF-Logs: 54 Treffer
  gegen 17.742 bei `CommonRuleSet`, und **ausnahmslos Exploit-Verkehr** — ein `wlwmanifest.xml`-Sweep über
  durchprobierte Unterverzeichnisse, `/xmlrpc.php`, `/crossdomain.xml`. Der einzige Treffer auf einem
  echten WordPress-Endpunkt, `/wp-admin/admin-post.php`, entpuppte sich als vier Plugin-Exploits in einer
  Scan-Sitzung: BackupBuddy-LFI auf `/etc/passwd` (CVE-2022-31474), `do_reset_wordpress=1` (WP Reset),
  `yp_remote_get` (CVE-2019-11223) und ein Webshell-Parameter. Kein legitimer Aufruf darunter.
  Der WP-Reset-Versuch wurde **gezählt, nicht geblockt** — das ist das Argument.
  Alarmschwelle 20 gegen gemessene 54 in zwei Wochen lässt Luft; `alert` dazu, damit ein Fehlalarm nach
  dem Umschalten auffällt.

- [ ] **4. `DnsFirewallCatchAllAction=BLOCK`,** once the ALERT rate has been at zero for a day. The
  blocked-query alarm comes into existence with it and notifies on the first refusal.

## Next: Frankfurt

Carries everything built since `1.5.0` — alarm switches, `ProjectToken` as a resolver property, the
`ImageRegressionGuard`, `ElbHttp5xxAlarm`, `RdsConnectionsAlarm`, `RdsLongQueryTime`, the DNS Firewall
parameters, `SgEgress`. Pre-flight blocks are in [queries.md](queries.md).

- [ ] **Measure egress first.** `EnableEgressAnalysis=true` for 7–14 days, then off again — it bills per GB.
  The port set is unmeasured there, so `EgressExtraRules` cannot be filled responsibly yet, and its default
  carries Paris addresses that would pin Frankfurt's mail to the wrong relay.
- [ ] **Cluster to `1.7.0`,** then the 19 services. **Pass every `*AlarmAction` explicitly** — parameters
  new in a version have no previous value, so `deploy` takes the template default and silences alarms that
  were notifying.
- [ ] **Read each service's `EnableHttp4xxAnomalyAlarm` first.** `false` maps to
  `ServiceHttp4xxAnomalyAlarmAction=dashboard`, not `off` — the parameter is gone in `1.6.0` and the
  three-way switch is what it always wanted to be.
- [ ] **Check the images still exist in ECR** before touching anything. A tag reaped by the lifecycle policy
  is invisible while the task runs and fails the next start with `CannotPullContainerError`.
- [ ] **Replace the three instances still carrying the EFS root mount:** `i-0edc996a3a34c27e0`,
  `i-03781a7452fa2e145`, `i-049dd7042c56d561e` — the three on `ami-00a84437cf2b97861`. Drain, terminate
  without decrementing desired capacity. **After** the service rollout, not during.
- [ ] **`1.5.0` goes directly, never `1.4.0`.** And verify the non-ECR skip there: `gwa-gut-sol-p` runs
  `solr:9.9`, `lab-ana-mat-p` runs `matomo:5.8`, and the guard must skip them rather than fail.

---

## Open decisions

Team calls, not tasks. Each blocks something above.

### 1. Lock the origin down to Cloudflare
`SgPublicHttpHttps` is open to `0.0.0.0/0`, so the ALB stays directly reachable and `cf-connecting-ip` is
forgeable — which defeats the rate limit and any header check. Blocked on an inventory of which sites are
proxied and which are direct. The ranges are shared by every Cloudflare tenant, so this is a layer, not a
control.

### 2. Apache request lifetime
The ALB gives up at 60 s, Apache does not — that asymmetry is what turned a slow request into an outage.
`Timeout 60` plus `mod_reqtimeout` in `docker-base-images-v2`. Needs confirmation that no admin task,
import or `wp-cron` job legitimately runs longer.

### 3. WordPress access at GWA
Who holds admin, whether editors need it, and whether `/wp-admin` should be reachable from the internet.

### 4. Whether to pursue WAF promotion further

Only two groups are still open, and for opposite reasons.

`CommonRuleSet` fires on legitimate traffic and needs `RuleActionOverrides` first — 17,742 counted matches
in 14 days against 54 for WordPress, a factor of 330. `RateLimit` cannot be promoted at all while
`WafClientIpHeader` is empty: CloudFormation refuses the combination, because without the header a block
would lock out the proxy for every site behind it. That one is really the Cloudflare question (decision 1),
not a WAF question.

Weakest-justified item of the security work — the Apache timeout and the origin lockdown matter more.

### 5. Customer communication about the incident
What GWA is told, and by whom.

### 6. The `aut-web-web-p` catch-all
An unexplained listener rule. Decide whether it is needed.

### 7. Aurora instance class

Prices measured 2026-09-08, eu-central-1, Aurora MySQL on-demand, single instance. `max_connections` from
the template's own formula `log2(mem/805306368)*60`.

| Class | RAM | PI | USD/month | vs today | `max_connections` |
|---|---|---|---|---|---|
| `db.t3.medium` — running | 4 GiB | **no** | 70.08 | — | ~145 |
| `db.t4g.medium` | 4 GiB | yes | **62.05** | **−8.03** | ~145 |
| `db.t4g.large` | 8 GiB | yes | *unread* | | ~205 |
| `db.r6g.large` | 16 GiB | yes | 228.49 | +158.41 | ~265 |

**The easy half.** `db.t4g.medium` is the same size on Graviton, costs **8.03 USD/month less** (−11.5 %,
~96 USD/year) **and** supports Performance Insights, which `db.t3.medium` does not — cheaper and more
capable. Verified against the account with `describe-orderable-db-instance-options`, not from
documentation: Aurora excludes t2 and t3 from PI, not t4g. The ARM caveat does not apply, because no code
of ours runs on a database instance. (It very much would apply to the cluster's EC2 instances.)

**The real trade-off** is the connection budget: only the r-class removes CPU credits and lifts
`max_connections` to ~265, at **+158.41 USD/month**. Weigh that against what happened — an estate-wide
`1040` event on 2026-09-04, and one service holding two thirds of the budget for 34 minutes on 2026-09-08 —
and against AWS positioning t-classes on Aurora as "development and test" while ~20 production services
run on one.

⚠️ **The cost is not the hard part, the window is.** `RdsInstanceType` has
`AllowedValues: ["db.t3.medium"]`, so any move is a template change first. And **with a single writer and
no reader, a class change is a restart of the only instance, not a failover** — all ~20 services lose the
database at once. The way around it: add a reader already on the target class, wait for sync, **fail over**
(~30 s), change the old writer, drop the extra reader. Bundle everything that wants a restart into the same
window. Paris first, and let it run a few days before Frankfurt.

**Unread and needed first:** prices for `db.t3.large` and `db.t4g.large`, and the **effective**
`max_connections` off the running instance — every figure above is arithmetic, not measurement.

### 8. `10.1.3.7` — the LibreChat box in the Paris VPC
Not an ECS instance; runs the internal LibreChat, used productively. The DNS Firewall associates per VPC so
it is inside the enforcement boundary whether or not anyone intended it, while `SgEgress` reaches it not at
all. Either whitelist its dependencies, or move it to its own VPC. It has no alarms of any kind — if it
fails, only its users find out.

### 9. Filtering the connection, not the lookup
Nothing built reaches an outbound TLS connection to a hardcoded IP, and DNS-over-HTTPS bypasses both the
`53` rule and the DNS Firewall while looking like ordinary TLS. Closing that needs Network Firewall reading
the SNI (~290 USD/month per AZ) or a forward proxy. Declining is legitimate; it should be recorded as a
decision rather than assumed away.

---

## Egress — was die Default-Adressen sind

`EgressExtraRules` liefert `587:95.217.210.26/32,4318:149.248.216.54/32` aus. Beide sind in Paris über 28
Tage ACCEPT-Flow-Logs gemessen, und beide brauchen eine eigene Regel nur, weil sie nicht auf `443` liegen.

- **`95.217.210.26:587` — das SMTP-Relay.** Ein Ziel, erreicht von drei Cluster-Instanzen. Hetzner-Adresse.
  Nicht geprüft: welchen *Namen* die Anwendungen auflösen und ob die Adresse stabil genug für ein `/32`
  ist — sonst müsste es der Netzblock sein. Alles andere auf 25/465/587 im selben Ergebnis lief in die
  Gegenrichtung: Scans auf die öffentliche NAT-IP, die nach einem offenen Relay suchen.
- **`149.248.216.54:4318` — OTLP über HTTP,** der Collector `fly-otel-collector-prod.fly.dev`. Gehört zum
  **Webpage-Builder**, nicht zu einem separaten Agenten: dieselben Hosts lösen `oidc.fly.io`,
  `api.machines.dev`, `api.depot.dev` und Kundenprojekte unter `*.fly.dev` auf. Die schwächste der vier
  Regeln — ein `/32` auf einen fremden SaaS-Host, dessen Adresse nicht zugesichert ist; zieht sie um,
  bricht die Telemetrie **still**. Den Endpunkt auf `443` zu legen würde die Regel ganz entfallen lassen.
- **Loses Ende:** es gab auch VPC-internen 4318-Verkehr (`10.1.4.186 → 10.1.1.76`, `10.1.3.59 →
  10.1.2.21`, `10.1.4.228 → 10.1.2.51`). Nicht verfolgt.

## `ecscluster-vpc-rds-asg`

- [ ] **Promote alarms from `dashboard` to `alert`** — per alarm, off measured volume, not as one decision.
- [ ] **`rds-slow-queries` was inert until `RdsLongQueryTime=2`.** Re-read whether it now has datapoints,
  and whether the threshold of 5 still fits.
- [ ] **Investigate the REJECT spike on 2026-09-05** — 61,234 rejected flows against a ~40,000 baseline.
- [ ] **Resolve the `EngineVersion` contradiction.** The template pins a version *and* sets
  `AutoMinorVersionUpgrade: true`, so RDS drifts ahead and the next update touching any RDS property fails.
- [ ] **`AscalegroupDesSize` fights managed scaling.** `MaxValue: 15` while the ASG may run to 30, and
  Frankfurt sits at 14 — one scale-out between change-set creation and execution drops two instances' tasks
  without draining, because `ManagedTerminationProtection` is `DISABLED`.
- [ ] **Decide the log retention conflict** — Frankfurt only; two groups raised by hand against the
  hardcoded 14 days.
- [ ] **Enforce the origin-verify header on the listener rules.** `cloudfront-alb-distribution` already
  sends it; only enforcement is missing.
- [ ] **Listener default action to `fixed-response` 403.** Today both forward to the empty `Deftarget`,
  which yields 503 — harmless by accident.
- [ ] **`CommonRuleSet` exclusions before it can block:** `SizeRestrictions_BODY` (every backend upload),
  `GenericRFI_BODY` (pasted URLs), `CrossSiteScripting_BODY` (rich-text editors), `NoUserAgent_HEADER`
  (API clients, cron).
- [ ] **Protect login endpoints.** A wrong-password POST is well-formed, so signature groups miss it and
  2,000/IP/5 min still allows 300 attempts a minute. A failed-login metric filter per service log group
  counts what no rate limit measures.
- [ ] **Launch-time AMI resolution + scheduled instance refresh.** Nothing replaces a running instance, so
  hosts drift indefinitely. `dnf-automatic` runs with `upgrade_type = security` and `apply_updates = yes`,
  but `reboot` is unset and therefore `never` — kernel and glibc patches are **installed and never become
  active**, and the ASG has no `UpdatePolicy`, no refresh, and a new AMI reaches only newly launched
  instances. The blocker for a scheduled refresh: `{{resolve:ssm:…}}` is a *CloudFormation* reference and
  bakes a literal AMI into the launch template, so a refresh would relaunch the same image; it must become
  `{"Fn::Sub": "resolve:ssm:${AmiSsmParameter}"}`.
- [ ] **Gateway VPC Endpoint for S3.** Small saving; the point is that egress rules can then match the S3
  managed prefix list instead of `443 → 0.0.0.0/0`.
- [ ] **Narrow `443` with interface VPC endpoints** — ECR, SSM, logs, ECS, Secrets Manager. ~100–130
  USD/month across two AZs. Measure the AWS share of `443` first; the egress analysis answers it.
- [ ] **Drop the 110 redundant `DependsOn` entries** (`cfn-lint` `W3005`: 88 + 13 + 9). Own commit, no other
  change. **Check each** — ordering that exists for a reason outside the property graph has to stay.
- [ ] **`RdsMasterPassword` as a `NoEcho` parameter** (`W1011`) — `{{resolve:secretsmanager:…}}` keeps it
  out of the stack's parameter set. Smaller than IAM database auth and independent of it.
- [ ] **Two `cfn-lint` findings in `ecscluster-ext-additional-cluster`:** `W2506` (`ImageId` as a plain
  `String`) and `W3697` (a resource type in maintenance mode).
- [ ] **Custom widget for template versions across stacks.** Not a metric, so it needs a `"type": "custom"`
  widget and a Lambda calling `DescribeStacks`. Image drift and `SgEgress` membership fit the same widget.
- [ ] **Metric widgets still missing, no Lambda needed:** WAF counted requests per rule group, ALB
  `HTTPCode_ELB_5XX_Count` beside `HTTPCode_Target_5XX_Count`, running-versus-desired tasks per service.
- [ ] **EFS lifecycle policy** — everything stays in Standard indefinitely.
- [ ] **`BackupRole` has no restore path.** Backup works, restore is unexpressed — decide which.
- [ ] **RDS: static shared master password, no `EnableIAMDatabaseAuthentication`.** IAM auth gives each task
  a revocable short-lived token but needs connection-string changes in every application.
- [ ] **DNS Firewall: split the allow rule into a trusted and an inspected list.** A rule group can hold
  several rules, each with its own list and redirection setting. The trigger is a specific entry whose chain
  somebody does not want to trust — no current entry qualifies.

## `ecsservice`

- [ ] **Every deploy of a single-task service has a gap.** `MinimumHealthyPercent` is hardcoded at `50`, so
  `floor(1 × 0.5) = 0` — ECS may stop the only task before starting its replacement, and the new one needs
  `2 × 45 s` to take traffic. Built once as `1.7.0` and reverted the same day when it turned out not to be
  the cause of the alarms that prompted it. Rebuild as `ServiceMinimumHealthyPercent` (default 100) plus
  `ServiceSlowStartSeconds` (default 0, target-group attribute).
- [ ] **CPU alarms fire on JVM startup.** `gwa-gut-sol-s` idles at 0.4 % and peaks at 29 % average for one
  minute while Solr loads — against a threshold of 20 %, every restart of that service pages. Per-stack fix
  is `ServiceHighCpuThreshold=50`; the general fix is `EvaluationPeriods: 2`, which is hardcoded at 1.
- [ ] **`lab-dev-ema-s`: `/favicon.ico` returns 500 on every page view.** No static favicon, so the request
  falls through to the Slim catch-all, which reads the path as a template directory and fatals. Fix in the
  application. Five alarms a day for one line.
- [ ] **Move `DOPPLER_TOKEN` from `Environment` to `Secrets`.** **Remove the `ProjectToken` resolver
  property in the same change** — otherwise the plaintext path the migration exists to close stays open.
  It largely self-enforces: dropping the parameter makes the `Ref` invalid.
- [ ] **Harden the `ImageResolver`.** On Update after a failed create the service no longer exists and the
  Lambda fails hard; if it exists but never became healthy, the broken image is reanimated on every update.
- [ ] **Set a real default for the 4xx anomaly band width.** Currently a guess; graph the metric and pick.
- [ ] **Network anomaly detection** — `NetworkIn`/`NetworkOut` alarms with their own parameters.
- [ ] **The template cannot express a private service.** `Target` and `LoadbalancerRule*` are unconditional,
  so every service gets a public listener rule whether it needs one or not.

## `ecscluster-vpc-rds-asg/guardduty`

- [ ] **Route findings to `AlertTopic`** (EventBridge rule, severity ≥ 4). Findings currently reach the
  console and nowhere else — detection without delivery.
- [ ] **Quarantine automation.** The Quarantine SG exists with zero egress; the Lambda that swaps an
  instance's groups and its EventBridge trigger do not. Note an instance cannot be moved to another VPC —
  the primary ENI is bound to its subnet — so the SG swap *is* the mechanism, and an isolated VPC is for
  the forensic copy.
- [ ] **`EBS_MALWARE_PROTECTION` via the template,** not the console. EBS only; EFS is never covered.
- [ ] **Evaluate Runtime Monitoring** (`RUNTIME_MONITORING` is `DISABLED`) — the only thing that records
  what happens inside a container.

## `ecscluster-vpc-rds-asg/alb-logs-bucket`

- [ ] **TLS-only `Deny`** (`aws:SecureTransport=false`).
- [ ] **`OwnershipControls: BucketOwnerEnforced`** — the live state is correct only by default.
- [ ] **`aws:SourceAccount` on the log-delivery statement** as a confused-deputy guard.

## Other templates

- [ ] **`chatbot-slack` does not exist.** Slack delivery is unimplemented and an `https` subscription to a
  Slack webhook does not work.
- [ ] **`efs-access` does not exist** — designed, never written. A throwaway stack for pulling data off EFS.
- [ ] **`TemplateVersion` output on `backup-vaults-mirror` and the leaf templates** — four templates have
  no way to tell which version a stack runs.
- [ ] **`cloudfront-alb-distribution` scope trap:** `EnableWAF` defaults `true`, but a `CLOUDFRONT`-scoped
  WebACL only exists in `us-east-1`.

## Outside the templates

- [ ] **Confirm and close the ALB-direct bypass for Solr** — the real remaining risk from the incident,
  still untested.
- [ ] **Record which sites are Cloudflare-proxied and which are direct.** Nothing distinguishes them, which
  blocks both the origin lockdown and `WafClientIpHeader`.
- [ ] **Audit `wp_options` for plaintext third-party credentials** — the Solr query user lives there.
- [ ] **Verify Cloudflare SSL mode is Full (strict).** Solr speaks plain HTTP.
- [ ] **Document Solr's `security.json`** — auth works but is expressed nowhere in this repo.
- [ ] **Map services to image versions.** Nothing answers "are we affected" when a CVE lands.
- [ ] **Read `S3FS-Policy` and `AzureAD_SSOUserRole_Policy`** — a blanket `s3:*` on `*`.
- [ ] **Apply BPA to the two `cf-templates-*` buckets** and check what is in them.
- [ ] **Enable IAM Access Analyzer** (free) — the only thing evaluating policy, ACL and BPA together.

---

## Security posture

Everything that observes is built; almost nothing that prevents or delivers is.

| Measure | Built? |
|---|---|
| WAF in front of the ALB | ✅ six rules, each switchable |
| WAF blocking | ⚠️ `KnownBadInputs` + `SQLi` in Paris only |
| DNS Firewall audit / enforcement | ✅ / ⚠️ switchable from `1.7.0`, still `ALERT` everywhere |
| VPC Flow Logs | ✅ REJECT always, ACCEPT on demand |
| Egress hardening | ⚠️ built in `1.7.0`, `open` everywhere |
| GuardDuty detector / findings delivered | ✅ / ❌ console only |
| Quarantine SG / automation | ✅ / ❌ |
| Malware + runtime monitoring | ❌ |
| Service 4xx/5xx alarms | ✅ from `1.6.0` |
| Alerts actually delivered | ⚠️ Paris 5 of 11, Frankfurt 3 of 9 |
| ALB reachable only via the proxy | ❌ open to `0.0.0.0/0`, no origin header, default action forwards |
| Secrets out of the task definition | ❌ `DOPPLER_TOKEN` is plaintext |
| RDS auth | ❌ static shared password |
| ALB log bucket hardening | ❌ three items above |

Two consequences worth stating: **DNS `BLOCK` while egress is unrestricted buys little**, because an
application that skips resolution and dials an IP is unaffected — the two belong in one step. And
**detection without delivery is the quietest failure mode there is.**

---

## Settled — don't reopen

- **The 2026-09-08 outage was not the database.** Slow-query log empty with delivery verified, and the
  error log shows the direction of causation.
- **Health checks do not traverse the WebACL.** No `Allow` rule for the health check path is needed.
- **`max_connections` is ~138–145**, not ~100: the RDS parameter formula uses log base 2, and the
  template's `×60` sits a third above the Aurora default.
- **Wildcards in DNS Firewall domain lists cover any depth,** not one label — but not the apex.
- **`ALLOW` is not written to the query log.** An allowed name looks exactly like an uninspected one.
- **AWS service endpoints are inspected** and allowed by `*.amazonaws.com`; they are not exempt.
- **`AWS::LanguageExtensions` is ruled out.** It breaks *Use existing template* updates, which is how every
  promotion here is done.
- **`ecsservice` standalone `SecurityGroupEgress` resources are ruled out** — AWS advises against mixing
  them with the inline property.
