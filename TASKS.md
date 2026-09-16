# Open tasks

Concrete next actions only. An entry is a title plus the one thing that will bite — the reasoning belongs
in the parameter's own `Description` or `Metadata.Note`, where it is read at the moment the value is set,
and the evidence belongs in the commit message.

- Template rationale: [README.md](README.md)
- Anything older: `git log -p TASKS.md`. The 2026-09-08 incident reconstruction and the rollout logs were
  removed on 2026-09-15 once their findings had landed in the templates; they are in that history.

---

## Cluster state

> Paris read live **2026-09-11**, Frankfurt **2026-09-07**. The only place in the repo describing deployed
> stacks — it goes stale silently, so re-read before trusting it.

| | Paris `labc-eu-w3` (staging) | Frankfurt `labc-eu-c1` (prod) |
|---|---|---|
| Cluster template | `1.7.2` | `1.5.0` |
| `ecsservice` | `1.6.0`, 15/15 | `1.0.1` ×1, `1.2.0` ×1, no `TemplateVersion` ×17 |
| WAF rule actions | `KnownBadInputs` + `SQLi` + `WordPress` **block**, rest `count` | all five `count` |
| DNS Firewall | catch-all `ALERT`, 54 domains, redirection `TRUST` | catch-all `ALERT`, 14 domains |
| Egress | `SgEgress` exists, `EgressPolicy=open` | not present |
| Cluster alarms | 11; WAF-KnownBadInputs, WAF-SQLi, dns-firewall, vpc-rejected, rds-slow-queries notify | 9; dns-firewall, rds-error, rds-slow-queries notify |
| Service alarms | HighCpu/HighMemory/5xx `alert`, 4xx band `dashboard`, Low* `off` | pre-`1.3.0`, no switches |
| `ImageRegressionGuard` | on all 15, live | on none of the 19 |
| `WafClientIpHeader` | empty | empty |
| `EnableEgressAnalysis` | **still `true`** — bills per GB, baseline period long over | `true`, running since ~2026-09 |
| Known drift | `DnsQueryLoggingConfig`, `Rdscl`, `Rdsinstance1` | same four, plus log retention raised by hand |

---

## Next: arm Paris

- [x] **`1.7.2` deployed 2026-09-16.** Only empties the `EgressExtraRules` default; the value now lives in
  the local runbook and in the stack, not in the public template. The console pre-fills it from the stack,
  so on an *existing* stack it cannot be forgotten — the risk is a newly created stack, Frankfurt's first
  `1.7.x` deploy, and any `deploy` that omits it from `--parameter-overrides`.
  The change set listed five changes, four of them CloudFormation being conservative: `Launchtemplate`
  (`ParameterReference`, never recreates), and `Ascalegroup` → `CapacityProvider` → the association
  cascading from `Fn::GetAtt Launchtemplate.LatestVersionNumber`. Nothing was replaced or reset.

Four parameter updates, in this order, with time between them. Each is reversible by setting the parameter
back. **Test each with a forced deployment, not by loading a site** — a blocked resolution or a missing
port does not disturb a running container, it breaks the next task placement.

> Measured 2026-09-15 over 14 days of Paris logs, both sides: the DNS query log for what the catch-all
> would refuse, and the ACCEPT flow log for what `SgEgress` would drop. Both are only readable while
> `EnableEgressAnalysis` is on.

- [x] **0. NTP rule in `SgEgress`** — `1.7.1` deployed 2026-09-16. Inert until step 2: the rule sits in the
  `EgressRestricted` branch, so with `EgressPolicy=open` it changes nothing yet. The egress measurement found
  **44,553 flows on 123/UDP from 25 instances to 15 destinations**: `10.1.3.7` to Canonical, the other 24
  to ten AWS addresses in eu-west-2, i.e. `time.aws.com`. Under `restricted` that stopped dead, and it
  could not be repaired through the parameter either — all four `EgressExtraRules` slots are hardwired to
  `IpProtocol: tcp`, so `123:0.0.0.0/0` would have produced a TCP rule and nothing else. Now a fixed
  `123/UDP → 0.0.0.0/0` rule next to the two 53 ones. The failure mode it avoids is the nasty kind: clock
  drift first, then TLS handshakes and signature checks failing hours later with nothing pointing back at
  the parameter that was flipped.
