# Open tasks

Pending changes to the templates, plus one record of what the clusters currently run. Template
rationale lives in [README.md](README.md); the analysis behind these items — designs, measurements,
incident reconstructions — is in `git log -p TASKS.md`, the retired CHANGELOG in
`git show 81b6c0e:CHANGELOG.md`.

The measurements behind the sections below were taken with the queries in
[Query appendix](#query-appendix) at the end of this file. They are kept because the CloudWatch Logs
Insights syntax is far easier to copy than to rewrite, and because a claim here should be checkable
without reconstructing how it was produced.

## Cluster state

> Paris read live **2026-09-09**; cluster and all 15 service stacks on `1.6.0` since 2026-09-09.
> Frankfurt read live **2026-09-07**, cluster raised to `1.5.0` the same day. This is the only place in the repo that describes deployed stacks.

| | Paris `labc-eu-w3` (staging) | Frankfurt `labc-eu-c1` (prod) |
|---|---|---|
| Cluster template version | `1.6.0` (2026-09-09) | `1.5.0` (2026-09-07) |
| `ecsservice` versions | `1.6.0`, 15/15 (2026-09-09) | `1.0.1` ×1, `1.2.0` ×1, **no `TemplateVersion` output** ×17 (all last touched 2026-07-08) |
| `WafClientIpHeader` | **empty** | **empty** |
| WAF rule actions | `KnownBadInputs` and `SQLi` on **`block`** since 2026-09-09; `CommonRuleSet`, `WordPress`, `RateLimit` on `count` | all five on `count` |
| WAF log delivery | ✅ ingesting, last 2026-09-04 21:50 UTC | verified 2026-08-22 |
| WAF volume | `CommonRuleSet` 549 counted / 24 h ≈ 2 per 5 min | ? |
| `EnableEgressAnalysis` | **still `true`** — ACCEPT log group exists and bills per GB | `false`, never enabled |
| DNS Firewall | 14 whitelist entries, catch-all still `ALERT` | ? |
| Cluster alarms | 11 exist; `AlarmWafKnownBadInputs`, `AlarmWafSQLi`, `dns-firewall`, `vpc-rejected-surge`, `rds-slow-queries` notify — the 3 remaining WAF ones plus `rds-error`, `elb-5xx`, `rds-connections` are `dashboard` | 9 exist; `dns-firewall`, `rds-error`, `rds-slow-queries` notify, the 5 WAF ones and `vpc-rejected-surge` are silent |
| `ImageRegressionGuard` | on all 15 services and **live** — the ECR region bug is fixed | **not deployed on any of the 19** (all have an `ImageResolver`, none the guard) |
| Log retention drift | none, all groups at 14 | raised by hand |
| Other drift | `DnsQueryLoggingConfig`, `Rdscl`, `Rdsinstance1` — `Ascalegroup` was a moving value, aligned at update time | same four |

**Paris was silent until 2026-09-09, Frankfurt never was.** In Paris the `1.5.0` deploy took the template
defaults, so all four pre-existing alarms went from notifying to `dashboard` and the five new WAF alarms
were created silent — nothing from that cluster stack reached `AlertEmail` for four days. Closed on
2026-09-09. Frankfurt was deployed 2026-09-07 with the switches
set deliberately, off the Paris evidence plus a Frankfurt noise measurement: `vpc-rejected-surge` produced
25 of 50 state transitions there and is the entire mail problem, while `dns-firewall-alert-surge`,
`rds-error` and `rds-slow-queries` had 0, 1 and 0. So the three quiet ones stayed on `alert` and only
`vpc-rejected-surge` went to `dashboard`, which removes the noise without giving up coverage during the
service rollout. Blanket silence was considered and rejected: `ActionsEnabled` only gates delivery, so an
evaluation period gains nothing from it.

**The `ecsservice` rollout was non-disruptive.** All 15 stacks were updated with
`SkipImageResolver=false`; the resolver read each service's running image and returned it unchanged, so
CloudFormation registered **no new task definition revision** and no service redeployed — every running
task predates the rollout and kept its revision. Verified three ways afterwards: task-definition image
against a pre-rollout snapshot, the image the running containers actually use, and the revision plus
`startedAt` of each task. The `MinimumHealthyPercent: 50` gap that single-task services would otherwise
see never occurred. The `ImageRegressionGuard` did not fire for its own introduction — its
EventBridge rule is created by the same change set that touches the service, with no ordering guarantee.
From the next deployment onward it is effective.

**The Frankfurt cluster deploy matched Paris exactly:** 13 changes — five `Add` for the WAF surge alarms
(five, not six, because `RateLimitForwardedIpSurgeAlarm` is conditional on `WafClientIpHeader`), four
`Modify` on the existing alarms, four for the AMI cascade. No `Remove` rows, since `EnableEgressAnalysis`
was never on there. Nothing was replaced and nothing moved: 14 instances and 32 tasks before and after.
The `Ascalegroup` carries no `UpdatePolicy`, so a changed launch template version does not roll instances —
existing ones keep the old version and only new instances get the new AMI.

```bash
aws cloudformation describe-stacks --region <r> --stack-name <cluster> \
  --query "Stacks[0].{v:Outputs[?OutputKey=='TemplateVersion'].OutputValue|[0],p:Parameters}"
aws cloudformation describe-stacks --region <r> \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName,version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" \
  --output table
aws cloudformation detect-stack-drift --region <r> --stack-name <cluster>
```

**The one thing that will bite the Frankfurt rollout: `aws cloudformation deploy` has no previous value
for a parameter that is new in the target template.** For parameters the deployed stack already carries,
it silently reuses the existing value; for parameters the stack has never seen, the **template default**
applies. All six `Service*AlarmAction` switches and the two cluster ones are new in `1.6.0`, and their
defaults are `dashboard` and `off`, while `1.5.0` left `ActionsEnabled` unset and therefore notifying.
**Deploying `1.6.0` with defaults silences every service alarm.** Confirmed in Paris on `lab-dev-ema-s`,
which was deployed on 2026-09-07 without them and ran with three dead alarms for two days — the proof was
that re-deploying with the actions set produced an extra `Modify` row on `AlarmHttp5xxTarget`, a resource
that depends on nothing else in the change set and therefore only appears when it changes itself. Pass
them explicitly, every time:

```
ServiceHighCpuAlarmAction=alert  ServiceHighMemoryAlarmAction=alert
ServiceHttp5xxTargetAlarmAction=alert  ServiceHttp4xxAnomalyAlarmAction=dashboard
SkipImageResolver=false  InitialDockerImage=<the running image>
```

**`EnableHttp4xxAnomalyAlarm=false` maps to `dashboard`, not `off`.** All 14 Paris stacks carried `false`,
because `1.5.0` offered only "exists and notifies" or "does not exist" — `false` meant "do not page me",
not "never show me this". `1.6.0` adds the third state, and going to `off` would throw it away. `dashboard`
costs about four dollars a month across fifteen services (an anomaly alarm bills as three metrics), makes
no noise, and the detector trains on the 15 months of `HTTPCode_Target_4XX_Count` already retained, so the
band is meaningful from day one rather than after a warm-up. The week-long credential sweep that ran
through the 2026-09-08 incident window generated exactly the 404 volume such a band exists to surface.
The same 19 Frankfurt stacks need the same reading of their own `EnableHttp4xxAnomalyAlarm` values before
the rollout, since a `true` there means the alarm already exists and `dashboard` would silence it.

**Both templates are at `1.6.0` in Paris since 2026-09-09; Frankfurt still runs `1.5.0` on the cluster and
pre-`1.3.0` versions on all 19 services.** The Paris rollout was clean: no instance replaced, no task
lost, no false positive after the two WAF groups began blocking, and `rds-connections` sat at `OK` from
the moment it was created, so its threshold of 60 matches normal operation and the alarm is promotable
whenever someone wants it delivered.

---

## Incident 2026-09-08 — `gwa-gut-web-p`, distributed origin exhaustion

> Frankfurt, 04:00–04:34 UTC. Four minutes of measured outage, 34 minutes of a wedged container.
> Reconstructed from `gwa-gut-web-p-LogGroup`; the queries are in the [Query appendix](#query-appendix).

| | |
|---|---|
| updown | DOWN 04:01:02, UP 04:05:01, reason **504** |
| Alarm | `AlarmHttp5xxTarget`, **214** target-5xx in the period 04:01–04:06 |
| Load | ~21 req/min — baseline. This was **not** a volumetric attack |
| request-seconds | **337** in the minute 04:00, against 1–3 as baseline |
| Longest single request | **2063 s** |
| `/test.php` | one health check took **900 s** |

**Mechanism.** Over 100 requests all begin in the minute 04:00 and all end after 2042–2063 s, i.e.
together at ~04:34. They were held and released as one batch. Once the worker pool was full `/test.php`
could not get a worker either, four health checks failed over three minutes, and ECS replaced the task —
the same machinery that turned a stall into 4–5 minutes on 2026-08-28/29. The *new* task served traffic
from 04:05, which is why updown recovered while the old task still held its connections; Apache's own
`OPTIONS *` self-ping ran into 408 timeouts continuously until 04:34.

**Attack profile.** Three properties, each sufficient on its own to call it deliberate:

1. **Source dispersion.** Almost every XFF address appears once or twice, but the addresses cluster in
   small netblocks — about two dozen out of `45.150.20.0/23`, plus `92.118.71.x`, `81.180.172.x`,
   `213.255.24x.x`, `185.150.8x.x`, `194.61.11x.x`, `160.225.189.x`, `103.225.128.x`. One or two requests
   per address passes under **any** per-IP rate limit. That is why the Cloudflare rule from 2026-08-29 did
   nothing (it only covers the two login paths and counts per IP) and why `RateLimitSourceIp` stayed quiet
   during the outage — it trips at 2000 requests per source per 5 min.
2. **Target selection.** Only paths that force a full WordPress bootstrap: `/`,
   `/wp-json/complianz/v1/cookie_data`, and 404s on media files with random hex names
   (`/0c4a9960e6e3bb.mpg`, `/0e4b254a88c1bc40dc6cab.webp`). No browser or crawler generates those names —
   it is cache-busting, and a WordPress 404 costs a full bootstrap (measured at 1.9 s on 2026-08-29).
3. **Hold duration.** The requests are kept open rather than repeated.

**The amplifier, and the actual defect.** The ALB gives up after its 60 s `idle_timeout`
(`ecscluster-vpc-rds-asg/index.template:1754`) and returns 504 to the client — **Apache keeps working**,
here for 34 minutes, on requests nobody is receiving any more. Neither side cleans up, so an attacker only
has to open connections and leave them. This is the one property that makes the attack cheap, and the one
fix that does not depend on the attacker's behaviour.

**The database is cleared, and it corroborates the mechanism.** Both Aurora logs were read for
03:30–05:30 (`Q43`/`Q44`):

- **Slow query log: empty.** `long_query_time` is unset, so the default 10 s applies — nothing crossed it.
  Delivery is intact and not silently broken: over the full 14-day retention the group holds exactly five
  lines (2026-08-27, 08-31, and three on 09-02). So **no query ran long during the outage**, and the
  2063 s hang was not a database wait.
- **Error log: no error, but a precise mirror.** Five `Got timeout reading communication packets` fire
  within 28 ms of each other at **04:01:13** — eleven seconds after updown went DOWN at 04:01:02 — on the
  consecutive thread ids 23811903–23811907. More follow on the neighbouring ids through 04:16, mixed with
  `Bad handshake` at 04:09–04:14 as the old task was torn down (`require_secure_transport` is `ON`, so a
  connection abandoned mid-TLS reads as that).

That message is the **server** timing out while waiting to read from the **client**. It fixes the
direction of causation: PHP went silent first, and MySQL noticed. Not one `1040`, no lock wait, no
restart — Aurora was healthy and idle throughout. The hang was in Apache, in front of the database.

**Which makes the Apache fix the correct and sufficient structural answer — and `DatabaseConnections`,
read on 2026-09-08, makes it urgent rather than tidy.** I estimated the frozen workers were holding
"roughly ten" connections, inferred from the five entries in the error log. That was wrong by an order of
magnitude; the five were only the ones that reached a read timeout. The metric shows what actually
happened:

```
03:30–03:59   2–5 connections     baseline
04:00         91                  instantly
04:04         96                  peak
04:10–04:34   91 → 82             the old task holding them
04:35         3                   released, matching the 04:34:44 flush
```

**Peak 96 against a ceiling of roughly 140.** `log` in an RDS parameter formula is **base 2**, not the
natural logarithm — a mistake I made twice on 2026-09-08 before checking the AWS documentation, and both
earlier numbers here (~100, and "~170 for the Aurora default") were wrong because of it. Correctly:
`log2(DBInstanceClassMemory/805306368)` is 2.30–2.42 on `db.t3.medium`, so the parameter group's ×60 gives
**138–145** and the Aurora default's ×45 gives **104–109**. The ratio is fixed at 60/45, so the template
raises the limit by a third regardless of the exact memory figure.

So one service held **about 69 %** of the whole cluster's connection budget for 34 minutes, with some
twenty production services sharing the rest. That is a serious concentration and it is why the alarm below
matters — but it is not the near-miss I described earlier, and the 2026-09-04 `1040` event stays an
analogy rather than a near-repeat. The effective value still has to be read off the running instance
(`Q9`); everything above is arithmetic, not measurement.

**Follow-up this opens:** with ~90 of ~140 connections held by one service for half an hour, the others
had roughly 45 left between them. `Q2` showed no 5xx alarm elsewhere, but that alarm needs more than five
errors in five minutes — smaller damage would not have surfaced. `Q19` (cluster-wide 5xx across all 37
log groups, 03:30–04:40) is written and still unrun.

**Ruled out.** Aurora (no `1040`, no `error establishing`, no `Fatal error` in the window); any other
service (no 5xx alarm outside gwa); AWS Backup (no job in the window); a deploy (no stack updated).
`vpc-rejected-surge` fired at 04:18:49, i.e. *after* recovery at 04:17:33 and right after the task
replacement — the benign reading left open on 2026-09-04 (the freshly started tasks' own addresses) now
fits cleanly.

**Ruled out on the CVE side.** The site runs **WordPress 6.9.7** (read from the `wp-cron` user agent in
the access log). `CVE-2026-63030` / `CVE-2026-60137` (wp2shell) affect 6.9.0–6.9.4, 7.0.0–7.0.1 and
6.8.0–6.8.5; all are fixed from 6.9.5 onward, so this install is not exposed — which also retires the
lingering question next to the Aug-2026 incident IOCs. There is no CVE behind this outage at all: every
request returned 200 or 404, all were GET, none touched `batch/v1`, `rest_route` or `author__not_in`.
The exploit-path sweep in the [Query appendix](#query-appendix) shows nobody even tried it through that door. What was abused is
not a bug but a design property: `cookie_data` is unauthenticated, uncached and costs a full bootstrap.
Complianz is clear too — `CVE-2026-4019` (unauthenticated read via
`/wp-json/complianz/v1/consent-area/{post_id}/{block_id}`, CVSS 5.3) covers every release **up to and
including 7.4.5**, and the installed version is **7.4.6**, read from the plugin list on 2026-09-08.

**Q37 result — wp2shell was probed and correctly refused, and the prober says who it is.** A single
address, `2003:e5:7707:e900:1963:19e3:e4f:7af5` (German consumer prefix, unauthenticated — its
`/wp-json/wp/v2/users/me` returns 401), ran a textbook wp2shell probe: REST discovery via `/?rest_route=/`
and `/gwa-cms/index.php?rest_route=/` (200), then the batch endpoint four different ways —
`/wp-json/batch/v1` GET **403**, the same POST **403**, `/?rest_route=/batch/v1` **403**,
`/?rest_route=%2Fbatch%2Fv1` **403**. Every attempt refused, which confirms from the outside what the
version number says.

Q38 then named it: those requests carry the user agent **`Mozilla/5.0 (compatible; gwa-seccheck/1.0)`**,
34 requests over 22 paths in the two minutes 07:28–07:29 on 2026-09-08. The same address browses the site
with ordinary macOS Chrome from 07:26 to 08:15 either side of it. So this is a **self-declared security
check run from someone's desk this morning**, not an adversary — plausibly triggered by the outage itself.
Worth one question to GWA to confirm who ran it: the name is suggestive, not proof, and an unclaimed
scanner would be a finding of its own.

That also explains part of the morning WAF noise. `AlarmWafKnownBadInputs` went to ALARM at 07:32:03 and
`AlarmWafCommonRuleSet` at 07:34:53 — both 5-minute periods covering the scan window. A scanner sends
exactly the payloads those managed rule groups match. `AlarmWafSQLi` at 07:15:25 predates the scan and is
not explained by it; `RateLimitSourceIp` needs 2000 requests from one source and 34 cannot produce it, so
that one stays with the Cloudflare-edge aggregation described above.

**Webshell hunting, nothing found.** `45.8.196.195`, `45.8.196.219`, `62.60.130.62`, `62.60.130.247`
walked paths like `///images/images/.../cache.php`, `/clash-of-agencies///cgi-bin/cgi-bin/cache.php`,
`///wp-content/plugins/plugins/cache.php` — the `///` prefix is the same route-confusion trick wp2shell
uses, here aimed at a planted webshell rather than the API. All **301**, nothing there. Same family as the
`ALFA_DATA/alfacgiapi/perl.alfa` probes on 2026-08-29, and the same answer: this site is not backdoored.

**One real exposure, unrelated to the outage: `/wp-json/wp/v2/users` answers 200 to anyone.**
`2003:e5:…` (×2), `5.175.189.113`, plus `/users/2`, `/users/217`, `/users/532` from `220.181.108.84`
(Baidu), `34.203.111.15` and `43.153.7.191` — all 200. WordPress publishes authors on that endpoint by
default, which hands a brute-forcer valid usernames; the username enumeration seen during the 2026-08-29
campaign came through the same door. Worth closing in the application, and cheap to verify by opening the
URL. **The three wp-admin sessions are editorial staff — checked, not assumed.** Q38 resolves them:
`2a02:3100:5dc2:e500:…` (940 requests, 2026-09-07 12:00–21:54, 198 paths, macOS Chrome) shows an
uninterrupted CMS workflow — `admin-ajax.php` in bulk, a `wp/v2/pages/86638/autosaves` loop,
`post.php?post=86542&action=edit`, `edit.php?s=Academy&post_type=events`, `async-upload.php`,
`rankmath/v1/updateMeta`, `block-visibility/v1/settings`. Somebody edited a GWA-Academy event and a page,
uploaded media and set SEO metadata. `2a02:3100:58e6:8800:…` (214 requests, 2026-09-08 06:48–08:15) is the
same shape this morning, `2a02:3100:a42e:700:…` a short session on 09-07. All German consumer prefixes,
all macOS Chrome, all inside working hours. The `users/me?_locale=user` POSTs are Gutenberg persisting
editor preferences, which is what that call is. Nothing administrative — no user creation, no plugin or
theme action. Closed.

**The database closes the incident, and opens one new finding.** Read on 2026-09-08 (`Q45`):

**Nothing was changed during the outage.** Exactly two rows carry a modification in the queried window —
`86674` (a revision) at 07:25:11 and page `86638` at 07:25:14, status `draft`. That is the same page the
morning editorial session was demonstrably working on, three and a half hours after the outage. Between
04:00 and 04:34 the content did not move at all. The distraction hypothesis is now retired from the
database side as well, not just from the access log.

**New finding: WordPress does not see the visitor's IP.** Every address in `wp_usermeta.session_tokens`
is a **Cloudflare edge** — `172.71.x`, `172.69.x`, `172.68.x`, `104.22.x`, `104.23.x`. So `REMOTE_ADDR`
inside the application is the proxy, not the client. Two consequences:

- The session records cannot map the three IPv6 addresses to accounts, which is what I expected them to
  do. That expectation was wrong, and the access log's `XFF` field stays the only place in this stack
  that knows who is actually calling.
- Anything in WordPress that keys on IP — a login lockout, a rate limit, an audit plugin — is either
  blind or dangerous here: it sees the entire internet as a handful of Cloudflare addresses, so it will
  never trigger on one attacker, and if it ever does trigger it locks out everyone behind that edge.

This is the same defect as the empty `WafClientIpHeader`, one layer up, and it has the same prerequisite:
**restricting `SgPublicHttpHttps` to Cloudflare ranges comes first.** Until the origin cannot be reached
directly, trusting `CF-Connecting-IP` in `wp-config.php` would let anyone set their own address and walk
past whatever is built on it. Fix the security group, then the header, then both WAF and WordPress see
real clients.

**Who was at the keyboard when the scanner ran.** Revision `86674`, saved 07:25:11 — three minutes
before `gwa-seccheck` — has `post_author = 4`, i.e. **`marc.escobar@gwa.de`**, whose session was valid
from 2026-09-07 07:44 to 09-09. That matches the morning editorial session at
`2a02:3100:58e6:8800:…` (06:48–08:15), whose user agent is byte-identical to the one recorded on user 4's
session token. So the save is attributed, and one GWA person was demonstrably working at that moment.

**The scanner is ours.** I wrote earlier that `dev-accounts@labor.digital` could be ruled out because it
logged in at 08:12, after the scan. The observation was right and the conclusion was wrong — it logged in
**from the scanner's own address**. `Q41` traces `2003:e5:7707:e900:1963:19e3:e4f:7af5` end to end:

```
07:26:00  GET /                              200   ordinary page view
07:28-29  the 34 gwa-seccheck requests
08:12:22  GET /gwa-cms/wp-admin/             302   not logged in yet
08:12:30  POST /gwa-cms/wp-login.php         302   ← successful login
08:12:30  GET /gwa-cms/wp-admin/             200
08:12:34  GET /gwa-cms/wp-admin/plugins.php  200
08:13-08:26  admin-ajax heartbeat every ~2 min, referrer plugins.php
```

That `POST … 302` on the real login path is exactly the discriminator `Q42` was written to isolate, and
the timestamp matches the `labor` session token to the second (login 2026-09-08 08:12:30).

**Confirmed, not inferred.** The check was run by a Claude session in the GWA repo
(`~/.claude/projects/…GWA-Gutenberg-Website-app/6d65fe16-8fb1…`, transcript
`6d65fe16-7cf3-4b01-8a24-5812de87c80b`), asked to review the live site. Its `curl` calls carry
`UA='Mozilla/5.0 (compatible; gwa-seccheck/1.0)'` verbatim and run 07:27:59–07:29:16 UTC against the
07:28:02–07:29:19 in the access log. Nothing to escalate.

**What the check actually probed**, in order: `readme.html` (WordPress version), REST reachability, the
wp2shell batch endpoint four ways, open registration, a role-injection attempt
(`wp-login.php?action=register&gwa_register_role=administrator`), user enumeration via
`/wp-json/wp/v2/users` **and** `/?author=1..4`, and `xmlrpc.php`. A textbook WordPress hardening list, no
payloads, 34 requests in 77 seconds. Its results are worth keeping:

| Probe | Answer | Reading |
|---|---|---|
| `/gwa-cms/readme.html` | **200** | the WordPress version is published to anyone |
| `?action=register` | 302 | registration is off — good |
| `…&gwa_register_role=administrator` | 302 | **proves nothing** — see correction below |
| `/wp-json/wp/v2/users` | **200** | enumeration confirmed from a second direction |
| `/?author=1..4` | **301** | a *second* enumeration path — the redirect target carries the username |
| `HEAD /gwa-cms/xmlrpc.php` | 405 | exists, so it answers POST — the classic brute-force amplifier |

**Correction on that role-injection row, from the GWA session itself:** the parameter it probed does not
exist. The historical bug used **`custom_user_role`** via POST — a WPUF leftover in `changeUserRole()`
that wrote `$_POST['custom_user_role']` verbatim into the role, found in commit `fc5f36d3` and since
removed entirely. So the 302 above says nothing about that vector; what closes it is the removal, verified
in git. Worth keeping straight because it was an **independent second bug**, unrelated to the
2026-08 wp2shell chain (`CVE-2026-63030` → `CVE-2026-60137`).

Also verified live the same morning: the Basic-Auth separation holds — production answers 200,
`gwa-gut-web.labor.show` answers 401, and `test.php` answers 200 on both, which is the intended exception.

That adds two items to the users-endpoint task below: closing `/wp-json/wp/v2/users` alone is not enough
while `/?author=N` still redirects, and `xmlrpc.php` is worth disabling unless something still needs it.

**The site is scanned constantly, and one scanner stands out.** Over the 14-day retention the log carries
a steady stream of self-declaring scanners — `CloudflareWebScanner` twice daily, Palo Alto Cortex Xpanse
almost hourly, plus SEO and compliance bots. Two are not background noise: `vuln_scanner/3.1.0
(CVE-2026-4020)` from `194.180.48.7` on 08-30, which names the CVE it hunts in its own user agent, and
**`WP-Safe-Scanner`** — a reassuring name attached to constantly rotating hosts (`103.59.16x.x`,
`168.144.130.254`, `143.198.81.40`, `206.189.145.207`, `188.166.219.177`, `45.134.79.77`,
`103.245.27.98`), running most days, peaking at **76 requests over 27 paths on 2026-09-04 at 08:00** — an
hour before that morning's estate-wide Aurora incident. `gwa-seccheck` by contrast appears exactly once in
fourteen days, which is what a one-off reactive check looks like.

**Session inventory.** Fifteen token entries across nine accounts, of which **five are still valid**:
`marc.escobar@gwa.de` (user 4 — the same id the editor's `wp/v2/users/4` call resolved), `labor /
dev-accounts@labor.digital` (logged in 2026-09-08 08:12, i.e. us), and three agency press accounts
carrying **14-day "remember me" sessions**: `presse125 / mutabor.de`, `sarah.galambos / ogilvy.com` (valid
to 09-15), `franka / thegoodwins.de` (valid to 09-17). The other ten expired between 08-20 and 09-05 and
are simply never cleaned up — WordPress prunes `session_tokens` only when that user logs in or out again.
Harmless, but it means the table is an archive rather than a current picture.

Two questions worth a decision rather than a check: whether external agency accounts should hold two-week
sessions at all, and — not yet read — **which of these accounts carry `administrator`**. The account list
is dominated by member agencies (`schmittgall`, `ppw`, `jvm`, `mutabor`, `ogilvy`, `thegoodwins`), which
is plausible for an industry association, and makes the capability question the interesting one. The SQL
is in `Q45`.

**Six administrators, and the risk is in the combination.** Read 2026-09-08: `labor`, `gwa`,
`julia.sadrina@gwa.de`, `marc.escobar@gwa.de`, `anja.sturm`, `PPW Admin` (`mpietz@ppw.de`). Three of them
are not personal accounts — `labor` and `gwa` are role names, and `PPW Admin` is a **shared account of an
external agency holding full administrator rights**. Its four session tokens all date from 2026-08-21 and
have expired, so nothing is live, but the account and its privileges remain.

That matters because of what it lines up with, all three already established above:

1. `/wp-json/wp/v2/users` answers 200 to anyone, and WordPress returns each user's `slug` — which is the
   login name. External addresses were seen pulling `/users/2`, `/users/4`, `/users/217`, `/users/532`.
2. `gwa` and `labor` are precisely the usernames a bot guesses for this site.
3. A distributed login campaign has been running every night, roughly one new source every 10–15 minutes,
   and since this incident some of it POSTs to the real `/gwa-cms/wp-login.php` rather than the stock path.

Enumerable usernames plus guessable admin names plus a patient distributed brute force is a chain, not
three separate observations. No second factor is visible anywhere in the data. Closing the users endpoint
(item 4 below) breaks the first link cheaply; the agency account and the role-named admins are a decision
for GWA.

**One oddity worth a look:** `labor`, `julia.sadrina` and `marc.escobar` each came back **twice** from the
capabilities query. Duplicate rows usually mean a second `…capabilities` meta key under a different table
prefix, left over from a migration. Stale rows are inert while the prefix stays as it is, but they make
the rights picture ambiguous and would come alive again if the prefix ever changed back. Worth confirming
with `SELECT DISTINCT meta_key FROM wp_usermeta WHERE meta_key LIKE '%capabilities'`.

**One actor or two? Not established — and the evidence is weaker than it looks in both directions.** The
GWA session confirms it holds **no independent log analysis of this outage**; its note about
"`/users/me` & `?author=`" refers to the brute-force nights of 2026-08-28/29 (reconstructed in a different
session), not to 04:00. So there is no competing reconstruction to reconcile — only two tracks to compare:

| | Credential track | Availability track |
|---|---|---|
| Seen | 08-28/29, and nightly since | 09-08 04:00–04:34 |
| Sources | `213.227.x` and the low-and-slow set | `45.150.20.0/23`, `213.255.24x.x`, `92.118.71.x` … |
| Goal | a valid login | worker exhaustion |

The netblocks do not overlap, which is what the GWA session reads as two separate actors. That is the
right default, but it is worth stating precisely what it proves: **non-overlap across a ten-day gap is not
evidence of two actors**, because rented proxy pools rotate faster than that. It fails to establish one
actor; it does not establish two. Treat them as separate work streams — which is the same conclusion —
without recording a shared origin as ruled out.

**Mitigation built 2026-09-08 (GWA repo, working tree, not committed).** The GWA session implemented the
enumeration item as `src/wp-content/mu-plugins/001-harden-recon-surface.php` plus a `LocationMatch` block
in `conf/000-default.conf`, mirroring the existing `000-disable-batch-endpoint.php` split. Anonymous
`?author=N` now 404s instead of redirecting (the `redirect_canonical` filter kills the `Location` leak
itself), `/wp/v2/users` is removed from the REST map for unauthenticated callers only — deliberately
keeping it for logged-in editors, which is right, because the block editor's author picker uses
`wp/v2/users/4?context=view` and would otherwise break — XML-RPC is off including `system.multicall` and
`X-Pingback`, and both generator tags are stripped. `readme.html` and `license.txt` are denied in Apache,
since those are static files served before PHP ever runs. Escape hatch `GWA_DISABLE_RECON_HARDENING`,
default off. Not yet linted (`php -l`, `apachectl -t` — the Docker daemon was down) and not deployed.

Two things to check from this side before it ships, neither visible from the application repo:

- **Is XML-RPC used by anything legitimate?** Disabling it is right against `system.multicall`, but it
  also serves the WordPress mobile app, Jetpack and some editorial integrations. The only `xmlrpc.php`
  request in my window is the seccheck's own `HEAD` (405). The `?ver=` sweep in the [Query appendix](#query-appendix) covers
  the full 14 days for real POSTs before anyone is surprised.
- **The version still leaks after this change.** Every enqueued asset carries it in the query string —
  `/gwa-cms/wp-includes/js/wp-lists.min.js?ver=6.9.7`, `shortcode.min.js?ver=6.9.7`,
  `wp-admin/js/postbox.min.js?ver=6.9.7`, read straight out of the 08:12 session log. That is on every
  page for everyone, so closing `<meta generator>`, the feed tag and `readme.html` narrows the fingerprint
  without removing it. Worth saying plainly: version hiding is a weak control either way, and this is not
  a reason to hold the change — but the item should not be recorded as "closed".

**And the item this does not touch is still item 1.** The recon hardening is item 4 on the list below —
the credential track. Nothing in it shortens a 2063-second request. The outage fix lives in
`docker-base-images-v2/php8x/php8x/conf/`, in a different repository, and remains open.

**Resolved 2026-09-08: `AlarmWafKnownBadInputs` was counting the `.env` sweep, and the same query
produced a blocking finding for the promotion path.** `Q50` broken down by rule group:

| Rule group | What it matched |
|---|---|
| `KnownBadInputs` | Almost exclusively **`.env` paths** — `/.env` 31, `/.env.production` 15, `/.env.prod` 14, then ~150 rows of `/<dir>/.env` at 4–11 each. Plus `/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php` (CVE-2017-9841) and the `@fs` paths |
| `CommonRuleSet` | `/` 111, `/login` 100, `/AutoDiscover/autodiscover.xml` 167, `/info-request` 49, `/matomo.php` 44, **`/robots.txt` 36**, `/feed/atom` 36, plus a webshell sweep from `4.204.224.164` (Azure) across hundreds of `.php` names |
| `SQLiRuleSet` | `/info-request` 144, `/live` 62, `/the-gallery` 58, `/login` 57, **`/test.php` 57** |
| `WordPressRuleSet` | `/xmlrpc.php` 16 |

**The `.env` list has a specialisation worth naming:** `/sendgrid/.env`, `/mailgun/.env`, `/brevo/.env`,
`/postmark/.env`, `/mailjet/.env`, `/sparkpost/.env`, `/mandrill/.env`, `/ses/.env`, `/smtp/.env`,
`/mailer/.env`, `/newsletter/.env`, `/transactional/.env`, `/bulk/.env`, `/campaign/.env`,
`/mailing/.env`, `/sender/.env`, `/notify/.env`. This is not generic credential theft — it is hunting
**mail-provider credentials**, whose value is a reputable sending domain for spam and phishing. Relevant
to any customer conversation, because the damage from that class of theft lands on the domain's
reputation, not on the site.

**The time curve settles the outage question.** Counted matches per 5 min: 03:10 **244**, 03:15 252,
03:30 274, 03:35 130, 04:10 73, 04:15 171 — then **04:00 = 8 and 04:05 = 2**, essentially nothing across
the outage itself, before the big sweeps at 04:55 **897**, 05:00 **1388**, 05:05 928, 05:10 633, 07:30
942, 07:55 **1010**. Every alarm time (03:35, 04:16, 04:58, 05:13, 05:51, 06:21, 06:49, 07:32) sits on a
spike. So the alarm tracked the credential sweeps all night, and the exhaustion wave **matched no WAF rule
at all** — confirming what the 04:01–04:16 silence suggested.

**And the blocking finding: `CommonRuleSet` cannot be promoted to `block` as it stands.** It fires on
ordinary application paths — `/robots.txt`, `/feed/atom`, `/matomo.php` and `/` are false positives, and the 167 matches on
`/AutoDiscover/autodiscover.xml` come from German consumer addresses (`80.187.101.191`, `91.26.118.253`,
`87.178.239.29`, `79.227.113.43` …) — those are **Outlook clients** probing for Exchange autodiscovery,
not an attack.

`KnownBadInputs` by contrast is clean: it fires on `.env` and known-exploit paths and essentially nothing
legitimate. That is exactly the ordering the promotion path below already assumes — and it now has
evidence rather than an assumption behind it. Before `CommonRuleSet` moves at all, it needs scope-down
statements excluding at minimum `/robots.txt`, the feed paths and `autodiscover.xml`.

> **Corrected 2026-09-08 — `SQLiRuleSet` was wrongly grouped with `CommonRuleSet` above.** The original
> wording read that its 57 matches on `/test.php` made promotion fail the ALB health checks. `Q59` showed
> health checks never reach the WebACL at all (see *health checks do not traverse the WebACL* below), so
> the objection does not hold and `/test.php` needs no exclusion. `SQLiRuleSet` and `KnownBadInputs` were
> promoted to `block` in Paris on 2026-09-09 with their alarms on `alert`; no false positives followed.
> `CommonRuleSet` remains the only group that genuinely needs overrides first.

**Superseded — the original open question, kept for the reasoning:** It cycled all night — ALARM at
03:35, 04:16, 04:58, 05:13, 05:51, 06:21, 06:49, 07:32, each lasting three to fourteen minutes, i.e.
repeatedly crossing 50 counted matches per 5 min against the template's measured baseline of ~18. **The
content was never read.** The WAF log group `aws-waf-logs-labc-eu-c1-waf` carries the full requests, and its
delivery in Frankfurt was last verified 2026-08-22, so the first step is confirming it still ingests.
*(Since read — see the rule-group table above and the WAF queries in the
[Query appendix](#query-appendix).)*

Three things bound how much this can mean, and all three should be recorded before someone reads the
alarm as evidence of anything:

- **It was quiet during the outage.** The gap between the 03:42 clear and the 04:16 alarm covers
  04:01–04:16 exactly. WAF evaluates at the ALB regardless of backend health, so the drop means the
  exhaustion wave itself **did not match** this rule group — consistent with plain GETs on legitimate
  paths.
- **It is cluster-wide, not per service.** The WebACL sits on the ALB across all ~15 services and the
  alarm is dimensioned on the rule, not the target. It cannot say who was hit — the same resolution gap
  as `RateLimitSourceIp`.
- **Nothing was blocked or mailed.** The rule is `count`, the alarm is `dashboard`.

Plausible sources from what the access log did show — the `///`-prefixed `cache.php` webshell probes, the
`file:///root/.ssh/id_rsa` attempts via `__vite_rsc_findSourceMapURL`, the `batch/v1` probes. That is
inference, not measurement, and should not be written down as a finding until `Q16` runs.

**The WAF logs deliver, and they carry two findings the access log could not show.** Verified 2026-09-08:
`aws-waf-logs-labc-eu-c1-waf` last ingested 09:52:29 UTC, so the delivery that TASKS warns can fail
silently is intact in Frankfurt. Two caveats before the content: the WebACL sits on the ALB and covers
**all ~15 services** — `/sport/*`, `/stream/*`, `/en/publications/*`, `/matomo.php`, `/_jobs/warmCache` in
the same result set belong to Sport aus Mainz, TRON and Matomo — so every WAF number is estate-wide until
filtered on host. And `action: ALLOW` is the WebACL's default action, **not** the HTTP status; nothing in
these logs says whether a request succeeded.

**1. Direct-to-origin traffic is confirmed, with numbers.** `httpRequest.clientIp` is the address that
opens the TCP connection to the ALB, and `WafClientIpHeader` is empty, so no header is consulted. Hosts
appearing there that are *not* Cloudflare have bypassed the CDN entirely. In the outage window:
`135.181.102.135` (Hetzner) 43 on `/`, `91.121.222.175` (OVH) 41, `104.238.159.87` (Vultr) 38,
`188.245.246.66` 15, `116.203.20.126` 13, `88.198.157.52` 12, plus `167.114.64.88`/`.21` and
`192.99.21.124` (OVH Canada) with 118 on `/_jobs/warmCache`.

Those are **the same six datacenter addresses** flagged in `Q8` as "one URL each, 18–21 times" — and this
explains the shape: they reach the ALB directly, and the *ALB's own* `X-Forwarded-For` is why the Apache
log recorded them as `XFF`. It also settles a question left open since 2026-08-19: the origin is reachable
without Cloudflare, so **the Cloudflare rate-limit rule from 08-29 structurally cannot see this traffic.**
Restricting `SgPublicHttpHttps` to Cloudflare ranges is no longer a hardening nicety; it is the
precondition for any edge control to mean anything, and it is already the prerequisite for
`WafClientIpHeader`.

**2. A credential-harvesting sweep is running against the estate.** `34.125.113.184` (Google Cloud, not
Cloudflare) made **~870 requests across roughly 200 distinct paths in 40 minutes**, all of one kind:
`/.env` in ten variants (`.env.production`, `.env~`, `.env.swp`, `web/.env`, `uploads../.env` …), Vite
`@fs` path traversal including double-encoded `..%252f` chains, AWS/GCP/Azure credential files, SSH
private keys, `/.git/config`, `/.bash_history`, `terraform.tfstate`, the Kubernetes service-account token
— and a conspicuous block of **AI tooling configuration**: `claude_desktop_config.json`,
`.claude/settings.json`, `.claude/mcp.json`, `.anthropic/config.json`, `.codex/config.toml`,
`.cursor/settings.json`, `.codeium/settings.json`, `.openai/config.json`, `opencode/auth.json`,
`llm.json`, `ai.json`. That last group is the current fashion in key theft and is worth naming explicitly
in any customer-facing writeup.

This is **not** the outage — different source, different shape, no volume against gwa — but it is the more
consequential finding, because the WAF logs cannot say whether any of it was answered. `Q52` sweeps all 37
service log groups over the full retention for any of those paths returning **200**. Run it before
anything else on this list; a single hit changes the incident class entirely.

**`Q52` came back positive on one service — `aut-web-web-p` answers 200 to about a hundred credential
paths.** `/.env` 46 times over the retention, `/.git/config` 34, `/.aws/credentials` 22, `/id_rsa` and
`/.ssh/id_rsa` 6 each, `/privatekey.key` 5, `/credentials.json` 8, `/config/credentials.yml.enc` 6,
`/@fs/etc/passwd?raw??` 8. This is a different service from gwa and unrelated to the outage, but it is
inside the same estate and it is the more serious of today's findings **if it is real**.

**It is not a leak — settled by `Q53` on 2026-09-08.** The response sizes decide it four ways:

- **The same path returns different sizes at different times.** `/.env` answered 10229 bytes at 07:06 and
  05:02, and 8651 / 8655 / 8417 in the 00:19 batch. A static file does not do that; rendered HTML does.
- **Every 200 is 8.4–15.3 KB.** A `.env` is a few hundred bytes of `KEY=value`. Nothing returned is small
  enough to be one.
- **Sizes come in pairs one byte apart** (15316/15317, 13651/13652, 8413/8417) — the signature of a
  compressed HTML body carrying a variable element such as a nonce or build hash.
- **`/api%2F.env` returns 404 with 370 bytes.** The server has a working 404; the URL-encoded variant
  simply misses the catch-all route, which proves the route is what produces the 200s.

The most reassuring single data point: **`/@fs/etc/passwd?raw??` returned 13–15 KB.** `/etc/passwd` is one
to two kilobytes and constant, so what came back is the HTML page, not the file. That also disposes of the
worse hypothesis behind those `@fs` + `?raw??` paths — they target a **Vite dev server running in
production**, which would be arbitrary file read. Returning HTML instead of file content means no dev
server is exposed. The scanner is guessing, and guessing wrong.

Either way there is something to fix and someone to tell. If it is a catch-all, answering 200 to every
unknown path is still a hygiene defect: it hides real leaks, feeds scanner hit lists, and makes exactly
this kind of estate-wide sweep unanalysable. The service's team should hear about it regardless of the
outcome. `Q54` checks whether any other service does the same.

**Open, in order of effect:**

1. **Bound the Apache request lifetime below the ALB's 60 s.** This lives in the application image, not in
   these templates — `docker-base-images-v2/php8x/php8x/conf/`. The base is `php:8.3-apache`, i.e.
   **mod_php on mpm_prefork**: one process per request, and the worker pool is the resource that ran out.
   What is configured today, and why none of it capped a 2063 s request:

   | Setting | Value | Why it did not bite |
   |---|---|---|
   | `Timeout` (apache2.conf:16) | `300` | Governs *inactivity* between I/O events, not total request time. A script that is simply blocked never trips it |
   | `max_execution_time` (php.ini:127) | `240` | On Linux this counts **CPU time**, not wall clock. A request waiting on a lock or a socket accrues none |
   | `default_socket_timeout` (php.ini:397) | `60` | Applies to PHP streams only — not to mysqli/PDO, which carry their own timeouts |
   | `mod_reqtimeout` | not configured | Debian defaults apply; nothing tuned for the read phase |

   So the honest conclusion: **under mod_php there is no reliable wall-clock kill for a hung request.**
   Three steps, increasing in effort:
   - `RequestReadTimeout header=10-20,MinRate=500 body=10,MinRate=500` — closes the slow-send side
     (Slowloris). Cheap, low risk, does nothing against a slow *response*.
   - `Timeout 60`, matching the ALB. Caps I/O stalls. Check first that no admin task (import, backup,
     `wp-cron` job) legitimately runs longer, or it will break them.
   - A hard wall-clock kill requires **migrating to php-fpm**, where `request_terminate_timeout` provides
     one. To be unambiguous, because it has already been misread once: **this stack has no php-fpm and
     that parameter does not exist here today.** It is the target of a migration, not a setting to flip.
     Nothing short of that migration bounds this class of attack by construction — the two steps above
     reduce the exposure, they do not close it.

   Also unknown and worth reading off the running container: `MaxRequestWorkers`. It is not in
   `apache2.conf`, so the Debian `mpm_prefork.conf` default of 150 applies unless something overrides it —
   against `memory_limit = 512M` per process and a 478 MiB `MemoryReservation` that number is fiction, and
   the real ceiling is memory. Knowing it turns "the pool ran out" into an actual number.
2. **Restrict `SgPublicHttpHttps` to the Cloudflare ranges. This moved up on 2026-09-08 and is no longer
   hardening — it is the precondition for every edge control below being worth anything.** The WAF logs
   settle what was previously an assumption: `httpRequest.clientIp` is the address that opens the
   connection to the ALB, and in the outage window it carries `135.181.102.135` (Hetzner, 43 requests on
   `/`), `91.121.222.175` (OVH, 41), `104.238.159.87` (Vultr, 38), `188.245.246.66`, `116.203.20.126`,
   `88.198.157.52`, plus `167.114.64.88`/`.21`/`192.99.21.124` with 118 on another service. Those are the
   same six datacenter hosts `Q8` saw as "one URL each, 18–21 times" — reaching the origin **without
   traversing Cloudflare**, with the ALB's own `X-Forwarded-For` explaining why Apache logged them as
   `XFF`.

   Three consequences, all of which are currently unaddressed:
   - The Cloudflare rate-limit rule from 2026-08-29 **structurally cannot see this traffic.** That is not
     a tuning problem and no rule change fixes it.
   - Items 3 and 4 below inherit the same hole: an edge cache rule and an edge block are only as good as
     the share of traffic that reaches the edge.
   - `WafClientIpHeader` cannot be set safely until this is done, and neither can `CF-Connecting-IP` in
     `wp-config.php` — while the origin is directly reachable, anyone can set those headers themselves.
     So this one change unblocks the WAF promotion path *and* gives WordPress real client addresses.

3. **Cache `/wp-json/complianz/v1/cookie_data` at the edge — after checking that it is cacheable.**
   Every observed response was the same 2510 bytes, yet each one costs a full bootstrap. But consent data
   *can* vary per visitor, so read `Vary` and `Set-Cookie` on the live response before writing the rule;
   caching a per-visitor payload at the edge would serve one visitor's consent state to everyone. If it
   turns out to vary, the lever is a short micro-cache or a `stale-while-revalidate`, not a plain cache
   rule.
4. **Block non-existent media extensions at the edge**, which kills the cache-busting 404s. Same
   dependency on item 2 as above.
5. **Close the user enumeration — a different threat from this outage, listed here only because it is
   cheap.** It feeds the nightly credential campaign, not the availability attack; do not let the two get
   merged into one work item. Verified against the live site on 2026-09-08 by the GWA session:
   `/wp-json/wp/v2/users` returns **10 author slugs** — users with published posts, and `labor` and `gwa`
   are *not* among them. `/?author=1..4` is the real leak: it redirects to `/author/labor/`,
   `/author/gwa/` and so on, and for those accounts `user_nicename` equals `user_login` (confirmed in the
   database). So the **administrator logins leak through the author redirect, not through the REST
   endpoint** — closing only the endpoint would have left the valuable half open. Both need to go, plus
   `xmlrpc.php` (answers POST, and `system.multicall` batches login attempts), plus the three version
   leaks: `<meta name="generator">`, the feed's `<generator>` tag, and `readme.html` returning 200.
6. **The WAF watched all night and did nothing.** Every rule is on `count` and every alarm on
   `dashboard`, so nothing was blocked and nothing was mailed. Note that no per-IP rate rule would have
   caught this dispersion either — see the promotion path below, and set `WafClientIpHeader` before
   reading any rate data at all, which item 2 is the prerequisite for.

7. **Tell the `aut-web-web-p` team about their catch-all.** Not our service and not this incident, but
   found on the way: it answers 200 to every unknown path, including roughly a hundred credential probes
   and the `@fs` + `?raw??` Vite dev-server paths. It is not leaking anything (see above), but the
   behaviour hides real leaks, keeps the service on scanner hit lists as a standing "success", and made a
   45-minute investigation out of a question a 404 would have answered instantly.

---

## What the 2026-09-08 incident changes in the templates

Everything else from that incident lives in the application image, in WordPress or at Cloudflare. These
five are ours, ordered by what they would have been worth on the night.

**1. ~~There is no `DatabaseConnections` alarm~~ — added 2026-09-08, template `1.6.0`, not deployed.**
`RdsConnectionsAlarm` plus `RdsConnectionsAlarmAction` / `RdsConnectionsAlarmThreshold` (default
`dashboard` / `60`), documented in README's alarm table. `Statistic` is **`Maximum`**, not `Sum` —
`DatabaseConnections` is a gauge and summing a period's datapoints yields a meaningless multiple; the
`Note` on the resource says so, because this is the kind of detail that gets 'fixed' later. Namespace is
`AWS/RDS`, unlike the `rds-error` and `rds-slow-queries` alarms next to it, which read metric filters this
stack creates over the exported logs. The rationale below is why: Nine cluster alarms
exist and not one watches connections. The instance sat at 91–96 of roughly 100 for 34 minutes and
produced no signal whatsoever; the same blindness let the 2026-09-04 `1040` event run until customers
noticed. This is the single highest-value alarm the cluster template is missing, it is cheap, and unlike
the WAF alarms it needs no `WafClientIpHeader` prerequisite. Threshold wants to be a percentage of the
effective `max_connections`, not an absolute — which is why item 2 comes first in practice.

**2. `max_connections` does what it says — the override is fine, but nobody has ever read the number it
produces.** I first claimed this parameter *lowers* the ceiling; that was wrong, and worth recording
because the error is easy to repeat. `log` in an RDS parameter formula is **base 2**. The template's
`{log(DBInstanceClassMemory/805306368)*60}` and Aurora MySQL's own
`GREATEST({log(DBInstanceClassMemory/805306368)*45}, …)` differ only in the multiplier, so the template
sits a fixed **33 % above** the default: roughly **138–145** against **104–109** on `db.t3.medium`. The
description "increased connection limit" is accurate.

What remains is that the value is computed and never verified, and it is the denominator for item 1's
threshold. Read it once with `Q9`, write it into this file, and derive the alarm threshold from it. Only
if the measured value diverges from the arithmetic is there anything to change in the template.

**3. ~~`HTTPCode_ELB_5XX_Count` is deliberately un-alarmed~~ — added 2026-09-08 as `ElbHttp5xxAlarm`, in
the cluster template, `1.6.0`, not deployed.** It could not go where the omission is documented:
`HTTPCode_ELB_5XX_Count` carries **no `TargetGroup` dimension** (AWS has an open feature request for one
from May 2024), so it cannot be measured per service and belongs to the shared ALB. Ships as `dashboard`
with a threshold of `10` rather than `0`, because a single-task service under `MinimumHealthyPercent: 50`
legitimately produces 503s during a deploy. Verify the dimension claim with
`aws cloudwatch list-metrics --namespace AWS/ApplicationELB --metric-name HTTPCode_ELB_5XX_Count`.

**Still missing, and worth a separate decision:** the cluster alarm says *something* is unreachable, not
*which service*. The per-service equivalent that does carry a `TargetGroup` dimension is
`HealthyHostCount` / `UnHealthyHostCount` — an alarm on healthy hosts dropping below 1 would have fired
for gwa on 2026-09-08 and on 2026-08-28/29, and would name the service. That is an `ecsservice` change and
is not built.

The original reasoning, kept because it is why this took two incidents to notice: The customer-visible symptom was a 504, which is load-balancer-side and
therefore silent. What paged was `AlarmHttp5xxTarget` — the *edge* of the event, not the event. The
original reasoning ("not a case we need alarmed at the moment") is now falsified by two incidents;
2026-08-28/29 had the same shape. Reconsider as an opt-in parameter rather than a hard omission, so a
service behind a 60 s idle timeout can alarm on the thing its users actually experience.

**4. `CommonRuleSet` and `SQLi` are not safe to promote to `block` — they match ordinary application
paths.** `Q50` over five hours, cluster-wide: `SQLi` on `/info-request` **144**, `/live` 62,
`/the-gallery` 58, `/login` 57, `/test.php` 57; `CommonRuleSet` on `/` 111, `/login` 100, `/matomo.php`
44, `/robots.txt` 36, `/feed/atom` 36, and 167 on `/AutoDiscover/autodiscover.xml` — the last from German
consumer addresses, i.e. **Outlook clients** looking for Exchange autodiscovery, not attackers. Promotion
today would break a contact form (`/info-request`), the Matomo endpoint and the feeds. That is the real
finding, and it holds regardless of the question below.

**Settled 2026-09-08: health checks do not traverse the WebACL.** `Q59` returned empty for both
`httpRequest.clientIp like /^10\./` and `ELB-HealthChecker` across five hours of WAF logs. My original
claim — that promoting a rule group to `block` "would fail every health check and take services down" —
was wrong, and no `Allow` rule for the health check path is needed. The 57 `/test.php` matches come from
outside, and outside turns out to be a scanner (below), so blocking them would be correct rather than
harmful.

**And the false-positive assessment may itself be wrong.** `3.172.95.0/24` — 30 addresses, country GB — is
a broad-spectrum CVE scanner, not monitoring: `ofc_upload_image.php` across ~20 plugin paths,
`phpunit/…/eval-stdin.php` (CVE-2017-9841), `phpMoAdmin`, `/mgmt/tm/util/bash` (F5), `/ssl-vpn/hipreport.esp`
(Palo Alto), `/_vti_bin/` (SharePoint), `/webdav/` and `/sling/` (AEM), fifteen `xmlrpc` spellings, every
GraphQL path variant, plus random strings as a 404 baseline. Its top three targets are **`/info-request`
1382, `/login` 614, `/test.php` 590** — and `/info-request` and `/login` were exactly the paths cited above
as proof that `CommonRuleSet` and `SQLi` produce false positives. If those matches are the scanner's
payloads rather than real visitors, they are **true** positives and promotion is safe. One query decides
it: cross-reference the matched rule with `httpRequest.clientIp` on those paths. Until that runs, the
blocker below stands, but it is now questionable rather than established.

**The original wording of the retracted claim, kept because the reasoning matters:** ALB health checks originate from the load balancer
node inside the VPC — the Apache log records them as `10.1.1.217 … "ELB-HealthChecker/2.0" XFF="-"` — and
requests generated by the ALB toward its targets do not arrive at the listener as client requests, so they
plausibly never reach the WebACL at all. The 57 `/test.php` matches in the WAF log come from
**`3.172.95.x`, external addresses**, not from `10.1.x`. Against that, AWS's own guidance on this point is
inconsistent, and the query behind those numbers filtered to *matched* rules only — so the absence of
`10.1.x` shows health checks matched nothing, not that they were never inspected. `Q55` settles it in one
query: any `10.1.x` or `ELB-HealthChecker` entry in the WAF log means they are inspected.

**Answered 2026-09-08 — it is three individual rules, not the group.** Broken down to rule level
(`ruleGroupList` rather than `nonTerminatingMatchingRules`, five hours, cluster-wide), only three matches
would hit real functionality if `CommonRuleSet` enforced:

| Rule | Path | Hits | What breaks |
|---|---|---|---|
| `CrossSiteScripting_BODY` | `/matomo.php` | 43 | Matomo tracking POSTs carry page titles, URLs and referrers — user-supplied strings that trip body XSS inspection. **Analytics stops** |
| `SizeRestrictions_BODY` | `/stream/uploadSimple/image/…`, `/file/upload/image` | 17 | **Image uploads** |
| `NoUserAgent_HEADER` | `/feed/atom`, `/feed/atom/` | 36 | Feed readers that send no user agent |

Everything else in the group hits scanners or bots. Three that *looked* like false positives are not:
**`SQLi_COOKIE` on `/test.php` (57)** — that file contains no SQL, so the match is in the **cookie**, which
the scanner sends on every request regardless of target; the same explains `/info-request` (114) and
`/login` (57). **`CrossSiteScripting_BODY` on `autodiscover.xml` (167)** is Outlook posting XML, a false
positive with no consequence because the path 404s anyway. **`UserAgent_BadBots_HEADER`** on `/login`,
`/`, `/robots.txt` and real content paths is bots crawling real pages — exactly what should be blocked.

**What the other three groups need — and a pattern that predicts it.** Sorting matches by *which part of
the request* a rule inspects turns out to be highly regular:

- **`_URIPATH` rules never produced a false positive.** `ExploitablePaths_URIPATH`,
  `RestrictedExtensions_URIPATH`, `GenericLFI_URIPATH`, `WordPressExploitablePaths_URIPATH` hit only
  attack paths that legitimate traffic never requests.
- **`_BODY`, `_COOKIE` and `_QUERYARGUMENTS` are the problem zone.** They inspect user input, and user
  input sometimes looks like an attack. Every false-positive candidate found so far sits there.
- **`_HEADER` is mixed** — `UserAgent_BadBots_HEADER` is wanted, `NoUserAgent_HEADER` catches feed readers.

So the expectation for any future rule group: overrides are needed where a rule inspects user input *and*
the service actually accepts some — forms, uploads, tracking, search parameters. Groups that mostly match
paths are safe.

Applied to the remaining three:

| Group | Verdict | Basis |
|---|---|---|
| `KnownBadInputs` | **no override** — confirmed | `ExploitablePaths_URIPATH` hits only `.env` paths; `ReactJSRCE_BODY` on `/` came from `34.106.254.128` and `34.155.216.90`, both GCP, both direct-to-origin scanners |
| `WordPressRules` | **no override** expected | only `WordPressExploitablePaths_URIPATH` on `/xmlrpc.php` and `/xmlrpc.php0` |
| `SQLi` | **one, probably** — open | see below |

**Correction to the promotion order given above: `SQLi` is not verified clean.** The per-IP check covered
`/info-request`, `/login` and `/`, but two of its five largest entries were not in that set:
`SQLi_QUERYARGUMENTS` on **`/live` (62)** and **`/the-gallery` (58)**, arriving via Cloudflare edges
`172.71.127.63/.64/.89`.

And a second correction, to my own reasoning: **a Cloudflare edge address does not mean "legitimate
visitor".** These sites sit behind Cloudflare, so *every* request to the public hostname arrives from an
edge — an attacker's included. The real client is not in the WAF log because `WafClientIpHeader` is empty,
which is decision 1 blocking this too. What is suggestive rather than conclusive: only three edges, 120
hits over five hours at a steady ~24/h, which looks like one source rather than public traffic.

The query string settles it — `httpRequest.args` is in the log. A legitimate filter (`?sort=`,
`?category=`) means `SQLi_QUERYARGUMENTS` needs an override; `' OR 1=1` or `UNION SELECT` means the match
is real and `SQLi` stays promotable.

**Revised promotion order.** `SQLi` moves from "dangerous" to promotable: every SQLi match on the disputed
paths came from `3.172.95.0/24`, a CVE scanner, and none from Cloudflare. So: `KnownBadInputs` → `SQLi` →
`WordPressRules` → `CommonRuleSet` **with three `RuleActionOverrides`**. The rate rules stay meaningless
until `WafClientIpHeader` is set, which is decision 1.

**Use `RuleActionOverrides`, not `ExcludedRules`.** An exclusion removes the rule from evaluation
entirely; an override leaves it counting while the rest of the group enforces. Visibility is kept, only
enforcement is dropped where it would break something.

**One design question this raises, and it should be decided rather than defaulted.** Written as above the
override list is hardcoded in the resource, so **every change to it needs a template edit, a version bump
and a deploy**. That would be the first WAF setting that works this way — README line 198 states the
principle for everything else: "Kalibrieren endet damit überall in einer Parameteränderung, nicht in einem
Template-Eingriff." Three options:

- **Hardcode with a `Note`.** Defensible, because this set follows the *application* (Matomo, uploads,
  feeds), not calibration — it changes when a feature changes, maybe once a year. But when it does change,
  it is usually because something legitimate just got blocked, and at that moment a parameter is faster
  than a pull request.
- **Parameterise via `CommaDelimitedList` + `Fn::ForEach`.** Looks like it matches the principle exactly,
  but it needs the `AWS::LanguageExtensions` transform, and **that transform contradicts the principle it
  would be serving.** AWS documents that with it in place you must not use *Use existing template* /
  `--use-previous-template`: the transform resolves parameters to literals during processing, so a later
  update silently applies the **old** literals while appearing to succeed. Every promotion in this repo is
  exactly that kind of update. It also adds `CAPABILITY_AUTO_EXPAND` to direct stack updates and costs SAM
  CLI support. Ruled out 2026-09-10, and for the same reason the egress port set stays hardcoded.
- **Fixed optional slots** (`…CountOnlyRule1/2/3` each wrapped in `Fn::If`). Transform-free and
  parameterised, but ugly and capped at whatever number is chosen.

**The template change is the same either way, which is why it is worth making before the answer arrives:**
an explicit `Allow` for the health check path, evaluated ahead of the managed groups. If health checks are
inspected it is essential; if they are not it costs one rule and removes the question permanently. The
template defines both the health check path and the rule groups, so this belongs in the template rather
than a runbook — along with scope-downs for the feed paths and `autodiscover.xml`. Until that exists, the
promotion path below should not be followed past `KnownBadInputs`.

**5. ~~The database instruments are configured but not useful~~ — resolved 2026-09-08, and it shrank to
one change.** `RdsLongQueryTime` added to the cluster template (`1.6.0`, not deployed) with a default of
`2`, wired into `RdsclParameterGroup`; `RdsSlowQueryAlarmThreshold` stays at 5. Performance Insights turned
out to be **unavailable** on `db.t3.medium` for Aurora MySQL and moved to decision 7. Enhanced Monitoring
was dropped: it would not have helped in either incident and costs log ingestion.

The default of `2` is measured rather than habitual — the reasoning is in the parameter's own description
and rests on `Q57`: `SelectLatency` 1.09 ms and `InsertLatency` 0.18 ms as a weekly average against one
hour of `UpdateLatency` at 426 ms, plus HTTP durations of p95 0.47 s / p99 1.10 s over 303,621 requests,
which bounds query duration from above. `1` would also be defensible; `2` was chosen because roughly
twenty services share this database and their distributions were not measured.

**Found on the way, and worth its own line:** the same query showed that of the thirty slowest gwa requests
in the week 09-01 to 09-08, **twenty-seven fall into a single two-minute window on 2026-09-01, 06:38–06:39
UTC** — `/`, `/mitmachen/termine/` and `/cases/…` at 30–85 s, several concurrent `wp-cron.php` POSTs at
34–45 s, and 404 probes caught in the same jam. That is the 2026-09-08 pathology a week earlier, and with
2026-08-28/29 it makes **three** occurrences. Whether updown paged for it is not visible from here and
would have to come from its own history; in CloudWatch it was invisible, because `HTTPCode_ELB_5XX_Count`
carried no alarm. It is now the strongest argument for decision 2 that needs no attacker at all.

The original wording, kept for the reasoning: `slow_query_log` is on and exported, yet
`long_query_time` is unset, so the default 10 s applies and the log holds **five lines in fourteen days**.
It answered today's question by being empty, which is luck rather than design. `EnablePerformanceInsights`
and `MonitoringInterval` are absent entirely, so there is no top-SQL-by-wait-time — the first thing anyone
would want in a real database incident. Performance Insights at 7-day retention is free.

Not template work, recorded here only so it does not get merged in: the Apache request lifetime lives in
`docker-base-images-v2`, the `cookie_data` caching and the origin lockdown at Cloudflare and in
`SgPublicHttpHttps`, and the user enumeration in the GWA repo's mu-plugin.

---

## Open decisions

Not tasks. Each of these needs a call from the team before anyone writes code, and each stays open until
someone makes it. Written in English to match the rest of this file.

### 1. Lock the origin down to Cloudflare — and how far

**Decide:** whether `SgPublicHttpHttps` stops allowing `0.0.0.0/0`, by which mechanism, and whether a
second factor comes with it.

Today the group allows 80/443 from anywhere and is attached to the ALB, so Cloudflare is a recommendation
rather than a boundary. Measured on 2026-09-08: Hetzner, OVH, Vultr and GCP addresses appear as
`httpRequest.clientIp` in the WAF logs, i.e. reaching the ALB without traversing Cloudflare. The origin is
findable through certificate transparency, old DNS records, or scans of AWS ranges against the
certificate.

| Mechanism | Trade-off |
|---|---|
| CIDRs inline in the security group | ~22 rules; Cloudflare changes the list occasionally and the template goes stale silently — "stale" meaning real visitors get connection timeouts |
| **Customer-managed prefix list** (`AWS::EC2::PrefixList`) | Separates content from structure; the list can be refreshed without a stack update. Counts against the SG rule quota by its `MaxEntries`. The better fit |
| WAF IP set only | The connection is accepted first and dropped after — no protection against volume, and it costs per request |

**The part that must not be skipped:** restricting to Cloudflare's ranges is necessary but **not
sufficient**. Those ranges are shared by every Cloudflare customer, so anyone who knows the origin can put
it behind their own free Cloudflare account and arrive from an allowed range. Closing that needs either
authenticated origin pulls (mTLS, which the ALB would have to terminate) or a shared secret header set by
a Cloudflare Transform Rule and required by the listener rule — the latter is the proposal already
recorded on 2026-08-19/20 as "one template change, closes both bypasses", and it belongs in `ecsservice`
rather than the cluster template.

**Prerequisite measurement, before any of this is designed:** what legitimate traffic arrives *not* via
Cloudflare today. Known so far: `/_jobs/warmCache` from three OVH Canada addresses (118 requests) and
`3.172.95.x` — 25 addresses out of one /24 — hitting `/test.php`, `/info-request` and `/login`. Either
could be contracted monitoring or a cache warmer. Also needs checking: whether every Cloudflare DNS record
is "Proxied" rather than "DNS only", and what the `labor.show` staging hostnames resolve to.

**If undecided:** the Cloudflare rate-limit rule keeps covering an unknown share of traffic,
`WafClientIpHeader` cannot be set, WordPress keeps seeing Cloudflare edge addresses, and every edge control
below stays partly ineffective. This is the single decision that unblocks the most.

### 2. How far to go on the Apache request lifetime

**Decide:** `mod_reqtimeout` only, `Timeout 60` as well, or migrate to php-fpm.

`mod_reqtimeout` is cheap and low-risk but only closes the slow-send side. `Timeout 60` matches the ALB
but needs someone to confirm no admin task, import or `wp-cron` job legitimately runs longer. Only php-fpm
with `request_terminate_timeout` bounds the attack class by construction, and that is a base-image
migration affecting every PHP service, not just gwa.

**If undecided:** the next campaign of the same shape produces the same outage for the same effort. This
is the only item that addresses the 2026-09-08 incident itself.

### 3. WordPress access at GWA

**Decide, with GWA:** whether `PPW Admin` (`mpietz@ppw.de`, a shared account of an external agency holding
full administrator rights) keeps its access and in what form; whether `labor` and `gwa` remain role-named
administrators; whether external agency press accounts should hold 14-day "remember me" sessions; and
whether any second factor is introduced.

Six administrators exist, three of them not personal. No second factor is visible anywhere in the data. It
lines up with an enumerable username list and a nightly distributed login campaign — see the incident
section. Nothing here is broken today; all of it is a posture question that only GWA can answer.

### 4. Whether to pursue WAF promotion at all

**Decide:** whether the WAF moves past `count`, given what it is measurably worth.

Measured on 2026-09-08: the outage matched **no WAF rule**. `KnownBadInputs` counts a `.env` sweep that
runs into 404s anyway. `CommonRuleSet` is dominated by Outlook autodiscover false positives and fruitless
webshell hunting. `RateLimitSourceIp` counts Cloudflare edges and is meaningless until decision 1 is made.
Promotion also requires exclusions for `/info-request`, `/login`, `/` and the feed paths first, which needs
another measurement to identify the individual rule ids.

The honest summary is that WAF promotion is the weakest-justified item on the list. It may still be worth
doing — but as deliberate hardening, not as a response to this incident.

### 5. Customer communication

**Decide:** whether GWA gets a written incident summary, and with what content.

A customer-facing summary was produced for the 2026-08-28/29 outages
(`gwa-incident-summary-customer.md`). This incident has a comparable shape and a clean set of facts:
four minutes of outage, cause identified, no compromise, no data touched, no CVE involved. There is also
material that would *not* belong in a customer document — the administrator inventory, the credential
sweep against other services in the estate.

### 6. The `aut-web-web-p` catch-all

**Decide:** who raises it with that service's team, and whether it is treated as a bug or noted only.

Not our service and unrelated to this incident. It answers 200 to every unknown path, including roughly a
hundred credential probes; verified on 2026-09-08 that nothing is actually leaking. The cost is that real
leaks would be invisible, the service stays on scanner hit lists as a standing "success", and estate-wide
sweeps like `Q52` cannot be evaluated cleanly.

### 7. The Aurora instance class

**Decide:** whether `Rdsinstance1` stays on `db.t3.medium`. This surfaced on 2026-09-08 while looking for
Performance Insights and turned out to be two separate questions that had been running together.

Prices measured 2026-09-08, eu-central-1, Aurora MySQL, on-demand, single instance (the cluster has no
reader, so the factor is 1×). `max_connections` from the template's own formula, `log2(mem/805306368)*60`:

| Class | RAM | PI | USD/h | USD/month | vs today | `max_connections` | 2026-09-08 peak of 96 |
|---|---|---|---|---|---|---|---|
| `db.t3.medium` — running | 4 GiB | **no** | 0.0960 | 70.08 | — | ~145 | ~66 % |
| `db.t4g.medium` | 4 GiB | yes | **0.0850** | **62.05** | **−8.03** | ~145 | ~66 % |
| `db.t4g.large` | 8 GiB | yes | *unread* | *unread* | | ~205 | ~47 % |
| `db.r6g.large` | 16 GiB | yes | 0.3130 | 228.49 | +158.41 | ~265 | ~36 % |
| `db.r7g.large` / `r8g` | 16 GiB | yes | 0.3330 | 243.09 | +173.01 | ~265 | ~36 % |

**7a — Performance Insights. The numbers decide this one.** `db.t4g.medium` is the same size on Graviton2,
costs **8.03 USD/month less** (−11.5 %, ~96 USD/year) **and** supports Performance Insights, which
`db.t3.medium` does not. Cheaper and more capable, verified against the account with
`describe-orderable-db-instance-options` rather than from documentation — an earlier claim here that Aurora
excludes all t-classes from PI was wrong; it excludes t2 and t3, not t4g. The usual ARM caveat does not
apply: no code of ours runs on a database instance. (It very much would apply to the cluster's EC2
instances, where every image would need an ARM64 build — the opposite situation.)

**7b — Connection budget and burst mechanics. A real trade-off.** Only the r-class removes CPU credits
and lifts `max_connections` to ~265, at **+158.41 USD/month** (~1,900/year). `db.t4g.large` is the
untested middle: ~205 connections at presumably about double `t4g.medium`, but still burstable. Weigh it
against what actually happened — the 2026-09-04 estate-wide `1040` event, and one service holding two
thirds of the budget for 34 minutes on 2026-09-08 — and against AWS positioning t-classes on Aurora as
"development and test" while ~20 production services run on one.

**How the change would run, and why the cost is not the hard part.** `RdsInstanceType` has
`AllowedValues: ["db.t3.medium"]`, so any move is a template change first; leave the `Default` alone so
existing stacks are untouched and each region chooses. The parameter groups need nothing —
`aurora-mysql8.0` is architecture-independent and `max_connections` follows memory.

The real cost is the maintenance window. **With a single writer and no reader, a class change is not a
failover but a restart of the only instance** — all ~20 services lose the database at once, and after what
2026-09-08 showed about how they fail (PHP hangs, workers pin, a ~30-minute deregistration delay), that is
not a clean few minutes. The standard Aurora way around it: add `Rdsinstance2` as a reader already on the
target class, wait for sync, **fail over** (~30 s), change the old writer, then drop the extra reader.
Two stack updates and a few cents of instance time instead of an estate-wide outage. Bundle everything
that wants a restart into the same window — class, Performance Insights, and `long_query_time`. **Paris
first**, per the usual rollout, and let it run a few days before Frankfurt: an ARM switch on a managed
engine *should* be transparent, which is a claim until it has been watched once.

**Still unread, and needed before this is decided:** the prices for `db.t3.large` and `db.t4g.large`
(`Q56` covers them), and the **effective** `max_connections` off the running instance (`Q9`) — every
figure in the table above is arithmetic, not measurement. The ~66 % reading of the 96-connection peak
moves between roughly 66 and 69 % depending on how AWS reports `DBInstanceClassMemory`.

---

### 8. `10.1.3.7` — the LibreChat box in the Paris VPC

An EC2 instance in `labc-eu-w3`'s VPC that is **not** an ECS container instance. It runs the internal
LibreChat, placed in the staging region deliberately so that testing it could not endanger production —
but it is already used productively. Measured 2026-09-10 over 14 days of DNS logs: **1401 of roughly 1700
catch-all ALERTs come from this one host**, across 17 domains. `api.openai.com`, `api.mistral.ai`,
`api.githubcopilot.com`, `mcp.atlassian.com`, `mcp.slack.com`, `auth.atlassian.com`,
`login.microsoftonline.com` and `graph.microsoft.com` are the service's own dependencies — LLM backends,
MCP servers and what looks like Entra SSO. `api.snapcraft.io`, `cdn.fwupd.org` and `download.docker.com`
are host maintenance.

**The asymmetry that makes this a decision rather than a footnote.** The DNS Firewall associates per
`VpcId`, with no scoping to subnet, instance or security group — so this box is inside the enforcement
boundary whether or not anyone intended it. `SgEgress`, by contrast, reaches instances through the launch
template, so the box gets **no** egress restriction at all. It receives the control it tolerates least and
the hardening it would benefit from not at all. Flipping `DnsFirewallCatchAllAction` to `BLOCK` without
whitelisting its dependencies takes the whole service down at once.

**And it inverts the premise of the rollout order.** Paris was chosen as the place to flip first because
it is staging. With a production tenant in it, that is no longer true — `BLOCK` there now needs an
announced window, and LibreChat is the first thing to test afterwards, ahead of the websites. A chat that
stops answering is instantly visible to its users and invisible to every metric in this account.

**Options:**

1. **Its own VPC.** Resolves both directions: the box stops constraining what can be tried in staging, and
   it leaves the firewall's scope entirely. This is the option the original intent actually points at —
   isolation from production was the goal, and isolation from staging experiments turns out to be needed
   too. Cost depends on what it still needs from this VPC; if it is as self-contained as it looks, little.
2. **Whitelist it and keep it.** Cheap and legitimate — these are a production service's dependencies, not
   developer conveniences. Two caveats: the whitelist is VPC-wide, so every cluster service inherits the
   same permissions, which only starts to matter once egress is genuinely narrowed; and **a whitelist
   built from 14 days of traffic is systematically incomplete for a chat product** — a configured but
   rarely-chosen model provider never appears in the log and breaks the first time someone selects it.
   Build it from `librechat.yaml` and the MCP server list, then reconcile against the log.
3. **Leave the catch-all on `ALERT`** while the box is in this VPC. Costs nothing, decides nothing.

**Related gap, independent of the above:** the box carries no ECS service definition, so none of the
`ecsservice` alarms apply — no 5xx alarm, no health check, no target group. If LibreChat fails, nobody
learns of it except its users. Worth confirming whether updown.io already pings it.

### 9. Filtering the connection, not the lookup

Everything built so far governs **name resolution** or **port and destination**. Neither reaches the case
that matters against someone who already has code execution: an outbound TLS connection on `443` to an
address they chose. Two paths get there, and both are cheap for the attacker.

**A hardcoded IP needs no lookup at all.** The DNS Firewall answers questions; a process that never asks is
invisible to it. For legitimate software this is rare — almost everything uses names, which is why the query
log is such a good inventory. For malicious code it is the norm, precisely because DNS filtering is common.

**DNS-over-HTTPS is the sharper version.** It runs on `443` to resolvers whose addresses are compiled into
every client, so it needs no name resolution to bootstrap, bypasses the `53 → VPC CIDR` rule because it is
not port 53, and never touches the VPC resolver. On the wire it is indistinguishable from ordinary HTTPS.
DNS-over-TLS, by contrast, uses port 853 and is already closed by the port restriction — only DoH matters.

Neither can be closed with security groups: they allow, they do not deny, so with `443` open to `0.0.0.0/0`
individual addresses cannot be carved out. Closing it means inspecting the connection:

| Option | What it does | Rough cost |
|---|---|---|
| **AWS Network Firewall** | reads the TLS SNI and filters by domain on the connection itself; AWS documents it as the complement to DNS Firewall, which "does not have visibility into queries made by Route 53 VPC Resolver" | ~USD 290 per month per AZ plus data processing |
| **Forward proxy** (Squid, Envoy) | terminates and checks the requested host | cheaper in infrastructure, dearer in operations — every container needs configuring, and it becomes a single point of failure for all egress |
| **VPC endpoints first** | not a substitute, but it removes the AWS share from the internet path so what remains on `443` is a small, more suspicious set — and it is the measurement that tells you whether the rest is worth buying | ~USD 100–130 per month for interface endpoints across two AZs; the S3 gateway endpoint is free |
| **Deliberately not** | keep the free layer and accept the limit | 0 |

**The honest framing for the decision.** What is built catches malware and compromised dependencies that
call a domain — commodity ransomware, a poisoned npm or Composer package, scanners, miners in stock images.
That is the realistic threat for this estate and it costs nothing. It does not stop an adversary who looks
at the environment and adapts. Declining to buy the second layer is a legitimate call; it should be a
decision on the record rather than an assumption that the switch already covers it. The `EgressPolicy`
parameter description says the same thing at the point of use, so nobody reads the switch as more than it is.

Worth measuring before deciding: how much of the `443` traffic actually goes to AWS. `EnableEgressAnalysis`
for a week in Frankfurt answers both this and the port-set question for that region.

## Security posture — built vs. not built

> Checked against the templates on **2026-09-08**, not against notes. Covers the open AWS security
> security tickets — DNS Firewall audit and enforcement, FQDN whitelist, egress hardening on 443/587/123,
> GuardDuty quarantine automation, service-level 4xx/5xx alarms — plus the security-relevant items below. The detail for each line lives in the
> per-template sections; this table exists so the overall shape stays visible.

**The shape: everything that observes is built, almost nothing that prevents or delivers is.**
Flow logs, DNS query logs, WAF in count mode and GuardDuty all run. Egress rules, WAF `block`,
DNS `BLOCK`, the quarantine automation and finding delivery do not.

| Measure | In the templates? | Where |
|---|---|---|
| WAF in front of the ALB | ✅ six rules, all switchable `off`/`count`/`block` | cluster |
| WAF actually blocking | ❌ default `count` everywhere; `CommonRuleSet` needs exclusions first | cluster, open item |
| DNS Firewall in audit mode | ✅ whitelist ALLOW at prio 100, catch-all ALERT at 200, VPC association, query logging | cluster |
| DNS Firewall enforcing (`BLOCK`) | ⚠️ switchable from `1.7.0` (`DnsFirewallCatchAllAction`, `DnsFirewallBlockResponse`), still on `ALERT` everywhere and not deployed | cluster, Phase 4 |
| VPC Flow Logs | ✅ REJECT permanently, ACCEPT via `EnableEgressAnalysis` for baselining | cluster |
| **Egress hardening** | ❌ **none of the seven security groups sets `SecurityGroupEgress`, so all are allow-all** | cluster, open item |
| GuardDuty detector | ✅ enabled, `FIFTEEN_MINUTES` | guardduty |
| GuardDuty findings reaching anyone | ❌ no EventBridge rule to `AlertTopic` — console only | guardduty, open item |
| Quarantine security group | ✅ zero egress rules | guardduty |
| Quarantine automation | ❌ neither the SG-swapping Lambda nor its EventBridge trigger exists; only the IAM role does | guardduty, open item |
| Malware scanning | ❌ `ScanEc2InstanceWithFindings.EbsVolumes: false`. EBS only anyway — GuardDuty never covers EFS | guardduty, open item |
| Runtime monitoring | ❌ `RUNTIME_MONITORING` disabled — nothing inside a container is recorded | guardduty, open item |
| EFS root mount off the instances | ✅ out of the launch template | cluster (3 Frankfurt instances still carry it at runtime) |
| Service-level 4xx/5xx alarms | ✅ anomaly band on 4xx, threshold alarm on 5xx, each with its own switch from `1.6.0` | ecsservice |
| Central alert topic | ✅ `AlertTopicArn`, imported by every service stack | cluster |
| Alerts actually delivered | ⚠️ Paris: all nine cluster alarms silent. Frankfurt: three of nine notify | see Cluster state |
| ALB reachable only via the proxy | ❌ `SgPublicHttpHttps` open to `0.0.0.0/0`, no origin-verify header, listener default forwards instead of 403 | cluster, three open items |
| Secrets out of the task definition | ❌ `DOPPLER_TOKEN` is a plaintext environment variable, readable via `ecs:DescribeTaskDefinition` | ecsservice, open item |
| RDS auth | ❌ static shared master password, no IAM database authentication | cluster, open item |
| ALB log bucket hardening | ❌ no TLS-only deny, no `OwnershipControls`, no `aws:SourceAccount` guard | alb-logs-bucket, three open items |

Two consequences worth stating plainly. **Enforcing DNS `BLOCK` while egress is unrestricted buys
little** — an application that skips name resolution and dials an IP is unaffected, so the two belong
in one step, not two. And **detection without delivery is the quietest failure mode there is**: the
finding exists, the alarm turns red, and nobody learns of it.

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
    the threshold off the measured distribution first — the `RejectedConnections` percentile query is in the
    [Query appendix](#query-appendix).
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
- [ ] **`AscalegroupDesSize` fights managed scaling — and Frankfurt is one instance from the wall.**
  *(The trap itself is a template property and now lives in the README; what follows is the measurement.)*
  Its `MaxValue: 15` is below what ECS managed scaling actually runs, so a cluster update pushes desired
  capacity down and **terminates instances** — tasks are dropped rather than drained, because
  `ManagedTerminationProtection` is `DISABLED`. Measured 2026-09-07: Frankfurt runs 14 while its ASG is
  allowed up to 30, so a single scale-out to 16 during a change-set window would make the parameter
  unable to express reality, and executing anyway would drop the tasks of two instances. Lift the bound
  and consider enabling termination protection.
- [ ] **Decide the log retention conflict — Frankfurt only, Paris is clean.** Two groups were raised by hand while the template says
  `14`; any edit to that line pushes `14` back and deletes the excess, and both hold personal data.
  Either accept 14 or raise the hardcoded value. A parameter is not the route — `WafLogRetentionDays`
  was removed on 2026-08-28 precisely so retention is not tunable per stack.
- [x] **`DnsFirewallCatchAllAction` and `DnsFirewallBlockResponse` added, cluster template `1.7.0`**
  (2026-09-09, not deployed). The catch-all action was a literal `"ALERT"`, so flipping it via the CLI was
  drift the next stack update silently reverted; it is now `{"Ref": "DnsFirewallCatchAllAction"}` with
  `ALERT`/`BLOCK` and the safe default. `BlockResponse` came with it — Route 53 **rejects** the property on
  an `ALERT` rule, so it is wrapped in `Fn::If` against `DnsFirewallCatchAllBlocks` and resolves to
  `AWS::NoValue` outside `BLOCK`. `NXDOMAIN` is the default over `NODATA`: it reports the domain as
  non-existent and surfaces at once as a lookup failure, where `NODATA` reports the name as existing
  without a record of that type and some clients retry other types before giving up. `OVERRIDE` is not
  offered — it needs a substitute domain and TTL and belongs to a different use case.
  Rollback is now a parameter update to `ALERT`, not a template edit. **This unblocks Phase 4 mechanically
  but does not make it safe** — see the whitelist prerequisite there, and note that `BLOCK` on the name
  layer means little while `53/UDP` is unrestricted at the network layer, since a process can query an
  external resolver or dial an IP outright.
- [ ] **Enforce the origin-verify header on the listener rules** (`http-header` condition).
  `cloudfront-alb-distribution` already *sends* it; only enforcement is missing. Closes the Cloudflare
  **and** CloudFront bypass in one change, and is the remaining designed fix for the Solr exposure now
  that the internal ALB is gone. Design and limits: `git log -p TASKS.md`.
- [ ] **Make the listeners' default action a `fixed-response` 403.** Both currently forward to the
  empty `Deftarget`, which yields 503 — harmless only by accident.
- [x] **Egress policy in cluster `1.7.0`** (2026-09-10, not deployed). Briefly removed and rebuilt the same
  day, which dropped `AllowHttpEgress` along the way — see the port-80 decision below. What it is:
  - `SgEgress`, a dedicated security group carrying the whole outbound policy, added as a fourth group on
    the launch template. It has to be its own group because **rule sets are additive**: `SgVpcMysqlAccess`,
    `SgVpcLoadbalancerports` and `SgVpcEfsAccess` all sit on the launch template, so restricting one while
    the others still permit everything achieves nothing.
  - Under enforcement the three existing groups carry a placeholder rule to `127.0.0.1/32`. That is not
    decoration: **an empty `SecurityGroupEgress` list makes CloudFormation recreate the default allow-all**,
    so "no egress" has to be written as a rule that reaches nowhere.
  - An `EgressPolicy` switch (`open`/`restricted`) defaulting to `open`, so the release is inert and the
    rollback is a parameter update.
  - ⚠️ **The ordering hazard, which is the part worth remembering.** `SgEgress` reaches an instance through
    the launch template, and the `Ascalegroup` has no `UpdatePolicy` — a template change does not roll the
    fleet. Instances still running an older launch template version never receive the group, while
    neutralising the three existing groups hits their ENIs immediately. Flipping to `restricted` before the
    fleet has been rolled therefore strips **all** outbound access from those instances. Verify first:
    ```bash
    aws ec2 describe-instances --filters Name=tag:Name,Values=<stack>-Instance \
      --query 'Reservations[].Instances[].[InstanceId,SecurityGroups[].GroupName]' --output text
    ```
  - Deliberately not applied to `SgPublicHttpHttps`, `SgVpcLoadbalancerportsAccess`, `SgVpcMysql` or
    `SgVpcEfs`: the ALB needs egress to its targets, and the other two initiate nothing outbound.

- [ ] **The target set — four rules:** `443/TCP` anywhere; `587/TCP` to the SMTP relay; `4318/TCP` to the
  OTLP collector; `53/UDP+TCP` to the **VPC CIDR only**.
  - **`80/TCP` is out, decided 2026-09-10.** No cluster instance used it in 28 days of ACCEPT flow logs —
    only the standalone Ubuntu box, for `apt`, and that box is not on the launch template so it would never
    receive the rule anyway. The OCSP/CRL counter-argument is weaker than it first looked: stapling moves
    the fetch to the server, server-side TLS libraries mostly do not check at all, and Let's Encrypt has
    dropped OCSP entirely. The decisive point is that **a missing port announces itself and a missing DNS
    entry does not** — that is the whole gain of the hardening, since legitimate traffic stops producing
    rejections and every `REJECT` becomes a signal with source and destination attached. So no pre-emptive
    switch: if something does need it, the log says so, and the rule can then be written to a real
    destination rather than `0.0.0.0/0`. An earlier `AllowHttpEgress` parameter existed for this and was
    removed.
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
  - **`53/UDP` to `8.8.8.8` — re-measured 2026-09-10, and it is not the blocker it was recorded as.**
    Over 14 days of ACCEPT flow logs there are exactly **two** sources, `10.1.4.226` and `10.1.1.202`,
    with **4 flows and 320 bytes each**. `10.1.1.202` is the NAT gateway ENI, i.e. the same traffic
    counted again after translation — proven in the same result set, where `10.1.3.38` and `10.1.4.226`
    each appear twice on port 4318 with byte counts identical to the digit (`89724`/`89724`,
    `80935`/`80935`), once to the collector and once to `10.1.1.202`. So the real source set is **one
    cluster host**, and its entire external resolution amounts to roughly four queries in a fortnight.
  - **The earlier "three cluster hosts, and exactly those three send OTLP" is therefore wrong.** It was an
    overlap argument built on the NAT double-count. Restricting `53` to the VPC CIDR costs those four
    queries and nothing else: `fly-otel-collector-prod.fly.dev` appears in the DNS Firewall log, so the
    collector name **is** resolved through the VPC resolver in normal operation. `8.8.8.8` is an occasional
    fallback, not the path.
  - **Consequence: the OTel resolver is no longer a precondition for `EgressPolicy=restricted`.** It stays
    worth fixing for tidiness, and flipping the switch in Paris will surface whatever falls back — but it
    does not gate the change.
  - **Attribution of the fly.io traffic** (`oidc.fly.io`, `api.machines.dev`, `api.depot.dev`,
    `flyctl-metrics.fly.dev`, `fly-otel-collector-prod.fly.dev`, `clientsdk.launchdarkly.com`,
    `*.supabase.co`, plus customer project names like `heckelsmueller-*.fly.dev`): it is the webpage
    builder, which deploys customer sites to fly.io, and the OTLP collector is part of that same service
    rather than a separate agent. Seen from `10.1.3.38` (then running `ado-ael-sub-s`, `ado-ede-new-s`,
    `lab-fac-mul-s`, `lab-web-bac-s`) and `10.1.4.226` (then running `lab-dev-ema-s`). **Treat the
    host→service mapping as indicative only** — `describe-tasks` is a snapshot while the logs span 14 days,
    and ECS moves tasks; `lab-fac-mul-s` (labor-factory-multitenant) is the likely emitter on the name, not
    on evidence.
  - **Ports and destinations both come from one parameter, `EgressExtraRules`,** as `port:cidr` pairs —
    default `587:95.217.210.26/32,4318:149.248.216.54/32`, up to four, `0:0.0.0.0/0` for none. Port and
    destination travel in the same entry deliberately: two parallel lists that drift out of alignment open
    a port to the wrong destination and nothing complains. Two rules sit outside it and cannot be switched
    off — `443/TCP` to `0.0.0.0/0` and `53/UDP+TCP` to the VPC CIDR.
  - **Why destinations matter at all**, given how much of this document says the DNS layer is the control:
    the DNS Firewall never sees a connection. It answers or refuses a lookup, and a process that already
    holds an IP connects without asking. The cidr in a security group rule is therefore the only thing in
    this template that limits where traffic may actually go. An earlier note here argued that pinning
    `587` and `4318` "buys little while 443 is open anyway" — true of those two ports in isolation, wrong
    as a general principle, and retracted.
  - **`443` cannot be pinned**, which is a property of the problem rather than a preference: third-party
    services are reached by name and their addresses change, so a pinned rule breaks silently whenever a
    CDN moves. Narrowing it needs VPC endpoints for the AWS share and a proxy or Network Firewall for the
    rest — see the open decision on connection-layer filtering.
  - **Four fixed slots, not a list.** Plain CloudFormation cannot build N rules from a list of unknown
    length: no `Fn::ForEach`, no `Fn::Contains`. The options were a fixed rule set, one boolean parameter
    per port (tried as `AllowHttpEgress`, removed as clutter), or the `AWS::LanguageExtensions` transform.
    **The transform is the wrong trade here.** AWS documents that with it in place you should not use
    *Use existing template* / `--use-previous-template`, because it resolves parameters to literals during
    processing and a later update then applies the **old** literals while appearing to succeed. That is the
    exact mechanism every promotion in this repo relies on. It also adds `CAPABILITY_AUTO_EXPAND` and drops
    SAM CLI support for `Fn::ForEach`. More than four extra rules therefore means a template change, which
    is honest about how often the port set moves.
  - **The SMTP relay is `95.217.210.26`, measured 2026-09-10** over 14 days of ACCEPT flow logs. One
    destination, reached from three cluster instances (`10.1.3.59`, `10.1.4.186`, `10.1.4.226`). Everything
    else on ports 25/465/587 in that result set runs the other way: external addresses hitting the NAT
    gateway's public IP at 92–736 bytes apiece, i.e. scans looking for an open relay. Nothing listens
    there, and inbound traffic is irrelevant to an egress rule.
  - **The OTLP collector is `149.248.216.54`** (`fly-otel-collector-prod.fly.dev`), and that rule exists
    only because the collector listens on 4318 rather than 443 — on 443 it would already be covered. It is
    the most fragile of the pinned entries: a `/32` to a third-party SaaS host whose address is not
    contractually stable, and when it moves telemetry fails silently. Moving the endpoint to 443 would
    remove the rule outright and is the better fix.
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
- [ ] **Drop the redundant `DependsOn` entries — 110 across three templates.** `cfn-lint 1.56.1` reports
  `W3005` 88× in `ecscluster-vpc-rds-asg`, 13× in `ecsservice` and 9× in
  `ecscluster-ext-additional-cluster`: every one is a `DependsOn` naming a resource the same block already
  reaches through a `Ref` or `Fn::GetAtt`, which CloudFormation derives on its own. They are inert, not
  wrong — the reason to remove them is that a hand-maintained list drifts. `SgEgress` was added to the
  launch template's `Groups` **and** its `DependsOn` in `1.7.0` purely to match the surrounding style; the
  next person adding a group there will copy the pattern and eventually forget one half, at which point
  the list says something untrue about the graph.
  Do it as its own commit with no other change, so the diff is reviewable at a glance and a real ordering
  constraint is not lost in the noise. **Check each one before deleting it** — a `DependsOn` is only
  redundant when the dependency is expressed in the *same* resource; ordering that exists for a reason
  outside the property graph (IAM propagation, a log group that must precede its subscriber) has to stay,
  and `cfn-lint` cannot tell the difference.
  ```bash
  cfn-lint --format json <template> | python3 -c "import sys,json;[print(m['Location']['Start']['LineNumber'], m['Message']) for m in json.load(sys.stdin) if m['Rule']['Id']=='W3005']"
  ```

- [ ] **Two further `cfn-lint` findings in `ecscluster-ext-additional-cluster`**, untouched since the
  scan on 2026-09-09: `W2506` — the `ImageId` parameter is a plain `String` where
  `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` would let CloudFormation resolve and validate it; and
  `W3697` — it uses a resource type from a service AWS has put into maintenance mode. Neither is urgent;
  both are worth knowing before anyone extends that template.

- [ ] **Custom widget for template versions across all stacks.** The most-repeated CloudShell query in this
  repo is "which stack runs which version" — it is the top of the Cluster state table above and it was
  asked half a dozen times during the 2026-09-09/10 rollouts. It is not a metric, so it needs a
  `"type": "custom"` widget: the dashboard invokes a Lambda on render, the Lambda calls
  `cloudformation:DescribeStacks`, filters on the `TemplateVersion` output, and returns HTML. Roughly forty
  lines of inline Python plus an IAM role and a `AWS::Lambda::Permission` for the dashboard to invoke it —
  the same shape as the `ImageResolver`, so the pattern is not foreign here.
  Two more that would fit the same widget once it exists, both also API rather than metric: **image drift**
  (the CloudFormation task-definition revision against the one the service actually runs, which is case 4
  in *Wann ein altes Image zurückkommt*) and **`SgEgress` membership** (whether every running instance
  carries the group — the precondition for `EgressPolicy=restricted`, currently a manual check).
  Cost is a Lambda invocation per dashboard render, so effectively nothing.
  Deliberately not built alongside the widgets in `1.7.0`: those were pure dashboard JSON, this adds a
  function and a role to the cluster template and deserves its own change.

- [ ] **Metric widgets that could still be added, no Lambda needed:** WAF counted requests per rule group
  (the `AWS/WAFV2` metrics already carry the alarms), ALB `HTTPCode_ELB_5XX_Count` next to
  `HTTPCode_Target_5XX_Count`, and running-versus-desired task count per service. None is urgent; they are
  listed so the next person extending the dashboard does not have to rediscover what is available.

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
  `cfn-lint` flags the intermediate step separately (`W1011`): `RdsMasterPassword` is a `NoEcho` parameter
  where `{{resolve:secretsmanager:...}}` would keep the value out of the stack's parameter set entirely.
  That is a smaller change than IAM auth and independent of it — worth doing first if IAM auth stalls on
  the application side.

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

0. **Phase 1.5 — the counting and alarming defects, fixed in `1.7.0` (2026-09-09/10, not deployed).** The metric filter
   matched `firewall_rule_action = "ALERT"` only, so `AlertedQueries` — and with it
   `${Stack}-dns-firewall-alert-surge` and the saved query — would have gone to zero the moment the
   catch-all was flipped, because the firewall then writes `BLOCK` instead. Enforcement would have
   arrived together with the loss of its own indicator. There is now a second filter on `BLOCK` feeding
   `BlockedQueries`, and `DnsFireWallLogsSummary` selects both actions and reports which one applied.
   Found by reading the filter pattern, not by an incident.

   **Second defect, same area: nothing would have told you the whitelist was incomplete.** The surge alarm
   is dimensioned for volume — 100 alerts per 5 minutes against measured traffic of about four per hour —
   so a single missing entry could never move it. Under `ALERT` that is correct, since alerts are the normal
   state there. Under `BLOCK` it inverts: a refused query is either an attack or a gap in the whitelist,
   and both deserve the first occurrence rather than the hundredth. `1.7.0` therefore adds
   `DnsFirewallBlockAlarm` on `BlockedQueries` with a threshold of `0` and `DnsFirewallBlockAlarmAction`
   defaulting to **`alert`** — the only alarm in either template that does, justified by the condition
   `DnsFirewallCatchAllBlocks`: it is not created at all while the catch-all is `ALERT`, so it ships inert.
   The surge alarm goes back to watching `AlertedQueries` alone, since the two now answer separate
   questions. What still does not exist is a novelty detector for the `ALERT` phase — metric filters count
   matches, they do not track domain cardinality — but the pre-`BLOCK` criterion is "the alert rate reaches
   zero and stays there", which the existing metric shows.

1. **Phase 2 — build the whitelist.** Run `DnsFireWallLogsSummary`, group ALERT'd domains by frequency,
   split legitimate from noise, aggregate by root domain, then update `DnsFirewallWhitelistDomains`.
   The wildcard replaces the leftmost label entirely and covers **any** depth beneath it, so
   `*.example.com` matches `a.b.example.com` too; it does not cover the apex, which needs its own entry.
   **The image pull is the trap** — a `BLOCK` catch-all does not disturb a running container, it breaks the
   pull at the **next task placement**, so an application test passes while nothing can restart or scale.
   Test with a forced deployment, not by loading the site. ECR itself is covered by `*.amazonaws.com` for
   both regions, verified against the logs rather than assumed; Docker Hub for the Matomo and Solr images
   is not, so `registry-1.docker.io` and `auth.docker.io` need `*.docker.io`, and the layer CDN needs its
   own entry. Docker Hub for the Matomo and Solr images: `registry-1.docker.io`, `auth.docker.io`, layer
   CDN. `suche.gwa.de` stays whitelisted permanently — the application resolves it via NAT, so a
   `BLOCK` catch-all breaks search silently.
   **Settled 2026-09-10, with the AWS documentation behind it. The cause was never wildcards — it is
   CNAME-chain inspection.** DNS Firewall inspects **every** link of a redirection chain by default
   (`FirewallDomainRedirectionAction: INSPECT_REDIRECTION_DOMAIN`), and a whitelisted name whose chain
   leaves the list therefore still trips the catch-all — **logged under the original query name**, which is
   why it read as a broken whitelist entry. Verified by resolution: `login.microsoftonline.com` is covered
   by `*.microsoftonline.com` and alerted continuously for 14 days because its chain runs
   `login.mso.msidentity.com` → `ak.privatelink.msidentity.com` → `www.tm.a.prd.aadg.trafficmanager.net`,
   and `*.msidentity.com` is not listed. Same for `graph.microsoft.com`; `download.docker.com` goes via
   `d2h67oheeuigaw.cloudfront.net`. That `*.trafficmanager.net` and `*.akadns.net` already sit on the list
   is the fingerprint of someone tracing this chain once and stopping one link short.

   **Two earlier readings here were wrong and are retracted.** Wildcards do work — `*.example.com` covers
   any depth beneath it, though not the apex, which needs its own entry. And the `amazonaws.com` names are
   not "never evaluated": they are allowed by `*.amazonaws.com`, and `ALLOW` writes no log record at all,
   so an allowed query is indistinguishable in the log from an unevaluated one. The 1573-versus-137,939
   count that seemed to prove non-inspection proves only that ALLOW is silent.

   **Fixed in `1.7.0`** by `DnsFirewallRedirectionAction`, defaulting to `TRUST_REDIRECTION_DOMAIN` on the
   allow rule. The full reasoning is in the parameter description; the short form is that `INSPECT` forces
   `*.cloudfront.net` — the whole of CloudFront — onto the allow list just to pass `download.docker.com`,
   which is a wider grant than trusting Docker's own chain, and the dangling-subdomain scenario `INSPECT`
   would defend against lands on `*.amazonaws.com` anyway, which this list already allows.

   **This was the real hazard for `BLOCK`,** not the registry hostnames: with chain inspection on, a
   blocking catch-all takes down every allowed domain served through a CDN, which is most of them. It
   would have looked like the whitelist was complete right up to the moment it wasn't.

   Still true and still worth keeping: `suche.gwa.de` must stay whitelisted permanently in Frankfurt,
   because the application resolves it via NAT and a `BLOCK` catch-all would break search without an error
   anywhere.

- [ ] **Optional later: split the allow rule into a trusted and an inspected list.** A rule group can hold
  several rules, each with its own domain list *and* its own redirection setting, evaluated by priority
  with first match winning — so `trusted` (ALLOW, `TRUST`) at 100, `inspected` (ALLOW, `INSPECT`) at 150
  and the catch-all at 200 is expressible. **The trigger is not the egress work.** That coupling was
  asserted here and does not hold: prefix lists exist only for AWS services, so `443` stays open to
  `0.0.0.0/0` for third-party APIs whose addresses cannot be enumerated, and the IP path stays open
  regardless. The actual trigger is a specific entry whose chain somebody does not want to trust — a
  wildcard over a domain with third-party-controlled subdomains, say. No current entry qualifies.

2. **Phase 3 — security groups.** The egress-rule replacement above. It needs a baseline first: set
   `EnableEgressAnalysis=true` for 7–14 days to get ACCEPT-mode flow logs, then back to `false` — they
   bill per GB and dominate logging cost while they run. Blocked on identifying the last unknown flow
   (`3724/TCP → 145.239.131.113`, OVH — **did not occur in Paris at all in the 28 days to 2026-09-05**,
   so probably gone; confirm against Frankfurt, then close) and on the OTel resolver fix.
3. **Phase 4 — flip to `BLOCK`.** The `DnsFirewallCatchAllAction` parameter exists from `1.7.0`. Re-run
   `DnsFireWallLogsSummary`, confirm no legitimate domain still ALERTs, then set `BLOCK`. Test the
   applications, e-mail, time sync **and image pulls**; watch 48 h. Rollback is `ALERT`.

## `ecsservice`

- [ ] **Every deploy of a single-task service has a gap.** Built as `ecsservice` `1.7.0` on 2026-09-10 and
  reverted the same day, once it turned out not to be the cause of the alarms that prompted it - the change
  is worth making on its own evidence, but not as a side effect of chasing something else. Rebuilding it is
  two parameters: `ServiceMinimumHealthyPercent` (Number, default 100, wired into
  `DeploymentConfiguration`) and `ServiceSlowStartSeconds` (Number, default 0, as the target-group
  attribute `load_balancing.slow_start.duration_seconds`).
  `MinimumHealthyPercent` is hardcoded at `50` — unchanged since the
  file was first committed — and on a service running a single task that resolves to `floor(1 × 0.5) = 0`.
  ECS is therefore permitted to stop the only task before starting its replacement, and the new one needs
  `HealthyThresholdCount 2 × HealthCheckIntervalSeconds 45` = **90 seconds** before it takes traffic. That
  is arithmetic rather than inference: every such deploy is roughly a minute and a half of `503`. The
  earlier note that "deploys contribute legitimately" to the ELB 5xx threshold was the wrong reading and is
  withdrawn — that is an outage being reported correctly, not noise.
  **What this does not explain** is the alarm pattern on `lab-dev-ema-s` below. Seven deployments and five
  alarms on 2026-09-10 do not line up: two deploys produced nothing, two alarms had no deploy near them,
  and one began seven minutes after a deployment had already completed. The gap also produces
  `HTTPCode_ELB_5XX_Count`, a missing target, while that alarm watches `HTTPCode_Target_5XX_Count`, errors
  the container itself returned. Different metric, different cause.
  When querying either by hand, note the alarm carries **two** dimensions, `TargetGroup` and `LoadBalancer`
  — CloudWatch keys metrics on the full dimension set, so a query with only one returns nothing and looks
  like an absence of errors.
  At `100` the replacement starts first and the old task drains only once the new one is healthy. The cost
  is capacity — the cluster needs room for one extra task during a rollout, and without it the deployment
  waits rather than briefly failing. `ServiceSlowStartSeconds` addresses a different failure: a container
  that passes its health check before it is warm. The two show up in different metrics — a missing task is
  `HTTPCode_ELB_5XX_Count`, a container answering too early is `HTTPCode_Target_5XX_Count`.

- [ ] **`lab-dev-ema-s` 5xx bursts: identified 2026-09-10 — `/favicon.ico` returns 500 on every page view.**
  The service ships no static favicon, so the request falls through to the Slim catch-all route, which
  reads the path segment as a template directory and hands it to `Finder->in()`:
  `DirectoryNotFoundException: "/var/www/html/backend/../emails/templates/favicon.ico" does not exist`,
  PHP fatal, 500. Every page view produces exactly one — the log shows `.../Mail 1/index.html` 200 followed
  by `/favicon.ico` 500, repeating.
  **Fix belongs in the application**: serve a real favicon, or match the path before the catch-all.
  Two things this corrects. The alarms looked deploy-correlated and are not — somebody opens the tool to
  check a deployment, the browser fetches the favicon, the alarm fires; the two deploys that nobody looked
  at afterwards produced nothing. And the idea of re-expressing the 5xx alarm as an error *ratio* is
  withdrawn: at 6 failures in 14 requests the ratio is 43 %, so a ratio alarm would have fired just the
  same. **The alarm did its job** — it surfaced a real defect that had been running for weeks unnoticed.
  The traffic profile is worth remembering when reading this service's numbers: 29 requests in half an
  hour, all in a two-minute burst. Absolute thresholds behave very differently at that volume.

- [ ] **Superseded context, kept for the measurement:** `lab-dev-ema-s` recurring 5xx bursts. Its
  `AlarmHttp5xxTarget` (threshold 5 per 5 min) went to ALARM 18 times between 2026-08-25 and 2026-09-07,
  roughly every one to two days and sometimes several times a day. Only one of those falls inside our
  own testing window (2026-09-07 14:21, coinciding with a pipeline deploy); the other 17 predate it.
  Found while measuring alarm noise for the switch rework — not chased.
  Context worth keeping: across all 15 Paris stacks, 43 of 45 service alarms have never fired. The
  exceptions are this one, plus `tro-tro-web-s` (HighMemory ×2, 5xx ×1) and `tro-cur-web-s`
  (HighMemory ×1). `AlarmHighCpu` has never fired anywhere, which matches the sub-1 % baseline.
  So the 5xx alarm is the only service alarm that finds anything — and in Frankfurt it does not exist
  on 18 of 19 stacks.


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
  and in the README; the measurements are above.
  `1.6.0` adds the one property line, bumps `TemplateVersion`, and rewrites the `ProjectToken`
  description — it carried a warning that a standalone rotation reverts the image, which is no longer
  true from `1.6.0` on and stays documented for `1.5.0` and earlier.

- [x] **Per-alarm `off`/`dashboard`/`alert` switches for `ecsservice`, folded into `1.6.0`** (2026-09-08,
  deployed across Paris 2026-09-09, Frankfurt pending). The six notifying alarms each got a switch matching the cluster template, so
  threshold and switch are separate. Two defects disappear with it: `0` meant the opposite thing in the
  two templates (`RdsErrorAlarmThreshold: 0` means "alert on any error", `ServiceHttp5xxTargetThreshold: 0`
  meant "no alarm"), and "alarm on any 5xx" was inexpressible. The two autoscaling alarms are untouched —
  their actions are scaling policies, not notifications.
  Defaults chosen off measurements in both regions, not preference: `dashboard` for HighCpu, HighMemory,
  5xx and the 4xx anomaly band; `off` for LowCpu and LowMemory, because their threshold is `0` everywhere
  and `LessThanThreshold` against `0` can never fire — switching them on would create coverage that only
  looks like coverage. `EnableHttp4xxAnomalyAlarm` is gone, absorbed into
  `ServiceHttp4xxAnomalyAlarmAction`.
  Why this was folded in rather than shipped later: Frankfurt's service rollout is a one-time operation
  over 19 production stacks, and a second pass to add alarm switches is exactly what the version choice
  was meant to avoid. `1.6.0` had not been deployed anywhere, so amending it beat burning a version.
  **What this changes on upgrade:** Paris loses notification on HighCpu/HighMemory/5xx (all currently
  notifying) — acceptable, since 43 of 45 alarms there have never fired. Frankfurt's 17 stacks without
  any service alarms gain HighCpu, HighMemory, 5xx and the 4xx band **silently**, which is the first
  service-level coverage they have ever had.

  **Checked and consciously not closed** (2026-09-07): with `1.6.0` all seven task-affecting parameters
  are resolver properties, and the only `Fn::If` in the task block hangs off `ContainerCommand`, which is
  one. Two non-parameter inputs remain. `TaskRole.Arn` is deterministic (`${AWS::StackName}-TaskRole`)
  and cannot change without a new stack. `Fn::ImportValue: ${ClusterStackName}-Efs` feeds
  `FilesystemId` directly, so replacing the cluster's EFS would rewrite the task definition in all 15
  service stacks at once while no resolver property changes — case 1, fifteen times over. Passing the
  import as an extra resolver property would close it; judged not worth it. Related: **removing the EFS
  volume from the template is itself a case 2** — it changes the task block without touching a property,
  so that change has to carry a fresh `InitialDockerImage`.

- [ ] **Replace the three Frankfurt instances that still carry the EFS root mount** (measured
  2026-09-08): `i-0edc996a3a34c27e0`, `i-03781a7452fa2e145`, `i-049dd7042c56d561e`. They are exactly the
  three running `ami-00a84437cf2b97861`; the other eleven run `ami-070722d1cfd0ddeec` and are clean, so
  the mount belongs to the older AMI generation and a replacement is guaranteed to come up without it.
  Drain, terminate with `--no-should-decrement-desired-capacity`, let the ASG restock —
  `ManagedTerminationProtection` is `DISABLED`, so terminating without draining first drops tasks.
  **Do this after the service rollout**, not during: two sources of task movement at once make any
  restart impossible to attribute.

- [x] **`1.6.0` verified on `lab-dev-ema-s`** (2026-09-07 23:07). Change set was exactly what the
  version promises: `Add` for `AlarmHttp4xxTarget` plus its `BaselineHttp4xxTarget` (the anomaly pair
  appears for the first time, since its switch now defaults to `dashboard` instead of the old `false`),
  `Modify` on the three existing alarms as they go to `ActionsEnabled: false`, no `Remove` (the Low
  alarms never existed and `off` keeps it that way), nothing replaced. Afterwards: six alarms, the two
  autoscaling ones notifying (their actions are scaling policies) and the four reporting ones silent.
  Then `ProjectToken` was rotated on the real template, not the throwaway: the resolver woke, read the
  running image, CloudFormation registered `:113` with it and the service followed — `cfn == live`.
  `ecsservice/noecho-test.template` deleted.

- [ ] **Roll `1.6.0` to Paris**, the remaining 14 stacks. Same shape as the `1.5.0` rollout: template-only, all
  parameters kept. Unlike the `1.5.0` rollout this one *will* wake the resolver on every stack, because
  `ProjectToken` joins the resolver's properties —
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
  the rollout verification loops in the [Query appendix](#query-appendix) (stack → image → ECR push date);
  what is missing is having it run
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

---

## Query appendix

The blocks the sections above cite. Every one was run against a live account; where a query was later
found wrong, the corrected form is the one kept. Two things to know before pasting anything: **`AWS_REGION`
beats `AWS_DEFAULT_REGION`**, so set both or a read silently goes to the wrong region, and CloudShell pulls
indentation along on paste, which makes multi-line Python fail with `IndentationError` and leaves a
heredoc waiting for a terminator it will never match.

### The two helpers

Both carry their own log group name. An earlier version read it from an external variable, which survives
a CloudShell restart as a defined function with an empty group and fails with `Invalid length for
parameter logGroupName` instead of anything readable. The WAF helper is called `wafq` rather than `w`
because `w` is a standard Unix binary that lists logged-in users — after a restart it takes over silently
and prints something that looks like nothing at all.

```bash
export AWS_PAGER="" AWS_DEFAULT_REGION=eu-central-1 AWS_REGION=eu-central-1

# Apache access log of one service
q() { local LG=${LG:-gwa-gut-web-p-LogGroup}
      qid=$(aws logs start-query --log-group-name "$LG" \
      --start-time $(date -u -d "$1" +%s) --end-time $(date -u -d "$2" +%s) \
      --query-string "$3" --limit 200 --query queryId --output text) || return 1
      until [ "$(aws logs get-query-results --query-id "$qid" --query status --output text)" != "Running" ]; do sleep 2; done
      aws logs get-query-results --query-id "$qid" --query 'results[*][*].value' --output text; }

# WAF log of one cluster
wafq() { local LG=${WAFLG:-aws-waf-logs-labc-eu-c1-waf}
      qid=$(aws logs start-query --log-group-name "$LG" \
      --start-time $(date -u -d "$1" +%s) --end-time $(date -u -d "$2" +%s) \
      --query-string "$3" --limit 200 --query queryId --output text) || return 1
      until [ "$(aws logs get-query-results --query-id "$qid" --query status --output text)" != "Running" ]; do sleep 2; done
      aws logs get-query-results --query-id "$qid" --query 'results[*][*].value' --output text; }
```

Another log group for one call: `LG=<name> q '<from>' '<to>' '<query>'`.

### The access-log parse

Every access-log query below builds on this one regex. It yields minute, method, URL, status, response
size, **request duration in microseconds** and the `X-Forwarded-For` chain:

```
parse @message /^(?<tsmin>\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\S* \S+ \S+ "(?<m>\S+) (?<url>\S+) HTTP\/[\d.]+" (?<st>\d{3}) \d+ \d+ (?<dur>\d+) .*XFF="(?<ip>[^"]*)"/
```

`dur` is what separates a flood from an exhaustion: the 2026-09-08 outage ran at about 21 requests per
minute, so counting hits showed nothing and only the duration did.

### Exploit paths — was anything actually tried?

Cited by *WordPress access at GWA*. The site runs WordPress 6.9.7; `CVE-2026-63030` covers 6.9.0–6.9.4 and
7.0.0–7.0.1, `CVE-2026-60137` covers 6.8.0–6.8.5, both fixed from 6.9.5 — so the version is not
vulnerable, and the question is only whether someone tried. The attack path is a `POST` to
`/wp-json/batch/v1` or `?rest_route=/batch/v1`, often with `///` in the path.

```bash
q '2026-09-07 12:00:00' '2026-09-08 10:00:00' \
  'parse @message /^(?<tsmin>\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\S* \S+ \S+ "(?<m>\S+) (?<url>\S+) HTTP\/[\d.]+" (?<st>\d{3}) \d+ \d+ (?<dur>\d+) .*XFF="(?<ip>[^"]*)"/
   | filter url like /batch\/v1|rest_route|author__not_in|\/\/\/|wp\/v2\/users/
   | stats count() as hits by url, m, st, ip | sort hits desc | limit 40'

# The wave was GET-only; a POST to the REST API would have been the deviation
q '2026-09-07 20:00:00' '2026-09-08 10:00:00' \
  'parse @message /"(?<m>\S+) (?<url>\S+) HTTP\/[\d.]+" (?<st>\d{3})/
   | filter m = "POST" and url like /wp-json/
   | stats count() as hits by url, st | sort hits desc | limit 40'

# Complianz endpoints — CVE-2026-4019 hits consent-area up to 7.4.5, not the endpoint from this incident
q '2026-09-07 12:00:00' '2026-09-08 10:00:00' \
  'parse @message /"(?<m>\S+) (?<url>\S+) HTTP\/[\d.]+" (?<st>\d{3})/
   | filter url like /complianz/
   | stats count() as hits by url, st | sort hits desc | limit 25'
```

### The version leak that survives hardening

Cited by *the version leaks anyway*. `meta generator`, the feed generator tag and `readme.html` are all
closed, but every enqueued script carries the version in its query string — `?ver=6.9.7` on
`wp-lists.min.js`, `shortcode.min.js`, `postbox.min.js`. That is on every page, visible to anyone.

```bash
q '2026-09-07 00:00:00' '2026-09-08 12:00:00' \
  'parse @message /"(?<m>\S+) (?<url>\S+) HTTP\/[\d.]+" (?<st>\d{3})/
   | filter url like /ver=6\.9\./
   | stats count() as hits, count_distinct(url) as pfade by st | limit 10'
```

### WAF — what a rule group actually counted

Cited by the rule-group table. The obvious filter is wrong: `@message like /KnownBadInputs|SQLi/` matches
**every** line, because `ruleGroupList` names every group that was evaluated, not the ones that fired.
Filter on `nonTerminatingMatchingRules` or on `"action":"COUNT"` instead.

```bash
wafq '2026-09-08 03:00:00' '2026-09-08 08:00:00' \
  'filter ispresent(nonTerminatingMatchingRules.0.ruleId)
   | stats count() as treffer by nonTerminatingMatchingRules.0.ruleId, httpRequest.uri
   | sort treffer desc | limit 40'

# Fallback over the raw message, plus the curve to lay against the alarm times
wafq '2026-09-08 03:00:00' '2026-09-08 08:00:00' \
  'filter @message like /"action":"COUNT"/
   | stats count() as treffer by bin(5m) | sort @timestamp asc | limit 100'
```

**Do health checks traverse the WebACL?** This is the query that retracted the claim that promoting
`SQLiRuleSet` to `block` would break them. Empty for both forms across five hours means health checks
never reach the WebACL and need no `Allow` rule.

```bash
wafq '2026-09-08 03:00:00' '2026-09-08 08:00:00' \
  'filter httpRequest.clientIp like /^10\./ | stats count() by httpRequest.uri | limit 20'
wafq '2026-09-08 03:00:00' '2026-09-08 08:00:00' \
  'filter @message like /ELB-HealthChecker/ | stats count() by httpRequest.uri | limit 20'
```

Two standing caveats on every WAF number: the WebACL sits on the ALB and covers **all** services, so
results are estate-wide until filtered on host, and `action: ALLOW` is the WebACL's default action, **not**
the HTTP status — nothing in these logs says whether a request succeeded.

### Threshold calibration from measured distribution

Cited by the `vpc-rejected-surge` item. The top 20 five-minute buckets over the retention window are what
a threshold should be set against, rather than a round number.

```bash
aws cloudwatch get-metric-statistics \
  --namespace "${CLUSTER}/VpcFlowLogs" --metric-name RejectedConnections \
  --start-time "$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 --statistics Sum \
  --query "sort_by(Datapoints,&Sum)[-20:].[Timestamp,Sum]" --output text
```

### Rollout verification

Cited by *the ECR push date is the discriminator*. Snapshot **before** the first deploy — run it again
afterwards and it compares against itself.

```bash
# 1. before: one line per stack with the image it is running
for S in $(aws cloudformation describe-stacks \
            --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].StackName" --output text); do
  TD=$(aws ecs describe-services --cluster ${CLUSTER}-Ecscluster --services ${S}-Service \
        --query "services[0].taskDefinition" --output text)
  echo "$S $(aws ecs describe-task-definition --task-definition "$TD" \
        --query "taskDefinition.containerDefinitions[0].image" --output text)"
done | tee service-images.txt

# 2. after: image, template version and stack status per stack
grep -v '^#' service-images.txt | while read -r S IMG; do
  TD=$(aws ecs describe-services --cluster ${CLUSTER}-Ecscluster --services "${S}-Service" \
        --query "services[0].taskDefinition" --output text)
  NEW=$(aws ecs describe-task-definition --task-definition "$TD" \
        --query "taskDefinition.containerDefinitions[0].image" --output text)
  V=$(aws cloudformation describe-stacks --stack-name "$S" \
        --query "Stacks[0].Outputs[?OutputKey=='TemplateVersion'].OutputValue" --output text)
  [ "$NEW" = "$IMG" ] && echo "ok   $S  $V" || echo "DIFF $S  $V  is=$NEW want=$IMG"
done

# 3. a DIFF is not automatically a fault - a pipeline may have deployed in between.
#    The push date decides: newer tag = fine, older tag = regression, and an
#    ImageRegressionGuard mail should exist for it.
aws ecr describe-images --region eu-central-1 --repository-name <repo> \
  --image-ids imageTag=<tag> --query "imageDetails[0].imagePushedAt" --output text
```

**Which stacks will actually roll.** From `1.6.0` on, `ProjectToken` is a resolver property, so the
resolver runs on every stack — where its cached value trails the running image, CloudFormation registers a
new revision and the service redeploys. Wanted, since it clears accumulated drift, but not a silent
rollout. Measure it first:

```bash
for S in $(aws cloudformation describe-stacks \
            --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].StackName" --output text); do
  CTD=$(aws cloudformation describe-stack-resource --stack-name $S --logical-resource-id Task \
         --query 'StackResourceDetail.PhysicalResourceId' --output text)
  LTD=$(aws ecs describe-services --cluster ${CLUSTER}-Ecscluster --services ${S}-Service \
         --query 'services[0].taskDefinition' --output text)
  CI=$(aws ecs describe-task-definition --task-definition $CTD --query 'taskDefinition.containerDefinitions[0].image' --output text)
  LI=$(aws ecs describe-task-definition --task-definition $LTD --query 'taskDefinition.containerDefinitions[0].image' --output text)
  [ "$CI" = "$LI" ] && echo "quiet  $S" || echo "ROLLS  $S  cfn=$CI  live=$LI"
done
```

### Pre-flight for the Frankfurt rollout

**Do the running images still exist in ECR?** Nobody notices a tag reaped by the lifecycle policy while
the task keeps running — the next start fails with `CannotPullContainerError`, and a rolling restart out
of the rollout is exactly that trigger. Every `MISSING` is a stack the rollout must not touch.

```bash
cut -d'|' -f1,3 frankfurt-images.txt | while IFS='|' read -r S IMG; do
  case "$IMG" in
    *dkr.ecr.*) REPO=${IMG#*amazonaws.com/}; REPO=${REPO%%:*}; TAG=${IMG##*:}
      P=$(aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" \
            --query "imageDetails[0].imagePushedAt" --output text 2>/dev/null)
      [ -n "$P" ] && [ "$P" != "None" ] && echo "ok      $S  $P" || echo "MISSING $S  $REPO:$TAG" ;;
    *) echo "skip    $S  $IMG (not ECR)" ;;
  esac
done
```

**Which instances still carry the EFS root mount.** Needs IMDSv2 with a token — a plain `curl` to the
metadata endpoint returns empty and looks like a clean result.

```bash
IDS=$(aws ecs list-container-instances --cluster ${CLUSTER}-Ecscluster --query containerInstanceArns --output text \
      | xargs -r aws ecs describe-container-instances --cluster ${CLUSTER}-Ecscluster --container-instances \
        --query "containerInstances[].ec2InstanceId" --output text)
echo "$IDS"   # empty = wrong region or cluster name, stop here
CMD=$(aws ssm send-command --instance-ids $IDS --document-name AWS-RunShellScript \
  --parameters 'commands=["echo -n \"fstab:\"; grep -c efs /etc/fstab || true","echo -n \"mounted:\"; mount | grep -c \" /mnt/efs \" || true","T=$(curl -sX PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 60\"); echo -n \"ami:\"; curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/ami-id"]' \
  --query "Command.CommandId" --output text)
for I in $IDS; do echo "== $I"
  aws ssm get-command-invocation --command-id $CMD --instance-id $I --query StandardOutputContent --output text; done
```

**Does the cluster export everything `ecsservice` `1.6.0` imports?** Six are used by older versions;
`AlertTopicArn` is the one the `ImageRegressionGuard` needs. A missing export fails the update on *every*
service stack.

```bash
for E in Ecscluster Vpc Efs LoadbalancerArn ListenerArnHttp ListenerArnHttps AlertTopicArn; do
  echo "$(aws cloudformation list-exports --query "length(Exports[?Name=='${CLUSTER}-${E}'])" --output text)  ${CLUSTER}-${E}"
done
```

`AlertTopicArn` at `0` means either raising the cluster stack first, or rolling the services with the
guard disabled — the import sits exclusively inside resources under that condition and is not evaluated
otherwise.