- [x] **1. `SgEgress` on every instance** — done 2026-09-15 23:35–23:44, confirmed 2026-09-16: nine ASG
  instances, all on launch template v6, all carrying `SgEgress`; nothing left draining. The fleet table found **5 of 9**
  instances still on launch template v5 without `SgEgress`; going to `restricted` then would have stripped
  all outbound access from exactly those five, since the three old groups get neutralised and they had no
  replacement rule. Fixed by terminating the five by hand, one at a time — the ASG points at v6 (fixed
  number, not `$Default`, which is still 1), so every replacement carries the group. A full instance
  refresh would have replaced the four healthy ones too; and had one been used, `MinHealthyPercentage: 80`
  is the right value, not 90 — AWS rounds the healthy count up, so 90 % of 9 is 9 and nothing may
  terminate. Draining is covered: the terminations went through `MidTerminatingLifecycleAction`, so a
  lifecycle hook holds each instance while tasks move.
  The mechanism behind it, worth keeping: `SgEgress` arrives via the launch template and the ASG has no
  `UpdatePolicy`, so a template update never rolls the fleet by itself — while neutralising the three old
  groups hits every ENI carrying them at once. Rule changes *inside* `SgEgress` do apply immediately to
  every ENI that already has it, so there is no window where an instance is restricted but lacks the NTP
  rule; only group membership lags.
  `10.1.3.7` is the one exception and needs nothing: `lab-dev-llm-s-EC2` (LibreChat), no ASG, no launch
  template, only its own security group, none of the three cluster ones. The fleet table confirmed no other
  standalone instance carries them either.
- [ ] **2. `EgressPolicy=restricted`,** then read the REJECT flow log. It is a signal only from this point
  on, because legitimate traffic stops producing rejections. Two measured flows will disappear, both to be
  confirmed as intended beforehand: **`3306/TCP`** to an external MySQL in eu-central-1 — `dwk-zer-app-s`
  gets that host from Doppler at container start and it belongs to a cluster we no longer run, so **fix the
  Doppler value first**; afterwards a failure would come from the security group and be indistinguishable
  from the old one. And **`53/UDP → 8.8.8.8`** — 4 flows, last on 02.09., from an ASG instance — which is
  the point of the exercise, not a casualty. The measured `80/TCP` and `4460/TCP` came exclusively from
  `10.1.3.7`, which carries none of the affected groups, so neither is in scope.
- [x] **3. Whitelist completed** — 54 entries live since 2026-09-16. The diff of the 48 previous
  entries against the 50 alerted names left exactly **8 uncovered, and they are precisely the 8 still
  alerting after the 1.7.0 deploy** — two independent methods, same answer. The other 42 with 1,050 queries
  did not stop, they got covered. New: `docker.io`, `prettylinks.com`, `*.bfl.ai`, `*.brave.com`,
  `langchain4j.dev`, `*.huggingface.co` → 54 entries.
  ⚠️ **`docker.io` was the dangerous one.** `*.docker.io` was on the list but a wildcard does not cover the
  apex, and three instances had queried the apex. Under `BLOCK` that breaks the next image pull — invisibly,
  because running containers never notice. `slack.com`, `statamic.com`, `wordpress.org` and `complianz.io`
  were already double-listed, so the pattern was understood; `docker.io` was the gap.
  Left off deliberately: `164.5.75.34.bc.googleusercontent.com`, a forward lookup of a reverse name from a
  client that verifies rDNS.
  ⚠️ **The two hardening steps cut across different sets.** The DNS Firewall is associated at **VPC level**,
  so it covers LibreChat too; `SgEgress` reaches only instances from the launch template, so it does not.
  `api.eu.bfl.ai`, `delivery.eu2.bfl.ai` and `api.search.brave.com` all came from one source — that box.
  Going to `BLOCK` without those three entries would have broken LibreChat while leaving the cluster
  untouched. Still open: the LibreChat endpoints from `librechat.yaml` and the MCP server
  list — no log can show an endpoint nobody used during the observation window.
- [x] **WAF WordPress scharf, 2026-09-16.** `WordPressRulesAction` stand bereits auf `block`; umgestellt
  wurde `WordPressRulesAlarmAction` von `dashboard` auf `alert` — im Change Set sichtbar als
  `ActionsEnabled` am `AlarmWafWordPress`, verifiziert mit dem AlertTopic als Ziel. Grundlage: Messung über
  14 Tage Pariser WAF-Logs, 54 Treffer gegen 17.742 bei `CommonRuleSet`, ausnahmslos Exploit-Verkehr —
  `wlwmanifest.xml`-Sweep, `/xmlrpc.php`, `/crossdomain.xml`, und auf dem einzigen echten
  WordPress-Endpunkt vier Plugin-Exploits in einer Scan-Sitzung (BackupBuddy-LFI CVE-2022-31474,
  `do_reset_wordpress=1`, `yp_remote_get` CVE-2019-11223, ein Webshell-Parameter). Der WP-Reset-Versuch war
  gezählt, nicht geblockt. Alarmschwelle 20 gegen 54 in zwei Wochen lässt Luft.
- [ ] **4. `DnsFirewallCatchAllAction=BLOCK`,** once the ALERT rate has been at zero for a day. The
  blocked-query alarm comes into existence with it and notifies on the first refusal.

## Next: Frankfurt

Carries everything built since `1.5.0` — alarm switches, `ProjectToken` as a resolver property, the
`ImageRegressionGuard`, `ElbHttp5xxAlarm`, `RdsConnectionsAlarm`, `RdsLongQueryTime`, the DNS Firewall
parameters, `SgEgress`.

- [ ] **Read the egress measurement — it has been running for a while, so this is possible now.** That
  removes what was the long pole: `EgressExtraRules` can be filled from data rather than guessed. Query in
  `frankfurt-preflight.md` §7b. Turn `EnableEgressAnalysis` off again afterwards, it bills per GB. Since
  `1.7.2` the parameter defaults to `0:0.0.0.0/0`, so nothing wrong gets pinned in the meantime — but
  equally, nothing right appears by itself.
- [ ] **Cluster to `1.7.2`,** then the 19 services. **Pass every `*AlarmAction` explicitly, and
  `EgressExtraRules` with it** — parameters new in a version have no previous value, so the template default
  applies: for the alarm actions that silences alarms that were notifying, and for the egress rules it
  leaves SMTP and OTLP without a rule the moment `restricted` is switched on. Paris needs the same
  treatment from now on; the value is no longer in the template, so "use existing value" is the only thing
  still carrying it there.
- [ ] **Read each service's `EnableHttp4xxAnomalyAlarm` first.** `false` maps to
  `ServiceHttp4xxAnomalyAlarmAction=dashboard`, not `off` — the parameter is gone in `1.6.0` and the
  three-way switch is what it always wanted to be.
- [ ] **Check the images before touching anything.** Not just that they exist: compare each running task's
  resolved `imageDigest` against the digest its tag points to *today*. A deployment holds the digest it
  resolved when it was created, so a tag that has since moved leaves it pointing at an image that is
  invisible while the task runs and fails the next start with `CannotPullContainerError`.
- [ ] **Align `AscalegroupDesSize` with the live `DesiredCapacity` before the cluster update.** The ASG's
  desired size is a template parameter while ECS managed scaling moves the real one, so the two drift apart
  and a stack update can reset it — with no `UpdatePolicy` and `ManagedTerminationProtection: DISABLED`,
  that terminates an instance and moves its tasks. In Paris on 2026-09-16 the gap was 7 against 8.
- [ ] **Replace the three instances still carrying the EFS root mount:** `i-0edc996a3a34c27e0`,
  `i-03781a7452fa2e145`, `i-049dd7042c56d561e` — the three on `ami-00a84437cf2b97861`. Drain, terminate
  without decrementing desired capacity. **After** the service rollout, not during.
- [ ] **Do not arm Frankfurt until Paris has been armed and survived it.** The template can go in now —
  `EgressPolicy`, `DnsFirewallCatchAllAction` and every `*Action` default to open/audit, so `1.7.2` is inert
  on arrival. Steps 2 and 4 of the Paris list are still untried anywhere; production is the wrong place to
  find out what they break.
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

## Egress — welche Zusatzregeln es gibt und warum

`EgressExtraRules` hat seit `1.7.2` den Default `0:0.0.0.0/0`, also **keine** Zusatzregeln. Die echten
Adressen stehen bewusst nicht mehr im Template und nicht hier: das Repository ist öffentlich. Sie liegen im
lokalen Runbook, und der Parameter wird **bei jedem Deployment in jeder Region explizit mitgegeben** —
genau wie die `*AlarmAction`-Parameter, nie über „vorhandenen Wert verwenden".

Zwei Ziele brauchen eine Regel, beide in Paris über 28 Tage ACCEPT-Flow-Logs gemessen, und beide nur
deshalb, weil sie nicht auf `443` liegen:

- **Port 587 — das SMTP-Relay.** Ein Ziel, erreicht von drei Cluster-Instanzen. Hetzner-Adresse.
  Nicht geprüft: welchen *Namen* die Anwendungen auflösen und ob die Adresse stabil genug für ein `/32`
  ist — sonst müsste es der Netzblock sein. Alles andere auf 25/465/587 im selben Ergebnis lief in die
  Gegenrichtung: Scans auf die öffentliche NAT-IP, die nach einem offenen Relay suchen.
- **Port 4318 — OTLP über HTTP,** der Collector `fly-otel-collector-prod.fly.dev`. Gehört zum
  **Webpage-Builder**, nicht zu einem separaten Agenten: dieselben Hosts lösen `oidc.fly.io`,
  `api.machines.dev`, `api.depot.dev` und Kundenprojekte unter `*.fly.dev` auf. Die schwächste der vier
  Regeln — ein `/32` auf einen fremden SaaS-Host, dessen Adresse nicht zugesichert ist; zieht sie um,
  bricht die Telemetrie **still**. Den Endpunkt auf `443` zu legen würde die Regel ganz entfallen lassen.
- **Loses Ende:** es gab auch VPC-internen 4318-Verkehr (`10.1.4.186 → 10.1.1.76`, `10.1.3.59 →
  10.1.2.21`, `10.1.4.228 → 10.1.2.51`). Nicht verfolgt.

## `ecscluster-vpc-rds-asg`

- [ ] **`DesiredCapacity` hängt am Parameter, während Managed Scaling die Größe verschiebt.** Die ASG hat
  `"DesiredCapacity": {"Ref": "AscalegroupDesSize"}`, und der Capacity Provider hat `ManagedScaling`
  auf `TargetCapacity: 80`. Nach jedem Skalierungsvorgang laufen Parameter und Realität auseinander —
  am 2026-09-16 stand der Stack auf `7`, die ASG auf `8`. Jedes Stack-Update bringt dann die Frage mit,
  ob CloudFormation den Wert zurücksetzt und dabei eine Instanz terminiert. Im Change Set taucht
  `DesiredCapacity` nicht auf, solange der Parameter unverändert bleibt, aber verlassen würde ich mich
  darauf nicht. Vorerst behelfsmäßig gelöst, indem der Parameter vor dem Update auf den Istwert gesetzt
  wird — das ist Handarbeit vor jedem Deploy und keine Lösung.
  Der saubere Weg wäre, `DesiredCapacity` gar nicht im Template zu führen, sobald Managed Scaling aktiv
  ist. Die ASG hat keine `UpdatePolicy`, `ManagedTerminationProtection` ist `DISABLED`; ein ungewollter
  Scale-in trifft also direkt laufende Tasks. Analog zu `ServiceDesiredCount` in `ecsservice`, wo dieselbe
  Kopplung schon als Falle dokumentiert ist.

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
