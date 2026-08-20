# Open tasks

Background, rationale and operational procedures live in [README.md](README.md) (per-template Best Practices) and [CHANGELOG.md](CHANGELOG.md). This file is the to-do list only.

## Where to pick up (session close 2026-08-20)

1. **Verify WAF log delivery in Paris** — the one part of the WAF deploy that fails silently: `aws logs describe-log-streams --region eu-west-3 --log-group-name aws-waf-logs-labc-eu-w3-waf`. Streams present = `WafLogDeliveryPolicy` is correct; empty after real traffic = WAF is being denied write access.
2. **`EnableEgressAnalysis=false` in Paris** — the only item with money attached, well past its intended 14-day window. Frankfurt's analysis is due before 2026-08-28.
3. **Deploy cluster `1.3.0` to Frankfurt, then to Paris.** `1.3.0` (2026-08-20) adds the internal ALB (`SgInternalAlb`, `InternalLoadbalancer`, `InternalHttplistener` + the `-InternalListenerArnHttp` / `-InternalAlbDns` exports) on top of the WAF, so the change set is **not** the same shape as Paris's `1.2.0` deploy — expect the 5 WAF `Add` rows plus 3 internal-ALB rows, 2 new outputs and the four-row AMI cascade. **Paris is on `1.2.0` and now needs a `1.3.0` pass as well**, which it did not before. Frankfurt is still where the WAF count data becomes meaningful, since Paris is staging.
4. **Then the `ecsservice` `1.3.0` rollout** — 14 Paris, 20 Frankfurt.

Everything WAF-related is inert by design: all rules default to `count`, nothing is blocked, and `RateLimitAction=block` is now refused by the `Rules` section unless `WafClientIpHeader` is set.

---

## Cluster deployment timeline

Open/in-flight changes per cluster. Rows completed in both regions get removed.

| Change | Paris (labc-eu-w3) | Frankfurt (labc-eu-c1) |
|---|---|---|
| `EnableEgressAnalysis` | ⏳ **switch off** — ran 29 days vs. intended 14, analysis complete | ⏳ enabled 2026-08-14 — run the analysis, then **switch off by 2026-08-28** |
| LII26-96 Phase 2 — whitelist analysis + deploy | ⚠️ overdue — unblocked since 2026-07-16 | ⏳ unblocked since 2026-07-17 |
| `ecsservice` rollout to `1.3.0` | ⏳ 1 of 15 done — `ado-ede-new-s` (staging cluster) | ⏳ 1 of 21 done — `gwa-gut-web-p`; `ado-lea-tut-p` on `1.0.1`, 19 on `None` |
| Cluster template `1.2.0` (WAF, all rules `count`) | ✅ deployed 2026-08-20 — WebACL `labc-eu-w3-waf` attached, 1202 WCU | ⏳ not deployed |
| Service RAM resizes | ✅ 2026-07-09 | ⏳ `gwa-gut-sol-p` (77%). `labs-tin-fro-app-p` (106%) is on `labcluster-eu-c1-cl`, tracked separately |
| GuardDuty projected monthly cost from Usage page | 🗓 open | 🗓 open |
| DNS ALERT data-flow sanity check (`DnsFireWallLogsSummary`, last 24h) | ⏳ optional | ⏳ optional |

---

## Templates

- [ ] **`ecsservice` — finish the rollout, now targeting `1.3.0`.** `1.2.0` adds the ALB-native HTTP alarms (`AlarmHttp5xxTarget`, plus `AlarmHttp4xxTarget` + `BaselineHttp4xxTarget` which ship disabled; `AlarmHttp5xxElb` shipped in `1.2.0` and was deliberately removed again — load-balancer-side 5xx is not a case we need alarmed for now; stacks already on `1.2.0` lose it on their next update), so each remaining stack is updated once for both feature sets. **`1.3.0` (2026-08-19) then removed `AlarmHttp5xxElb` and log anomaly detection and renamed the 4xx pair** — the two stacks already on `1.2.0` need a further pass, and the cluster stack moved to `1.2.0` at the same time (EFS root mount dropped from the launch template; needs an instance refresh to take effect on running instances). `ado-ede-new-s` piloted `1.1.0` and has already made its second pass to `1.2.0`. **Inventory rebuilt from live state 2026-08-19** (`describe-stacks`, both regions), replacing a hand-maintained tally that had drifted twice.

| Region | Services | State |
|---|---|---|
| Paris `labc-eu-w3` — **all `-s`, staging** | 15 | ✅ **all 15 on `1.3.0` (2026-08-20)**, cluster `1.3.0`, plus `labc-eu-w3-guardduty` and `labc-eu-w3-alb-logs` stamped `1.0.0`. Every stack `UPDATE_COMPLETE`, no rollbacks. |
| Frankfurt `labc-eu-c1` — **all `-p`, production** | 21 | Remaining work. `gwa-gut-web-p` on `1.2.0`; `ado-lea-tut-p` on `1.0.1`; 19 on `None` (pre-versioning). Cluster still on `1.2.0`. |

**Paris sweep, as executed 2026-08-20 — the reference for Frankfurt.** Every `skip=false` service produced the same four-row change set: `Add AlarmHttp5xxTarget`, `Modify ServiceHighCpuAlarm` + `ServiceHighMemoryAlarm` (gaining `AlarmActions`), and a **cosmetic** `Modify LoadbalancerRuleHttp` — cosmetic because only its `Condition` and `Metadata` changed, `Properties` are byte-identical to `1.0.0`. Crucially **no `Task` row**, so no new task definition revision and no container restart. Treat that shape as the expectation in Frankfurt and stop on anything that deviates, especially a `Task` or `Service` row: that means the ImageResolver returned something other than the running image, which is the `CannotPullContainerError` path.

**Pre-flight Frankfurt the same way** before starting — one call identifies the stacks that carry risk:

```
aws cloudformation describe-stacks --region eu-central-1 \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName,
           skip:(Parameters[?ParameterKey=='SkipImageResolver'].ParameterValue)[0],
           image:(Parameters[?ParameterKey=='InitialDockerImage'].ParameterValue)[0]}" --output table
```

In Paris only `ado-ael-adm-s` was `skip=true`; the other 14 were `skip=false` and therefore safe, since the resolver reads the live image and ignores `InitialDockerImage`. Frankfurt has 19 stacks on `None`, i.e. deployed before the version stamp existed, so expect a higher proportion of `skip=true` and check each one's tag still exists in ECR (`eu-central-1`) before deploying it.

Note `Metadata`-only and `Description`-only edits also surface as `Modify` rows with no functional effect — this repo uses `Metadata.Note` heavily. The test for whether a `Modify` is real: diff that resource's `Properties` against the last-deployed commit. Identical `Properties` means documentation.

Paris is a staging mirror of Frankfurt (`gwa-gut-web-s` ↔ `gwa-gut-web-p`, `lab-web-fro-s` ↔ `lab-web-fro-p`, …), which makes it the right place to rehearse a template version and the wrong place to gather traffic-shaped evidence such as the 4xx band. `1.2.0` folds the alarm notifications and the HTTP alarms into one pass, so each stack is updated once rather than three times. Suggested order (Frankfurt): `ado-lea-tut-p` → `lab-web-fro-p` (first with ≥2 tasks) → the 1/1 and 1/2 services → `dwk-zer-app-p` (baseline 0, a working scale-in ends at zero tasks) → the five at baseline 3 last. Pass `SkipImageResolver=false` explicitly. Before each update compare live `MinCapacity` against the stack parameter (`aws application-autoscaling describe-scalable-targets --service-namespace ecs`) — verified clean for all 21 on 2026-08-14.

- [x] **`ecsservice` — notification path complete (2026-08-18).** Cluster `1.1.0` is deployed in **both** regions: `AlertTopic` (`${AWS::StackName}-alerts`), optional `AlertEmail`, topic policy for `cloudwatch.amazonaws.com` + `events.amazonaws.com`, export `${AWS::StackName}-AlertTopicArn`, and `AlarmActions` on all four cluster alarms. Delivery verified end-to-end in both regions with `set-alarm-state` (which exercises the topic policy; `sns publish` does not). Service `1.2.0` routes eight alarms to that topic. What is left is the rollout itself, above — the notes below are the operational detail worth keeping.
  - **Deploy the cluster stack before any service stack references the export**, or the service update fails at import resolution.
  - ✅ Service `1.1.0` (2026-08-18): `AlarmActions` on `ServiceHighCpuAlarm`, `ServiceHighMemoryAlarm`, `ServiceLowCpuAlarm`, `ServiceLowMemoryAlarm`, importing `${ClusterStackName}-AlertTopicArn`. **The cluster stack must be deployed first** — the High alarms are on by default, so their `Fn::ImportValue` fails the service update if the export is missing.
  - [ ] **Decide the 4xx band on `gwa-gut-web-p` — enabled 2026-08-19 at band width `3`, evaluation pending.** `BaselineHttp4xxTarget` and `AlarmHttp4xxTarget` (renamed from `Http4xxAnomalyDetector` / `AlarmHttp4xxAnomaly`; the rename replaces both resources, and the detector rebuilds its model from retained metric history) are now CloudFormation-managed on that stack; the alarm is live on the Frankfurt topic while the band is being judged (option B: exposure accepted, one parameter flip to reverse). No waiting period needed — `HTTPCode_Target_4XX_Count` is published by the ALB continuously and retained 15 months, and a new anomaly detector trains on that existing history, so the band is as good today as it would be in a fortnight. Create the detector, graph it at `Sum`/5 min against two weeks of traffic, count how often the actual line exceeds the upper band for two consecutive periods (that is what would alarm), then set the band width and flip the parameter. `ado-ede-new-s` is staging and unsuitable for this — it has no meaningful 4xx traffic.
  - ~~`ServiceLogAnomalyAlarm` (service `1.1.0`)~~ **removed after `1.2.0`** — log anomaly detection is unusable against our log format (Apache access lines collapse to a single pattern; AWS lists access/audit logs as unsuited). `LogAnomalyDetector`, the alarm, the `EnableLogAnomalyDetection` parameter and the `EnableAnomalyDetector` condition are all gone; deployed stacks lose the detector on their next update. Do not re-add without changing the log format first.
  - Do **not** wire SNS to `AlarmAutoscaleScaleDown` — it is red during every normal scale-in by design.
  - `email` subscriptions need a manual confirmation click; CloudFormation reports `CREATE_COMPLETE` while still `PendingConfirmation`. Verify with `aws sns list-subscriptions-by-topic`. **SNS e-mail delivery verified working 2026-08-18** with a throwaway topic — the "we cannot send e-mails" concern applies to SES (no setup, sandbox) and to application mail via the Hetzner relay, not to SNS.
  - `RdsErrorAlarm` has threshold `0` and fires on **any** `[ERROR]` line. With e-mail attached it is the most likely noise source — watch it for the first few days and parameterise the threshold if it chatters.
  - Slack later at the same topic via AWS Chatbot (`AWS::Chatbot::SlackChannelConfiguration`, needs a one-time Slack-app authorization by a workspace admin for the `SlackWorkspaceId`) or a Lambda subscriber reading the webhook URL from an SSM `SecureString`. A plain `https` subscription to a Slack webhook does **not** work: the SNS envelope fails Slack's payload validation, and the subscription never confirms because nobody visits `SubscribeURL`. Adding it costs one cluster stack update and touches no alarm.
  - Point the GuardDuty findings rule below at this same topic. Do this **before** continuing the rollout, or 21 stacks get updated twice.
  - **Verify the full path after the first cluster deploy, not just the subscription.** `aws sns publish` only proves the subscription; it does not exercise the topic policy. Force one alarm through instead: `aws cloudwatch set-alarm-state --alarm-name <cluster>-rds-error --state-value ALARM --state-reason "policy test"`, confirm the mail arrives, then let it settle back to `OK`. Same for the GuardDuty rule via `create-sample-findings`.

- [ ] **Slack delivery for the alert topics — `chatbot-slack` written 2026-08-19, blocked on one manual step.** Template is `chatbot-slack/index.template` (AWS Chatbot channel configuration, IAM role, `ReadOnlyAccess` guardrail). One account-wide stack covers both clusters.
  - [ ] **Prerequisite CloudFormation cannot do: a Slack workspace admin must authorize the AWS app once.** AWS console -> *Amazon Q Developer in chat applications* -> Configure new client -> Slack -> approve the OAuth consent in Slack. That produces the `SlackWorkspaceId` (`T…`). Without it the stack cannot be deployed at all. **Open question: does Philipp have Slack admin rights, or does someone else have to approve it?**
  - [ ] **Check first whether the app is already authorized** — `aws chatbot describe-slack-workspaces --region us-east-2` and `describe-slack-channel-configurations`. An empty list means the manual step above is still outstanding; a listed workspace gives the `SlackTeamId` directly.
  - [ ] **Deployment region for this stack needs confirming: the Chatbot API appears to have no endpoint in `eu-central-1` or `us-east-1`**, resolving only in `us-east-2`, `us-west-2` and `eu-west-1`. If so, deploy `chatbot-slack` in `eu-west-1` (closest to the rest of the estate) and note it in the README — the stack references topic ARNs in both cluster regions anyway, so its own region is otherwise irrelevant. Verify before deploying.
  - [ ] **In-region alternative if the extra US-side processor is unwanted:** EventBridge rule → API Destination → Slack webhook. CloudWatch alarm state changes reach EventBridge natively, so a rule in the cluster's own region with an input transformer can shape Slack's expected JSON, with retries and no code. Note this only moves the *relay* — Slack itself is US-hosted unless the workspace has EU data residency, and these payloads carry stack names, metric names and thresholds, no personal data.
  - [ ] Get the channel ID from Slack (channel -> View channel details -> ID at the bottom, `C…`, or `G…` for a private channel). For a private channel the AWS app must be invited to it, otherwise delivery fails silently.
  - [ ] Deploy with both topic ARNs (full ARNs, not `Fn::ImportValue` — exports do not cross regions):
    ```
    aws cloudformation deploy --stack-name labor-slack-alerts \
      --template-file chatbot-slack/index.template --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides SlackWorkspaceId=T… SlackChannelId=C… \
        AlertTopicArns=arn:aws:sns:eu-west-3:848331400135:labc-eu-w3-alerts,arn:aws:sns:eu-central-1:848331400135:labc-eu-c1-alerts
    ```
    `CAPABILITY_NAMED_IAM` is required — the role has an explicit `RoleName`.
  - **Choosing between the two delivery routes (assessed 2026-08-19):**

| | Chatbot (`chatbot-slack`, written) | SNS → Lambda → webhook |
|---|---|---|
| Slack permissions | **Admin required** — workspace-wide OAuth | Own app scoped to one channel; self-install only if the workspace does not enforce app approval |
| Stacks | One, global, covers both clusters | **Two** — SNS topics are regional, so one Lambda per region |
| Code to maintain | None | ~15 lines of Python (`urllib` + `boto3` for SSM) |
| Formatting | Native alarm and GuardDuty rendering | Whatever you write |
| Data path | Global service, no EU API endpoint | Stays in-region |

  - If the webhook route is taken: URL in SSM Parameter Store as a `SecureString` (template holds only the parameter name, so it rotates without a deploy and never lands in stack events); IAM limited to `ssm:GetParameter` on that one parameter plus `kms:Decrypt`; **Lambda outside the VPC** so it reaches `hooks.slack.com` directly instead of depending on the NAT gateway and falling under the Phase 3 egress rules; and a DLQ or on-failure destination, because SNS retries a Lambda twice and then drops the message silently. Slack rate-limits incoming webhooks at roughly one message per second — fine for alarms.
  - **Per-channel, not per-alarm.** A webhook URL is permanently bound to one channel (the `channel` field in payloads is ignored for modern app webhooks), and a Chatbot channel configuration likewise covers one channel. So routing, say, GWA alarms to a client-specific channel means another webhook plus another relay, or another Chatbot configuration — plus an EventBridge rule or second topic to split the stream. Worth knowing before promising per-client channels.
  - **Runbook if the webhook route is chosen:** api.slack.com/apps → *Create New App* → *From scratch* (the app name becomes the sender name in the channel) → *Features → Incoming Webhooks* → toggle On → *Add New Webhook to Workspace* → pick the channel. **Step 5 is where workspace policy reveals itself:** the button reads either *Allow* (self-service, done) or *Request to install* (an admin must approve). For a private channel you must already be a member for it to appear. The URL then shows under *Webhook URLs for Your Workspace*.
    - Verify before wiring anything in AWS: `curl -X POST -H 'Content-Type: application/json' -d '{"text":"webhook test"}' '<url>'` — expect `ok` and a visible message.
    - Store it as an SSM `SecureString` (`/labor/slack/alerts-webhook`), one per region since the Lambda reads locally. **Pass it via `--value file://…` and delete the file**, or the URL ends up in shell history.
  - Slack's failure responses are plain text, not JSON (`invalid_payload`, `channel_not_found`, `no_service`) — relevant to error handling if the Lambda route is chosen.
  - E-mail keeps working alongside Slack; subscriptions coexist. No alarm and no service stack is touched by this, which was the point of routing everything through one topic per cluster.

- [ ] **`guardduty` — findings e-mail notification.** EventBridge rule on findings with severity ≥ 4 (MEDIUM+) → the shared `AlertTopic`. Superseded later by Phase 3 Step D but stays useful for MEDIUM. Also: give the account owner an IAM identity, or `Policy:IAMUser/RootCredentialUsage` recurs on every root console visit.

- [ ] **`ecsservice` — harden ImageResolver against the failed-first-create retry loop.** On an Update event after a failed create: (a) if the ECS service is gone, `describe_services` finds nothing and the Lambda hard-fails the stack update; (b) if the service exists but never became healthy, the broken image is read from the running task definition and resurrected on every update. Fix (a) with a ~4-line fallback to `InitialDockerImage` in the Update branch. (b) is not safely auto-detectable — `SkipImageResolver=true` stays the documented override. Mitigated 2026-07-10 by defaulting `SkipImageResolver` to `true`; still worthwhile for stacks already switched to `false`.

- [ ] **`cloudfront-alb-distribution` — the WAF scope problem is undocumented here.** README says "ungelöst — siehe TASKS.md" but no such entry existed until now. `EnableWAF` defaults to `true`, and a WebACL with scope `CLOUDFRONT` can only be created in `us-east-1`, so deploying the stack in any other region fails immediately with `WAFInvalidOperationException`. Three ways out, in order of preference:
  - Deploy the distribution stack itself in `us-east-1` (CloudFront is global; only the WebACL and the ACM certificate are region-bound). Costs nothing but a deployment convention.
  - Split the WebACL into its own `us-east-1` stack and pass its ARN into the distribution as a parameter. More moving parts, but lets the distribution stay in the cluster's region.
  - Attach a `REGIONAL` WebACL to the **ALB** instead of to CloudFront. Different protection point — it does not shield the ALB from direct access unless the origin-verify header is also enforced — but it works in `eu-west-3`/`eu-central-1` without any `us-east-1` deployment.
  - **First check whether this is even live:** `aws cloudformation describe-stacks --query "Stacks[?contains(StackName,'cloudfront')].StackName"` per region. If no distribution stack exists anywhere, this is a latent trap for the next person rather than a current outage, and the cheapest fix is a `Description` note plus the README correction.

- [ ] **Harden the Solr services — they are on the public ALB by construction.** `gwa-gut-sol-p` (Frankfurt) and `gwa-gut-sol-s` (Paris) run `solr:9.9` as ordinary `ecsservice` stacks, so each has a target group and HTTP/HTTPS listener rules. A WAF does **not** address this: the proposed rule groups (WordPress, PHP, SQLi) target PHP applications, and Solr is Java. This is a network-level fix.
  - Solr is a search backend — only the application should reach it. Its admin UI ships unauthenticated, and it has a history of critical RCEs (Log4Shell landed on Solr directly, plus Velocity template injection and config-API paths).
  - **First confirm the exposure:** `curl -H "Host: <listener-rule-host>" https://<alb-dns>/solr/` against each region. A listener rule means reachable by anyone sending that Host header; the hostname not being in public DNS is obscurity, not access control.
  - **The template cannot express a private service.** In `ecsservice`, `Target`, `LoadbalancerRuleHttp` and `LoadbalancerRule` are all unconditional and `ListenerRuleHost` is required (`MinLength: 1`), so every service lands on the public ALB. Fixing Solr properly therefore needs a template change, not just a parameter:
    - Add a condition that skips the listener rules and target group for internal services (`ExposeViaLoadBalancer`, default `true`), letting the consumer reach Solr by another route. Note the scale-in alarm reads ALB `HealthyHostCount`, so a service without a target group needs a different task-count source or the alarm disabled.
    - Or, as a smaller step, add an optional source-IP condition on the listener rules so Solr answers only the office range.
  - Whichever route, apply it to both regions and record which services are meant to be internal — nothing today distinguishes "public site" from "backend" in the template or its parameters.

- [ ] **Preventive: put a `REGIONAL` WebACL in front of the cluster ALBs.** No ALB in either European region has any WAF today. Motivating class of attack (a recent WordPress core RCE, for rule selection only — this item is about prevention, not that event): unauthenticated, stock-core, `POST /?rest_route=/batch/v1` route confusion (CVE-2026-63030) chained into SQL injection in `author__not_in` (CVE-2026-60137, CVSS 9.1), then a forged admin account via `POST /wp/v2/users` and a plugin webshell. Reference: https://github.com/dinosn/wp2shell-lab
  - [x] **Written into the cluster template as `1.2.0` (2026-08-19), cfn-lint clean. Deployed to Paris; Frankfurt pending — and now folded into the `1.3.0` deploy alongside the internal ALB.** `WafWebAcl` (`${AWS::StackName}-waf`, scope `REGIONAL`) associates directly with `Loadbalancer`, so no import is needed. Scope `REGIONAL` works in `eu-west-3`/`eu-central-1` with no `us-east-1` deployment and no CloudFront; one WebACL covers every service behind that ALB (21 Frankfurt, 15 Paris). Merged into the cluster template by decision rather than kept as a separate `alb-waf` stack. **Promotion is a parameter change** — flip an `*Action` parameter from `count` to `block` on a normal cluster stack update; no template edit. Two mild consequences: each update re-resolves the SSM AMI reference and so shows the four-row cascade (documented as harmless in README — nothing is recreated, running instances untouched), and at 104 KB the template must go via S3 or the console because of the 51,200-byte inline limit.
    - **As built (after the 2026-08-20 trim):** `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, `AWSManagedRulesSQLiRuleSet`, `AWSManagedRulesWordPressRuleSet`, plus two general rate rules — 1202 WCU of 1500. The SQLi and WordPress groups are the ones addressing injection chains of the kind above; none of them exist in the `cloudfront-alb-distribution` WebACL. The PHP and IP-reputation groups and all custom rules were considered and removed — reasons and re-evaluation criteria further down.
    - **Deploy with `OverrideAction: Count` first.** Block-mode managed rules in front of production TYPO3, Matomo and Solr will produce false positives, and a WAF that breaks a client site gets switched off wholesale. Count for a week, read the per-rule metrics, then flip the clean groups to block — the same evidence-before-enforcement discipline as the DNS Firewall ALERT→BLOCK phases.
    - Enable **WAF logging** and alarm on a blocked-request surge via the cluster `AlertTopic`, so the WebACL is observable rather than a black box.
    - Costs a WebACL fee plus a per-rule-group fee per region, plus per-million-requests; verify current rates. AWS Managed Rules carry no extra charge except Bot Control / ATP / Fraud Control, which are not proposed here.
  - [ ] **Deploy Frankfurt first, in count mode.** Under 51 KB, so no S3 upload:
    ```
Upload `ecscluster-vpc-rds-asg/index.template` to S3 and create a change set on `labc-eu-c1` (104 KB exceeds the inline limit), or use the console which uploads for you. Every rule defaults to `count`, so no parameter overrides are needed and nothing is blocked. Expect the WAF `Add` rows plus the usual four-row AMI cascade.
    Then Paris as `labc-eu-w3-waf` with `ClusterStackName=labc-eu-w3`. Production is the one that matters here, but Paris is the cheaper place to discover a false positive.
  - [ ] **Cloudflare fronts some but not all sites — three consequences, template handles it but needs configuring (2026-08-19).**
    - [ ] **Set `WafClientIpHeader=cf-connecting-ip`** (lowercase is enforced by an `AllowedPattern`; the scope-down header match is case-sensitive). With it set, two rate rules exist: `RateLimitForwardedIp` (priority 90) keys on the header for requests that carry it, and `RateLimitSourceIp` (priority 91) keys on the source IP for those that do not, each scope-down-ed so they never double-count. Left empty, proxied requests all aggregate onto Cloudflare's own addresses and promoting `RateLimitAction` to `block` would take Cloudflare out for every site behind it.
    - [ ] **Restrict the ALB security group to Cloudflare's published ranges before trusting the header.** A client-IP header is only as trustworthy as the network path: if the ALB is reachable directly, anyone can set `cf-connecting-ip` themselves and evade both the rate limit and any IP allowlist. Same argument as the CloudFront origin-verify gap. This is a `SgPublicHttpHttps` change in the cluster template, and it also closes the Cloudflare-bypass route for the proxied sites.
    - [ ] **Establish which sites are proxied and which are direct**, and record it — nothing in the repo distinguishes them today, and the answer changes what each rule actually inspects.
    - Note the admin IP set cannot serve both modes at once: `IPSetForwardedIPConfig` with `FallbackBehavior: NO_MATCH` means a direct request carries no header, fails the allowlist and is blocked. Splitting it the way the rate rules are split would be required first. Moot while `AdminRestrictionAction` is `off`.
  - **AWS enables `OnSourceDDoSProtectionConfig` on the WebACL by default** (`ALBLowReputationMode: ACTIVE_UNDER_DDOS`, observed on the Paris deployment 2026-08-20). Not configured by this template. It blocks low-reputation sources automatically *while a DDoS is detected*, which partially offsets dropping `AWSManagedRulesAmazonIpReputationList` — but only under attack conditions, not for routine traffic. Do not treat it as replacing reputation filtering.

  - [ ] **Decide the division of labour with Cloudflare — it overlaps AWS WAF for proxied sites.** Cloudflare brings threat-score reputation (Security Level), always-on L3/4 and L7 DDoS protection, Bot Fight Mode, rate limiting and managed WAF rulesets, so for proxied sites much of the WebACL is a second copy of protection already paid for. **But it is all conditional on traffic actually passing through Cloudflare**, and with `SgPublicHttpHttps` open to `0.0.0.0/0` an attacker who resolves the ALB hostname (exposed via certificate transparency) skips every bit of it. So the security-group restriction above is worth more than any rule promotion: it makes Cloudflare's existing protection unavoidable, makes `cf-connecting-ip` trustworthy, and closes the bypass — one change, three results.
    - [ ] Establish per zone what Cloudflare actually has enabled; features and managed rulesets differ by plan (Free/Pro/Business) and are configured per zone, so "we use Cloudflare" says little about a given client site. Check especially whether a managed WAF ruleset is active or only DDoS and Security Level.
    - Whatever the split, note that Cloudflare blocks are invisible from AWS: no shared logs, and nothing reaches the `AlertTopic`. A Cloudflare block and an AWS WAF block are two separate investigations in two consoles.
    - Defensible outcome: Cloudflare as the edge for proxied sites, AWS WAF as the primary control for direct-facing ones, and AWS WAF retained everywhere as defence in depth for anything that reaches the ALB at all. Do not conclude the WebACL is redundant for proxied sites until the bypass is actually closed.
  - [ ] **Supply `AdminAllowedCidrs`** (office ranges, comma-separated). While it is empty the `RestrictAdminPaths` rule is not created at all — and it is the strongest control in the template, since an admin surface reachable only from the office cannot be brute-forced from the internet.
  - [ ] **After roughly a week, read the per-rule counts and promote.**
    ```
    aws cloudwatch get-metric-statistics --region eu-central-1 \
      --namespace AWS/WAFV2 --metric-name CountedRequests \
      --dimensions Name=WebACL,Value=labc-eu-c1-waf Name=Region,Value=eu-central-1 \
                   Name=Rule,Value=AWSManagedRulesCommonRuleSet \
      --start-time <start> --end-time <end> --period 86400 --statistics Sum
    ```
    Repeat per rule name. Criterion: a group counting near zero is safe to enforce; a group counting steadily against normal traffic is a false-positive source that needs a scope-down statement or rule exclusions **before** it can ever be enforced. That is the entire point of the count phase.
  - [x] **Per-rule promotion is expressible (fixed 2026-08-19).** The global `RuleAction` was replaced by eight `off`/`count`/`block` parameters — `IpReputationAction`, `CommonRuleSetAction`, `KnownBadInputsAction`, `SqliRuleSetAction`, `WordPressRulesAction`, `WpCustomRulesAction`, `AdminRestrictionAction`, `RateLimitAction` — all defaulting to `count`. `off` omits the rule entirely. Promotion order, corrected 2026-08-19 after a closer look at what each rule actually catches:
    - **Rule set trimmed from eleven rules to six on 2026-08-20**, keeping only what is generic — removals and their re-evaluation criteria are the item below. Note the login-endpoint gap listed there predates the trim; nothing removed was protecting logins. Promotion order for what remains: `KnownBadInputsAction` first (narrow, exploit-payload specific, and the virtual-patching layer between a CVE landing and a patched image), then `SqliRuleSetAction` (can trip on content or search queries containing SQL-like strings), then `WordPressRulesAction` (check it does not catch Matomo tracking POSTs), then the two rate rules, and `CommonRuleSetAction` last.
    - **`CommonRuleSetAction` last, and expect exclusions rather than merely a delay.** Watch these named rules in the count data — each has a specific, predictable cause:
      - `SizeRestrictions_BODY` — bodies over 8 KB, i.e. **every file upload** in the TYPO3 or WordPress backend. Fix with a `RuleActionOverride`, or raise the body inspection limit via `AssociationConfig` (which costs more).
      - `GenericRFI_BODY` — matches `://` in body parameters; editors pasting URLs into content trip it.
      - `CrossSiteScripting_BODY` — rich-text editors submit HTML by design.
      - `NoUserAgent_HEADER` — API clients and cron callers that send no user agent.
      Adding the groups in `count` carries no traffic risk at all; the risk is entirely in promotion, and it is concentrated here.

  - [ ] **Removed from the WebACL on 2026-08-20 — re-evaluate rather than forget.** Eleven rules down to six, on the principle that a rule must be generic to be worth carrying:
    - **`BlockWpBatchRoute`** (`rest_route=/batch/v1`, `/wp-json/batch/v1`) — written from one WordPress exploit chain, i.e. fighting the last war, and `batch/v1` is a **core REST route the block editor uses when saving**, so it risks breaking editors indefinitely for a CVE that patching already fixes. AWS adds signatures for widely exploited CVEs to KnownBadInputs and the WordPress group — that is the subscription being paid for.
    - **`BlockWpUserCreation`** (`POST /wp/v2/users`) — more generic in intent, since it stops any chain ending in a forged administrator, but **WAF cannot distinguish an authenticated admin creating a user from an attacker forging one** (it cannot evaluate WordPress auth cookies or nonces), so it may block legitimate user management. Revisit only with count data, and test user administration before enforcing.
    - **`AWSManagedRulesPHPRuleSet`** — substantially overlaps the Common Rule Set and the WordPress group; lowest marginal value per WCU of the six managed groups.
    - **`AWSManagedRulesAmazonIpReputationList`** — always evaluates the **source** IP and cannot be pointed at a forwarded header, so for proxied sites it inspects Cloudflare's addresses and protects nothing, and Cloudflare does reputation itself. Reconsider only for the directly reached sites, once which-is-which is established.
    - **`RestrictAdminPaths`** with its IP set, `AdminRestrictionAction` and `WafAdminAllowedCidrs` — clients edit their own content, so a CIDR allowlist locks out editors, and it cannot serve a mixed proxied/direct estate anyway (a direct request carries no header, fails the allowlist, is blocked).
    - [ ] **Login endpoints are unprotected — a gap that PREDATES the trim, not one it created.** Nothing counts or limits password guessing today: the signature groups inspect request *content* and a login POST with a wrong password is a perfectly well-formed request (correctly no match); the general rate limit needs 2,000 requests per IP per 5 minutes, so a botnet at 300 attempts/minute stays under it; `AdminRestrictionAction` was already `off` before the trim; and `BlockWpUserCreation` blocked account *creation*, never login attempts. Cloudflare covers some of it for proxied sites, but plan-dependent, per-zone and bypassable while the ALB takes direct traffic. Three options below, **none of them built** — the WebACL currently contains only the four managed groups and the two general rate rules (2,000 per IP per 5 minutes, all paths). Listed in ascending order of how well they fit the problem:
      - [ ] **1. Scoped rate limit — DEFERRED 2026-08-20 by decision, deliberately NOT in the template.** Needs more consideration first, chiefly the path list below. Cheap and partial when built: Two rate rules keyed on a narrow path set with a much lower limit than the general one, plus the forwarded/source split the mixed estate requires. Catches the noisy majority of real attacks. **Does not** catch slow-and-low (WAF's minimum limit is 100 per window and the longest window is 10 minutes, so ~10 attempts/minute never reaches it) and **does not** catch credential stuffing at all, where each pair is tried once across thousands of IPs so per-IP counting sees nothing. Do not record it as closing this gap.
        - Mechanically: `ScopeDownStatement` = `OrStatement` of `ByteMatchStatement`s against `FieldToMatch: {UriPath: {}}`, `PositionalConstraint: CONTAINS` (not `EXACTLY` — subdirectory installs like `/blog/wp-login.php` exist), with `TextTransformations` **`URL_DECODE` → `NORMALIZE_PATH` → `LOWERCASE`**. `NORMALIZE_PATH` is the one that is easy to omit and the cheapest bypass: without it `//wp-login.php` and `/foo/../wp-login.php` walk straight past the rule.
        - Note `UriPath` excludes the host, so one rule covers every site behind the ALB. Scoping to a single client site would need an extra host-header condition.
        - [ ] **Establish the actual paths per application — three traps:**
          - **`/xmlrpc.php` matters more than `/wp-login.php`.** XML-RPC `system.multicall` allows *hundreds of password attempts in one HTTP request*, so counting requests is no defence at all. This path wants blocking outright (most sites do not use XML-RPC) or an extremely low limit. Check whether anything legitimately needs it first.
          - **TYPO3 is version-dependent:** v11+ serves the backend login at `/typo3/login`, older installs at `/typo3/index.php`. `CONTAINS /typo3/` covers both but then also counts ordinary backend use by editors, so the threshold must allow for real editing sessions.
          - **Matomo's login is `/index.php?module=Login` — in the query string, not the path.** A `UriPath` rule cannot see it; that one needs a `QueryString` match. Exactly the case where a rule looks deployed and protects nothing.

      - [ ] **2. `AWSManagedRulesATPRuleSet` (Account Takeover Prevention) — the purpose-built tool.** Inspects login attempts, tracks failed-login rates and detects credential stuffing, which is exactly what per-IP rate limiting cannot do. Carries an extra per-request charge (the reason paid groups were excluded from the original design) and needs the login path plus the username/password field names configured per application. Evaluate cost against the request volume before dismissing it — this is the one paid group whose purpose matches a real gap here.
      - [ ] **3. Failed-login alarming and application lockout — cheapest, and arguably the best fit.** A metric filter on failed-login lines in each service's log group, with an alarm on the cluster `AlertTopic`. It counts **failures** rather than requests, which is the signal that actually matters and the one thing no rate limit measures: 10,000 successful requests are fine, 200 failed logins are not. Pairs with application-level lockout — TYPO3 tracks failed logins natively, WordPress needs a plugin. Costs one custom metric per service (~$0.30/month) and no per-request fee. Note the 14-day log retention bounds any investigation.

    - [x] **WebACL capacity measured on the live Paris stack 2026-08-20: `1202` WCU of the 1,500 default ceiling, so 298 headroom.** Confirms the trim was worth it — with the PHP and IP-reputation groups still present it would have been over 1,300 with almost nothing left. `CommonRuleSet` exclusions and scope-down statements consume WCU, so budget from 298, not from 1,500. Read it any time with `aws wafv2 get-web-acl-for-resource --resource-arn <alb-arn> --query 'WebACL.Capacity'`.
  - [ ] **First promotion pass — flip exactly one group, everything else stays counting.** `KnownBadInputsAction=block`. It is the only group left whose false-positive exposure is low enough to enforce on reasoning alone (narrow, exploit-payload specific, and the virtual-patching layer between a CVE landing and a patched image). The other four stay `count`.
    - Parameter overrides on the cluster stack update; all other parameters keep their previous values:
      ```
      KnownBadInputsAction=block
      WafBlockedRequestAlarmThreshold=<n>
      ```
    - [ ] **Read its counts before flipping, not after.** It should be counting near zero against normal traffic. Steady volume means it is a false-positive source and the order changes.
    - [ ] **Set `WafBlockedRequestAlarmThreshold` in the same deploy.** At `0` the `WafBlockedRequestAlarmEnabled` condition is false and the alarm resource is never created — the first real block would be invisible. The alarm is dimensioned per `Rule`, so it names what fired, which is what separates an attack from a misfiring rule.
    - [ ] **Then watch `BlockedRequests` per rule for 48 h** before promoting anything further. Frankfurt first for the evidence (Paris is staging and its traffic proves nothing), then the other region.
    - **`RateLimitAction=block` is separately gated:** the `Rules` section refuses the update unless `WafClientIpHeader` is set, because proxied requests would otherwise aggregate onto Cloudflare's addresses and blocking would take out every proxied site.

  - [ ] **Managed rule group versions are not pinned — decide deliberately.** `ManagedRuleGroupStatement` has an optional `Version`; the template omits it, so every group tracks AWS's default version and new signatures arrive automatically. That is most of the value (a new CVE signature lands in Known Bad Inputs without anyone acting) and also the risk (a new version can introduce a false positive on a Saturday). The alternative is pinning versions and updating on purpose, which trades that risk for the work of tracking releases. Unpinned is the right default here given the team size; record it as a choice rather than an oversight.


  - [ ] **Know what is running before a CVE lands.** Nothing today maps services to images and versions, so "are we affected?" starts with `describe-task-definition` across 36 stacks. Options: ECR enhanced scanning (Amazon Inspector) on pushed images, a documented image/version inventory, or the `TemplateVersion`-style tagging idea already on this list extended to the application image.
  - [ ] **Reduce the exposed surface.** `gwa-gut-sol-p` is Solr and should not be internet-reachable — confirm its listener rules. Admin paths in general belong behind an IP restriction rather than only a login form.
  - [ ] **Post-exploitation containment is a separate layer:** LII26-96 Phase 4 (DNS Firewall `BLOCK`) limits C2 and exfiltration, and GuardDuty Runtime Monitoring would record execution inside a container. Both are already tracked above; a WAF does not replace either.

- [ ] **No ALB is protected by WAF, and CloudFront is bypassable — verified in the templates 2026-08-19.** The `WebACLId` in `cloudfront-alb-distribution` attaches the WebACL to the **CloudFront distribution** (scope `CLOUDFRONT`); no `AWS::WAFv2::WebACLAssociation` exists in this repo, so no ALB has ever had one. WAF therefore inspects only traffic that actually travels through CloudFront.
  - **The bypass:** CloudFront sends `X-Origin-Verify` via `OriginCustomHeaders`, and the template's own Description says the ALB must enforce it — but `ecsservice` listener rules use only `host-header` and `path-pattern` conditions, never `http-header`. Combined with `SgPublicHttpHttps` allowing 80/443 from `0.0.0.0/0`, anyone who knows the ALB hostname reaches the service directly and skips WAF, rate limiting and the IP reputation list. ALB hostnames are not secret — certificate transparency exposes them, and the Phase 3 Step A analysis already showed scanners probing these load balancers.
  - **Scope, per Philipp 2026-08-19: CloudFront is only used in Ohio at the moment.** So the bypass is not the live problem in `eu-west-3`/`eu-central-1` — there is simply no WAF in that path at all, which the incident item above addresses with a `REGIONAL` WebACL on the ALB. Confirm with `aws cloudformation describe-stacks --query "Stacks[?contains(StackName,'cloudfront')].StackName"` per region including `us-east-1` and `us-east-2`, and treat the origin-verify gap as a design fix for whenever CloudFront is used in front of a European ALB. No distribution stack anywhere means nothing is exposed *through* this path today and the fix can be a design decision rather than an incident.
  - **Fixes, strongest first:** restrict the ALB security group's ingress to the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing` so only CloudFront can reach it at all (a security-group change in the cluster template, far stronger than a header check); *or* add an `http-header` condition on the listener rules plus a default-action deny, which is what the existing `OriginVerifyValue` parameter was designed for but never wired to; *or* attach a `REGIONAL` WebACL directly to the ALB, which works in `eu-west-3`/`eu-central-1` without any `us-east-1` deployment and protects direct traffic too.
  - Note the parameter is `NoEcho` with `MinLength: 1`, so every deployment already has a secret value set — the enforcement half is simply missing.

- [ ] **AWS Firewall Manager — assessed 2026-08-19, not pursued.** No prior analysis existed; recorded here so the question is not reopened from scratch. Firewall Manager is a **multi-account governance** tool: it centrally applies WAF WebACLs, Shield Advanced, security-group audit policies, Network Firewall and Route 53 DNS Firewall associations across an organisation. Its prerequisites are AWS Organizations with all features enabled, a designated FMS administrator account, and AWS Config recording in every account and region in scope; policies are billed per policy per region, on top of Config's per-configuration-item cost.
  - **Does not fit the current estate.** Everything in this repo lives in a single account (`848331400135`) with CloudFormation as the source of truth. FMS would add a second control plane that applies and remediates rules out of band — precisely the drift problem the `DnsFirewallCatchAllAction` note warns about, where a change made outside the template is silently reverted by the next stack update.
  - **Nothing it offers is missing today.** The WAF WebACL is in `cloudfront-alb-distribution`; the DNS Firewall rule group and its VPC association are in the cluster template; the security groups are in the cluster template. With one account, "central management" means the git repository.
  - **The one tempting feature** is a security-group audit policy that flags overly permissive rules — which is exactly Phase 3 Step C's blocker (three instance SGs with no `SecurityGroupEgress`, so each inherits allow-all). But that belongs in the template, and if detection is wanted separately, an AWS Config managed rule or CloudFormation drift detection covers it without FMS or Organizations.
  - **Revisit when** a multi-account structure exists (separate accounts per client or per environment), which is the point at which per-account templates stop scaling. Until then the answer is no.
  - Verify the premise if in doubt: `aws organizations describe-organization` — an `AWSOrganizationsNotInUseException` confirms the single-account assumption this assessment rests on.

- [ ] **`scripts/bootstrap-cluster.sh` — make standing up a new cluster hard to get wrong.** A new cluster is four stacks in a required order, and the two things that actually go wrong are the order and hand-copied ARNs between them. The script should deploy `alb-logs-bucket` → `ecscluster-vpc-rds-asg` → `guardduty` (skip if a detector already exists in the region) → `backup-vaults-mirror` (in `BackupCopyDestinationRegion`), waiting for each and feeding the previous stack's outputs into the next one's parameters. Also worth handling: the cluster template is 104 KB and so needs an S3 upload rather than `--template-body`.
  - **Merging the satellites is not the fix — three of them cannot merge.** `guardduty` is one detector per account **per region** (eu-central-1 already has two clusters, so a cluster-owned detector would fail outright on the second and deleting either would disable detection for the other). `backup-vaults-mirror` lives in a different region and CloudFormation stacks are single-region. `alb-logs-bucket` is `Retain`-policied, so even merged it would block a delete-and-recreate of the cluster by leaving a bucket that already exists. `efs-access` is throwaway by design. The WAF was the only genuine merge candidate and is now in the cluster template.
  - Worth weighing against how rarely a cluster is created. If it stays a once-a-year event, the README's deployment-order section is already the checklist and the script may not earn its maintenance.

- [ ] **Add `TemplateVersion` output to the remaining templates.** Only `ecsservice` (`1.2.0`) and `ecscluster-vpc-rds-asg` (`1.1.0`) have it. Without it, "which template is this stack on?" costs a `LastUpdatedTime` comparison plus git archaeology instead of one query. Order: `guardduty` and `alb-logs-bucket` (per region), then `backup-vaults-mirror`, then the leaf templates. Note each template needs its own filter for a fleet query — the `ecsservice` one keys on the `TargetGroupArn` output.

- [ ] **`ecscluster-vpc-rds-asg` — add a Gateway VPC Endpoint for S3.** No VPC endpoints exist, so all S3 traffic exits via NAT.
  ```json
  { "Type": "AWS::EC2::VPCEndpoint", "Properties": {
      "VpcId": { "Ref": "Vpc" },
      "ServiceName": { "Fn::Sub": "com.amazonaws.${AWS::Region}.s3" },
      "VpcEndpointType": "Gateway",
      "RouteTableIds": [ { "Ref": "RoutetablePrivate" } ] } }
  ```
  The direct cost saving is a few euros a year at our volumes — the real reasons are that it lets Step C match the S3 **managed prefix list** instead of allowing `443 → 0.0.0.0/0` for ECR layer pulls, and that EFS-restore uploads stop paying NAT. Gateway endpoints cover S3/DynamoDB in-region only. ECR/SSM **interface** endpoints are deliberately out of scope: they bill per hour per AZ plus per GB, which exceeds the NAT traffic they would replace.

- [ ] **`ecscluster-vpc-rds-asg` — RDS uses a static master password, no `EnableIAMDatabaseAuthentication`.** Every application authenticates with the same `RdsMasterPassword` stack parameter. IAM auth would give each ECS task a short-lived token from its role, revocable per service without rotating a shared secret. Requires connection-string changes in every application — not a quick fix.

- [ ] **`ecscluster-vpc-rds-asg` — nothing ever replaces a running instance, so hosts drift indefinitely.** `dnf-automatic` installs *security* updates only and never reboots, so the running kernel and every long-lived daemon stay at the version the instance booted with. Replacement happens only when someone terminates an instance by hand. Ship as `1.3.0`: launch-time AMI resolution plus a scheduled instance refresh per cluster.
  - **`ImageId` must resolve at launch, not at deploy.** `{{resolve:ssm:…}}` is a *CloudFormation* dynamic reference — CFN resolves it during the stack update and bakes a literal `ami-…` into the launch template version. Without a stack update the LT is frozen, so a scheduled refresh would relaunch instances onto the *same* AMI (and with `SkipMatching: true`, do nothing at all). Change it to the EC2-native form — `"ImageId": { "Fn::Sub": "resolve:ssm:${AmiSsmParameter}" }`, no braces around `resolve` — so EC2 resolves the parameter at each launch. The path comes from a new `AmiSsmParameter` stack parameter (default AWS's `recommended` path) because the two clusters point at different parameters; see the canary bullet. Side effect: the four-row AMI cascade documented in README.md disappears from every unrelated stack update; that README note then needs rewriting.
  - **Accept the loss of auto-rollback.** Instance refresh does not support `AutoRollback` for launch templates that use SSM parameters. `AlarmSpecification` still *fails* a refresh — it just will not revert what was already replaced. With 1–3 instances plus a checkpoint that means one bad instance to clean up, not a fleet. `Fn::GetAtt LatestVersionNumber` stays as it is (a concrete integer, not `$Latest`).
  - **Schedule via `AWS::Scheduler::Schedule`** with a universal target (`arn:aws:scheduler:::aws-sdk:autoscaling:startInstanceRefresh`) and a role scoped to `autoscaling:StartInstanceRefresh` on that one ASG — no Lambda. Gate it behind an `EnableScheduledInstanceRefresh` parameter so it can ship disabled. `ScheduleExpressionTimezone: Europe/Berlin`, 03:00.
  - **Paris is the canary, and Frankfurt runs the exact image Paris validated.** Do not let both clusters resolve `recommended` independently — AWS publishes a new ECS-optimized AMI at roughly the same two-week rhythm as the refresh cycle, so Frankfurt would routinely land on an image Paris never ran. Instead the AMI path becomes a stack parameter (`AmiSsmParameter`), and the two clusters get different values:
    - **Paris** — `/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id` (AWS's parameter, always current). Staging; churn is the point.
    - **Frankfurt** — `/labor/ecs-ami/al2023/production`, a customer-managed parameter holding one explicit AMI ID. Production only ever launches what was put there.
    - **Promotion is the gate.** After Paris has run a new AMI for a week with no `AlarmHttp5xxTarget` alarms, healthy targets and working EFS mounts, read the image Paris is *actually* running (`aws ec2 describe-instances` filtered by the ASG tag, take `ImageId` — ground truth, not a re-read of `recommended`, which will have moved) and `aws ssm put-parameter --overwrite` it into the production parameter. Frankfurt's next scheduled refresh then picks up exactly that image.
  - **What the owned parameter buys beyond the canary.** `aws ssm get-parameter-history` becomes an audit trail of every production AMI change and when. Rollback is putting the previous ID back and starting a refresh — which substantially offsets losing `AutoRollback`. Frankfurt scale-out events also stop being a silent AMI jump: they launch the promoted image rather than whatever is newest that day, which closes the unattended-jump hole for production specifically. And forgetting to promote is a safe failure — Frankfurt refreshes become no-ops under `SkipMatching` instead of drifting.
  - **Cadence.** Paris `cron(0 3 1,15 * ? *)`, Frankfurt `cron(0 3 8,22 * ? *)` — each cluster roughly every two weeks, the two alternating weekly, Paris always first. Same reasoning as the `ecsservice` rollout: Paris is a staging mirror, so it is the right place to rehearse and the wrong place to gather traffic-shaped evidence. Keep promotion manual at first; a schedule cannot judge whether a week looked clean, and the promotion step is where a human decides.
  - **Preferences:** `MinHealthyPercentage: 100` + `MaxHealthyPercentage: 200` (launch-before-terminate — capacity typically sits at 1–2 instances, so terminate-first would leave a real hole; `AscalegroupMaxSize` default 3 gives the headroom), `InstanceWarmup: 300` to match `HealthCheckGracePeriod`, `SkipMatching: true` so a run with no new AMI is a free no-op, `AlarmSpecification` pointed at the `AlarmHttp5xxTarget` alarms from `ecsservice` `1.2.0`, plus `CheckpointPercentages`/`CheckpointDelay` and a `BakeTime` long enough for those alarms to fire. Refreshes are cancellable mid-flight. `ManagedTerminationProtection` is `DISABLED`, so `ScaleInProtectedInstances` is not needed.
  - **`ManagedDraining` — verified `ENABLED` in both regions 2026-08-19, no longer a blocker.** `labc-eu-w3-CapacityProvider-t9qa377xrJPK` and `labc-eu-c1-CapacityProvider-qkF1sVQ2WDf5` both report `managedDraining: ENABLED` (`ManagedTerminationProtection: DISABLED` as templated). The template never sets `ManagedDraining`, so this comes from the ECS API default rather than from anything we own — instances entering termination during a refresh are drained and their tasks rescheduled first, which is the behaviour the refresh design depends on. **Do not "just add it to the template" without a change set:** the live value already matches what we would set, so an unset→`ENABLED` diff buys nothing functionally, and if CloudFormation treats it as create-only the capacity provider gets replaced — disruptive, since it is wired into the cluster's default capacity provider strategy and every service using it. Confirm the change set shows an in-place update before adopting it; otherwise leave it unset and record here that it is a documented API default.
  - **Keep `dnf-automatic`, with its role written down.** Once refreshes run, the AMI carries the kernel and full userspace; `dnf-automatic` covers only the 0–14 day gap between refreshes, and only for host processes that actually restart — the EFS mount helper (`mount.efs` + `stunnel`, spawned per task placement) and SSM sessions. Containers run their own userspace from ECR and are untouched by host patching either way. It costs nothing, so removing it is downside-only. Do **not** add `reboot = when-needed` as a substitute: an unannounced reboot does not drain ECS tasks, a refresh does.
  - **Record the scanner caveat.** With patches installed on disk but the old kernel running, anything reading installed package versions reports the CVE as fixed. `rpm -q --last kernel` against `uname -r` is the honest check; after a refresh the two should agree.
  - **Cost is not the constraint.** The refresh API is free; the spend is a few minutes of overlap capacity plus ECR layer re-pulls on each new host — roughly €0.45 per instance replacement in NAT processing at ~10 GB of layers. The S3 gateway endpoint already on this list takes that to zero. The real limit is AMI cadence: refreshing more often than AWS publishes buys nothing.
  - Note in the timeline table once scheduled, so the alternating weeks are visible next to the other per-cluster rows.

- [ ] **`ecscluster-vpc-rds-asg` — `BackupRole` cannot perform restores.** It carries only `AWSBackupServiceRolePolicyForBackup`; a restore also needs `...ForRestores`. Current practice is the console's `AWSBackupDefaultServiceRole` (account-wide, created outside CloudFormation). Decide: keep the split (better posture, and the unowned role is then intentional) or add a scoped restore role. Record the decision either way.

- [ ] **Create new dashboards.** Both clusters have the template-provisioned Overview dashboard. Evaluate what else earns one (per-service deep-dive, DNS Firewall/egress views) and add it to the template so every cluster gets it.

- [ ] **`ecsservice` — CloudWatch anomaly detection for network throughput.** Add `NetworkIn`/`NetworkOut` anomaly detection with `EnableNetworkAnomalyDetection` and `NetworkAnomalyThreshold` parameters. CloudWatch learns the baseline over ~2 weeks, then alerts on >2σ deviation — adapts per service without hardcoded thresholds. Needs the warmup before it is useful.

- [ ] **Detecting compromise of an ephemeral container.** GuardDuty Malware Protection for EC2 does not close this gap: it scans EBS only (so the EFS mount at `VolumeMountPath` is never scanned), a scan only starts after GuardDuty already raised a finding — and a file written inside a container is invisible to flow logs, DNS logs and CloudTrail — and the container writable layer is discarded on the next deploy, taking the evidence with it. Container contents *are* in scope where they sit on EBS, attributed as `Execution:ECS/MaliciousFile`. Durable evidence today: ALB access logs (verified enabled in Frankfurt 2026-08-16), DNS firewall logs, flow logs, container logs. Missing: anything recording *execution*.
  - Evaluate **GuardDuty Runtime Monitoring** (`RUNTIME_MONITORING`, currently `DISABLED`, sub-options `EC2_AGENT_MANAGEMENT` / `ECS_FARGATE_AGENT_MANAGEMENT`) — agent-based, emits a finding at execution time that outlives the container and covers EFS paths. Check ECS-on-EC2 support, agent footprint on `t3.small`, cost.
  - Enable `EBS_MALWARE_PROTECTION` anyway via the guardduty template (not the console) — 30-day free trial, small per-GB cost on 30 GB root volumes, and it incidentally checks ECR image contents. Do not record it as covering application data.
  - Per service, determine which paths are image vs EFS. For the `-typ` TYPO3 and Matomo services it matters whether extension directories sit inside the image (scanned, not persistent) or on the EFS mount (persistent, unscanned). Check `sudo ls -la /mnt/efs/<service-stack-name>/`.
  - Everything has 14-day retention, so no investigation reaches back further than two weeks. Deliberate DSGVO tradeoff, but it means alerting inside the window matters more than analysis run eventually.

---

## LII26-96: Zero-Trust Outgoing Network Security

Execute per cluster in order: **Paris (labc-eu-w3) → Frankfurt (labc-eu-c1)**.

**Phase 1 — LII26-94: DNS monitoring (ALERT mode)** — ✅ complete in both regions. DNS Firewall, Route 53 query logging, metric filter and alarm deployed; GuardDuty active with FlowLogs/DNSLogs/CloudTrail verified; 7-day baselines finished 2026-07-16 (Paris) and 2026-07-17 (Frankfurt).

### Phase 2 — LII26-93: Log analysis & whitelist

- [ ] Run `DnsFireWallLogsSummary`, group ALERT'd domains by frequency, separate legitimate services from trackers and noise
- [ ] Build the whitelist, aggregating by root domain. Wildcards match a single subdomain level only — `*.example.com` covers `foo.example.com` but not `foo.bar.example.com`
- [ ] **Include the container registry domains, not just ECR.** `lab-ana-mat-p` (`matomo:5.8`) and `gwa-gut-sol-p` (`solr:9.9`) pull from Docker Hub. A `BLOCK` catch-all breaks the **image pull at the next task placement**, not the running container — so the Phase 4 application test would pass while those services silently cannot restart or scale. Needs `registry-1.docker.io`, `auth.docker.io` and the layer CDN; confirm exact hostnames from the ALERT logs.
- [ ] **ECR lives in `eu-central-1` for *both* regions — whitelist that region, not the local one.** Verified 2026-08-20 from `InitialDockerImage` across all 15 Paris stacks: every repository is `848331400135.dkr.ecr.eu-central-1.amazonaws.com/…`, including the Paris `-s` staging services. So Paris pulls images **cross-region** on every task placement. A whitelist built from `eu-west-3` endpoints would break **every** image pull in Paris — and per the item above it breaks at the next task placement, not immediately, so the Phase 4 application test would pass while nothing could restart or scale. Needs `*.dkr.ecr.eu-central-1.amazonaws.com`, the ECR API endpoint for that region, and the layer-storage S3 endpoints it redirects to (`prod-eu-central-1-starport-layer-bucket.s3.eu-central-1.amazonaws.com` and friends — confirm the exact hostnames from the ALERT logs rather than assuming).
  - Side note for later, not a Phase 2 blocker: cross-region pulls traverse the NAT gateway and are billed as data transfer plus NAT processing on every placement. A VPC endpoint would not help, since it would have to be in `eu-central-1`. If pull cost or latency ever matters, the fix is replicating the repositories into `eu-west-3`, not more networking.
- [ ] Update `DnsFirewallWhitelistDomains` and deploy
- [ ] Correlate GuardDuty findings with the DNS logs
- [ ] Record projected GuardDuty monthly cost from the Usage page

### Phase 3 — LII26-95: Security group hardening

**Prerequisites:** Phase 1 and 2 complete, GuardDuty verified.

**Step A — port audit.** ✅ Paris analysed 2026-08-07 over 28 days. The saved query's two defects (counting inbound replies, and NAT double-counting) were fixed in the template on 2026-08-14 by narrowing the source filter to the private subnets (`/^10\.1\.[34]\./`) plus a `srcport != 443/80` backstop, with `limit` raised to 500 — **not yet deployed to Paris**. The 128 apparent "dead ports" were verified as our RSTs landing on inbound scanners' fixed source ports (masscan/zmap profile, Censys among the sources) — inbound-initiated, no egress rules needed, no compromise indicated.

Result (connection counts NAT-deduplicated, raw ÷ 2):

| Port | Conns | Bytes | Destination | Source | Verdict |
|---|---|---|---|---|---|
| 443/TCP | ~978,000 | ~6.60 GB | `0.0.0.0/0` | all | allow |
| 123/UDP | ~50,300 | ~4.9 MB | Ubuntu NTP pool | `10.1.3.7` | not cluster traffic |
| 80/TCP | ~216 | ~658 KB | — | all | likely OCSP/CRL — confirm before dropping |
| 4318/TCP | 14 | 274 KB | `149.248.216.54` | `10.1.3.76`, `10.1.4.99`, `10.1.4.12` | OTLP telemetry export |
| 22/TCP | 14 | 83.5 KB | `185.166.143.48-50` | `10.1.3.7` | not cluster traffic |
| 4460/TCP | 5 | 5.5 KB | Canonical NTS-KE | `10.1.3.7` | not cluster traffic |
| 3724/TCP | 9 | 1.56 KB | `145.239.131.113` (OVH) | `10.1.3.7` | **unidentified** |
| 587/TCP | 2 | 6.2 KB | `95.217.210.26` (Hetzner) | `10.1.3.45` | **SMTP — real, do not remove** |
| 53/UDP | 12 | 960 B | `8.8.8.8` | `10.1.3.76`, `10.1.4.99`, `10.1.4.12` | DNS Firewall bypass — see below |
| ICMP | 3 | 264 B | — | — | ping |

- [ ] Run the analysis in Frankfurt, then set `EnableEgressAnalysis=false` in **both** regions
- [ ] Identify `3724/TCP → 145.239.131.113` — the one remaining unknown, from `10.1.3.7`

**Step B — NTP.** ✅ Resolved 2026-08-07. The ECS hosts already use Amazon Time Sync (`169.254.169.123`, which flow logs do not record). All external NTP, NTS-KE, SSH and the OVH traffic originate from `10.1.3.7` = `lab-dev-llm-s-EC2`, a `t3a.large` Ubuntu box from its own stack, not an ASG member — so `123/UDP`, `4460/TCP`, `22/TCP` and `3724/TCP` leave Step C entirely.

- [ ] `lab-dev-llm-s` needs its own egress policy — separate stack, separate SG, outside this repo. Track it there.

**Step C — apply egress rules.** Target set, five rules:

| Rule | Destination | Rationale |
|---|---|---|
| 443/TCP | `0.0.0.0/0` | web/APIs, ~99% of egress; GuardDuty watches for anomalies |
| 80/TCP | `0.0.0.0/0` | OCSP/CRL — **dropping this breaks TLS validation** |
| 587/TCP | `95.217.210.26/32` | SMTP relay, from `10.1.3.45` |
| 4318/TCP | `149.248.216.54/32` | OTLP telemetry, from 3 of 9 hosts |
| 53/UDP+TCP | VPC CIDR **only** | internal DNS; this is what closes the `8.8.8.8` bypass |

**⚠️ All three instance security groups must be restricted or this is a no-op.** The launch template attaches `SgVpcMysqlAccess`, `SgVpcLoadbalancerports` and `SgVpcEfsAccess`, and **none defines `SecurityGroupEgress`** — so each inherits allow-all. SG rules are additive: if one still allows everything, restricting the other two changes nothing. Either add the set to all three, or introduce one dedicated egress SG and strip allow-all from the rest.

- [ ] Fix the OTel agent's hardcoded resolver **first** — the `53 → VPC CIDR` rule blocks its `8.8.8.8` queries the moment it lands, and it then cannot resolve its collector. Three sources (`10.1.3.76`, `10.1.4.99`, `10.1.4.12`) are the same image deployed three times, so it is one fix. Until then those queries bypass the whitelist, the ALERT logging and later BLOCK enforcement entirely.
- [ ] Confirm the `80/TCP` destinations really are OCSP/CRL before allowing plaintext egress to the internet
- [ ] Delete the blanket `Egress: ALL → 0.0.0.0/0` rule and apply the table above

**Step D — automated incident response.** The `guardduty` stack already provides the Quarantine SG (`<stack>-QuarantineSgId`, zero egress), the execution role (`-IncidentResponseRoleArn`) and the detector ID (`-DetectorId`).

- [ ] Lambda: swap a target instance's security group to the Quarantine SG
- [ ] EventBridge rule: GuardDuty finding with HIGH severity → the Lambda
- [ ] Test end-to-end with sample findings and confirm the instance moved to the Quarantine SG

### Phase 4 — LII26-92: Go live (BLOCK mode)

- [ ] **First:** add a `DnsFirewallCatchAllAction` parameter (`ALERT`/`BLOCK`, default `ALERT`) to the cluster template. The action is currently hardcoded, so flipping it by CLI would be drift that the next stack update silently reverts — disarming enforcement.
- [ ] Run `DnsFireWallLogsSummary` once more; confirm no legitimate domain still appears as ALERT
- [ ] Set `DnsFirewallCatchAllAction=BLOCK` (response NXDOMAIN) via stack update
- [ ] Test critical applications: Lieferchat, Matomo, email, time sync — and image pulls
- [ ] Monitor for unexpected BLOCK events for 48h. Rollback = same parameter back to `ALERT`

---

### Related tickets

- **LII26-94:** Route 53 DNS Firewall im Audit-Modus (ALERT) aufsetzen
- **LII26-93:** Log-Analyse & Erstellung der FQDN-Whitelist
- **LII26-95:** Härtung der Security Groups & Aktives Port-Audit
- **LII26-92:** Go-Live & Scharfschaltung (Enforcement auf BLOCK)

---

## Solr exposure — probed and credential-rotated 2026-08-20

Supersedes the assumptions in the "Harden the Solr services" item above. Probed live, credential side closed, network side still open.

### Resolved 2026-08-20

- [x] **Auth is correctly enforced on every data and admin path.** `blockUnknown` defaults to `true` in Solr 9.x, and `/select`, `/config` and `/admin/*` all return `401` unauthenticated. The only `200` is the static Admin-UI HTML shell, which is normal — its API calls fail without credentials.
- [x] **Index contents reviewed: public data only.** Title, content, author display name, comments, tags. No e-mail, password or PII fields; drafts and private posts excluded. A read-only credential leak therefore exposes nothing beyond what the site already publishes.
- [x] **Logs reviewed (~5 days): clean.** No external source IPs, none of the Aug-2026 incident IOCs (`209.50.167.208`, `198.98.55.27`, wp2shell), no RCE signatures (JNDI, Velocity, config-API, streaming), no `ERROR`/`FATAL`. One `/etc/passwd` string was a payload typed into the site search box, `hits=0`.
- [x] **Attack surface minimal:** `enableRemoteStreaming=false`, `<lib/>` loading disabled. Running Solr 9.9.0.
- [x] **Credential rotated end-to-end.** The single BasicAuth user `labor` was exposed in three places — **plaintext in WordPress `wp_options` (`wpsolr_solr_indexes`)**, as a hash in the EFS dump, and in every production DB dump; identity confirmed by hash match. **It was not on the Aug-2026 incident rotation list.** Replaced with a least-privilege split: new `gwa_search` (query/index only, cannot edit security) for WordPress, and a fresh admin secret for `labor`. Verified: `gwa_search` → 200, WP search live, old secret → 401, new admin secret → 200 with admin role. Persisted to the live `security.json`.

**Process gap worth acting on separately:** a credential sitting in plaintext in `wp_options` was missed by the incident rotation list. Anything that can read the WordPress database — including the SQL-injection stage of the wp2shell chain in the WAF section — yields it. The new `gwa_search` secret lives in the same place, which is exactly why the least-privilege split matters: assume it is compromised in any future WordPress breach. Worth auditing `wp_options` for other third-party service credentials stored the same way.

### Open — network level

- [ ] **Confirm and close the ALB-direct bypass. This is the real remaining risk.** `suche.gwa.de` resolves to Cloudflare (`188.114.96.3` / `188.114.97.3`, inside the published `188.114.96.0/20`; responses carry `server: cloudflare`, `cf-ray: …-LHR`, `cf-cache-status: DYNAMIC`, and the HTTP→HTTPS 301 happens at the edge). But Cloudflare only protects traffic that goes through it. If the ALB answers a request carrying `Host: suche.gwa.de`, the edge WAF, rate limiting and DDoS shielding are all sidestepped, leaving only Solr BasicAuth in front of a Java service with an RCE history. **Untested — the probing session had an expired SSO token.**
  ```
  ALB=$(aws elbv2 describe-load-balancers --region eu-central-1 --query 'LoadBalancers[0].DNSName' --output text)
  curl -sS -k -o /dev/null -w '%{http_code}\n' -H 'Host: suche.gwa.de' "https://$ALB/solr/"
  ```
  `401` from Solr = bypass open. `404` from the ALB default action = the listener rule did not match and only the Cloudflare path works.
- [ ] **Verify Cloudflare SSL mode is Full (strict).** Solr logs warn *"authentication enabled, but SSL is off"* — it speaks plain HTTP, so TLS terminates at the edge or the ALB and the BasicAuth credential crosses the ALB→task hop in cleartext inside the VPC. Bounded (needs host-level access to observe) but worth closing. The ALB already has an ACM certificate (`HttpsdefaultlistenerCertificate`), so Full (strict) should work without change.
- [ ] **Consider an edge allowlist or Cloudflare WAF rule on `/solr/` admin paths.** Cheap, and independent of the AWS-side fixes.
- [ ] **Probe staging the same way** — `gwa-gut-sol-s`, Paris. Its hostname is in the stack rather than needing to be remembered:
  ```
  aws cloudformation describe-stacks --region eu-west-3 --stack-name gwa-gut-sol-s \
    --query "Stacks[0].Parameters[?ParameterKey=='ListenerRuleHost'].ParameterValue" --output text
  ```
- [ ] **Keep Solr on the latest 9.9.x patch** while it remains internet-facing.

### What the templates prove regardless of the above

`ecsservice` cannot express a private service: `Target`, `LoadbalancerRuleHttp` and `LoadbalancerRule` are unconditional and `ListenerRuleHost` is required (`MinLength: 1`). Listener rules match on `host-header` and `path-pattern` only — there is **no `source-ip` condition anywhere in the repo** — and the cluster ALB sits behind `SgPublicHttpHttps`, open on 80/443 to `0.0.0.0/0`. So the ALB itself accepts Solr traffic from anywhere; whether that is exploitable depends entirely on the bypass check above.

Solr's own guidance is worth quoting when this gets deprioritised: *"Solr is not designed to be exposed to non-trusted parties or the open internet... the project does not consider Admin UI XSS issues to be security vulnerabilities."* Upstream declines to treat a bug class as vulnerabilities **because** they assume no exposure, so "we run a patched 9.9" is not a defence. The WAF does not cover it either — those rule groups target PHP, and Solr is Java.

### Decision 2026-08-20: internal ALB. Scope for now is Solr only.

Solr is a backend consumed by `gwa-gut-web-p`, which runs on the same cluster in the same VPC — verified: the ASG places instances in `SubnetPrivate1`/`SubnetPrivate2`. The public round-trip is an artefact of the template, not a requirement, so the origin-protection question does not need answering for Solr at all: take it off the public ALB and Cloudflare, source-IP conditions and prefix lists all become irrelevant.

**Implementation, Paris first (`gwa-gut-sol-s`), Frankfurt after it is proven.**

- [x] **1. Add the internal ALB to the cluster stack** — **done, cluster `1.3.0` deployed to Paris 2026-08-20.** Verified live: `Scheme: internal`, `state: active`, subnets exactly `SubnetPrivate1`/`SubnetPrivate2`, DNS `internal-labc-eu-w3-InternalLb-1954307613.eu-west-3.elb.amazonaws.com`. Change set was the expected 7 rows — 3 `Add` for the internal ALB plus the four-row AMI cascade, no WAF rows since Paris already had `1.2.0`. **Frankfurt still pending**, and there the change set will additionally carry the 5 WAF `Add` rows. Get the listener ARN with `describe-stacks … OutputKey=='InternalListenerArnHttp'`. (`ecscluster-vpc-rds-asg/index.template`) — *not* a separate stack. Revised 2026-08-20: it is cluster-level singleton infrastructure, the sibling of the existing `Loadbalancer` / `Httpdefaultlistener` / `Httpsdefaultlistener` / `Deftarget`, and the split-stack precedents (`alb-waf`, `guardduty`, `alb-logs-bucket`) exist for things that are optional per cluster and iterated often, which this is not. Two decisive points: a cluster deploy is already owed (`1.3.0` to Frankfurt and Paris, plus the `SgVpcEfsAccess` export patch), so it rides an AMI cascade already being paid for; and a separate stack could not use `SgVpcLoadbalancerports` for the ingress rule without exporting it from the cluster stack anyway.
  - `InternalLoadbalancer`: `Scheme: internal`, `Subnets: [ {Ref: SubnetPrivate1}, {Ref: SubnetPrivate2} ]`
  - `SgInternalAlb`: ingress tcp/80 from `{Ref: SgVpcLoadbalancerports}` — precise rather than VPC-CIDR, which is only possible because this lives in the same stack
  - `SecurityGroups: [ {Ref: SgInternalAlb}, {Ref: SgVpcLoadbalancerportsAccess} ]` — the second means the internal ALB is already permitted to reach container dynamic ports, since `SgVpcLoadbalancerports` allows 32768–61000 from exactly that SG. No extra instance-side rule.
  - `InternalHttplistener`: `HTTP:80`, `DefaultActions` a `fixed-response` 404. No TLS — Solr speaks HTTP, so terminating inside the VPC adds nothing.
  - Exports `-InternalListenerArnHttp` and `-InternalAlbDns`, in the existing export style.
  - ~60 lines. Note the template is already over the 51,200-byte inline limit, so it goes via S3/console either way — that is not a reason to split.
- [ ] **2. No DNS record — use the exported ALB hostname.** Decided 2026-08-20: the private hosted zone is *not* going into the cluster template, and on reflection it buys little. The internal ALB already exports `-InternalAlbDns`, so the endpoint is discoverable from the stack (`describe-stacks --query "Stacks[0].Outputs[?OutputKey=='InternalAlbDns'].OutputValue"`) — better discoverability than a hand-created record. Set `ListenerRuleHost=*` on the service, which matches any Host header and is fine on a listener serving only internal traffic.
  - Trade-off accepted: if the internal ALB is ever *replaced* (a `Name` or subnet change, not a plain update) its DNS name changes and the value in `wp_options` goes stale. Rare, and the failure is loud.
  - If a friendly name is wanted later — a second internal service, or the churn actually bites — a private hosted zone belongs in its own small stack, not in the cluster template.
- [ ] **3. `ecsservice`: add `ListenerArnOverride`** (String, default `""`). Smaller than the `ExposeViaLoadBalancer` idea and without its side effect — the target group still exists, so `AlarmAutoscaleScaleDown` keeps reading `HealthyHostCount` normally.
  - Conditions `HasListenerOverride` / `NoListenerOverride`
  - `LoadbalancerRule.ListenerArn` → `Fn::If[HasListenerOverride, {Ref: ListenerArnOverride}, ImportValue ...-ListenerArnHttps]`
  - `LoadbalancerRuleHttp` gets `"Condition": "NoListenerOverride"` — **the 80→443 redirect must not exist on an HTTP-only internal ALB**, or every request bounces to a port nothing is listening on
  - Default empty means the other 35 stacks render byte-identically
- [ ] **4. Update `gwa-gut-sol-s`** with `ListenerArnOverride=<internal listener arn>` and `ListenerRuleHost=solr.gwa.internal`. Verify from an instance via SSM: `curl -u gwa_search:… 'http://solr.gwa.internal/solr/<core>/select?q=*:*&rows=1'`.
- [ ] **5. WordPress cutover.** WPSolr stores the endpoint next to the rotated credential in `wp_options → wpsolr_solr_indexes`. In **WPSolr → Settings → Solr index** set scheme `http`, host `solr.gwa.internal`, port `80`, path `/solr/<core>`, keeping the `gwa_search` BasicAuth credential. Use the plugin's ping/"check index" button, then run a front-end search. Note the old values first — rollback is pasting them back.
- [ ] **6. Remove the public exposure.** Step 3 moves the rules rather than duplicating them, so the public rule is gone once deployed. Then delete the `suche.gwa.de` record at Cloudflare — or leave it a week pointing nowhere as a canary, since any traffic still arriving tells you something else was using it.

**Two snags to plan for.**

- **Rule replacement.** Changing `ListenerArn` forces replacement of the listener rule, and CloudFormation creates the replacement before deleting the original — so the target group is briefly referenced from two load balancers. If AWS rejects that, the update rolls back cleanly, but do it in a window rather than mid-morning. Another reason Paris goes first.
- **Health checks move with it.** The internal ALB takes over health checking via `ECSHealthCheckPath` with a 200 matcher. Solr's `/solr/` returns 200 today (the static admin shell), so this works — but if that path is ever locked down at Solr level, health checks fail and the service is marked unhealthy.

### Considered and not chosen (for Solr)

- **Restrict `SgPublicHttpHttps` to Cloudflare's ranges** — protects every service on the ALB, not just Solr, but Cloudflare's IP ranges are shared by *every* Cloudflare customer: anyone can point their own zone at the origin and pass the filter. It also needs a managed prefix list plus a refresh process, since the list changes. Keep as a possible supplementary layer, never as the only control.
- **`ListenerRuleSourceCidrs` / `source-ip` condition** — with Cloudflare in front, the ALB sees the proxy, so the allowlist would have to be Cloudflare's ranges and inherits the same shared-tenant weakness. Rejected as clumsy and rot-prone.
- **Off the ALB entirely** (`ExposeViaLoadBalancer` + Cloud Map) — cleanest isolation, most work. Under `bridge` mode with dynamic host ports Cloud Map needs **SRV** records, which most HTTP clients cannot resolve, and it breaks the scale-in alarm's `HealthyHostCount` source.
- [ ] **Still worth doing regardless: document the `security.json`.** Auth works but is expressed nowhere in this repo. Whatever provides it should be visible in the template or the image build, credential in Doppler/SSM — otherwise the next image bump silently removes the only thing between the internet and the index.

### Side effects of routing search through a public hostname

- [ ] **Whitelist `suche.gwa.de` before LII26-96 Phase 4.** The app resolves it and egresses through NAT, so a `BLOCK`-mode DNS Firewall catch-all breaks search silently. Add it alongside the Docker Hub domains in the Phase 2 whitelist item.
- Every query traverses NAT → Cloudflare → back to the ALB: NAT data-processing charges in both directions, two extra hops and a second TLS handshake per search, and search terms leaving the account entirely. If the terms can contain personal data, that is a DSGVO consideration for both the Cloudflare path and the ALB access logs.
- An internal ALB removes all of the above at once, which is the argument for treating it as the target state rather than a nice-to-have.

## Origin-verify header on the ALB — designed, deliberately deferred (2026-08-20)

**Not now.** Current scope is Solr only; this is the fix for the genuinely public sites and is recorded so the design does not have to be re-derived. It closes the Cloudflare bypass *and* the CloudFront one with a single template change.

**The bypass.** `SgPublicHttpHttps` allows 80/443 from `0.0.0.0/0` and listener rules match `host-header` + `path-pattern` only, so `curl -k -H 'Host: www.client.de' https://<alb-dns>/` reaches the origin and Cloudflare's WAF, rate limiting, bot management and DDoS protection never see it. ALB hostnames are not secret — certificate transparency lists them, and the Phase 3 Step A analysis already found scanners probing these load balancers.

**Why it also fixes CloudFront:** `cloudfront-alb-distribution` already sends `X-Origin-Verify` via `OriginCustomHeaders` and its own Description says the ALB must enforce it — nothing ever did, because `ecsservice` rules never had an `http-header` condition. Same parameter, different secret value; `Values` takes a list, so a service behind both front-ends can accept two.

**The control.** Listener rule conditions are ANDed, so a third condition makes the header mandatory:

```
{ "Field": "http-header",
  "HttpHeaderConfig": { "HttpHeaderName": "X-Origin-Verify", "Values": [ "<32+ char secret>" ] } }
```

Cloudflare side: **Rules → Transform Rules → Modify Request Header → Set static**, applied to all incoming requests for the zone. Available on every plan including Free.

**Template side:** parameters `OriginVerifyHeaderName` (default `X-Origin-Verify`) and `OriginVerifyHeaderValue` (default `""`, `NoEcho: true`), condition `HasOriginVerify`, then append to both rules' `Conditions` arrays via `Fn::If` returning `{"Ref": "AWS::NoValue"}` when unset — an `Fn::If` resolving to `AWS::NoValue` inside a list removes the element entirely, which is what keeps this non-breaking. Default empty renders the other stacks identically; opt in per service.

**Fallthrough is already safe:** both listeners' `DefaultActions` forward to `Deftarget`, an empty target group, so a non-matching request gets a 503. Worth changing to a `fixed-response` 403 anyway — the 503 is only harmless because `Deftarget` happens to have no targets registered.

**Rotation is zero-downtime**, because `Values` accepts a list: add the new secret alongside the old, update the Cloudflare Transform Rule, then remove the old. Three deploys, no window.

**Prerequisites before enabling.**

- Inventory everything that legitimately reaches the ALB *not* through Cloudflare — it breaks the moment the header is required. The `dig`-every-`ListenerRuleHost` one-liner in the Solr section answers this in one pass. Uptime monitors pointed at the ALB are the other usual suspect.
- **`suche.gwa.de` is exactly such a caller** while WP→Solr still goes through the public hostname. Do the internal-ALB move first, or this takes search down.
- Health checks are unaffected — the ALB health-checks targets directly, never through listener rules.

**Honest limit.** The application can read the header (`$_SERVER['HTTP_X_ORIGIN_VERIFY']`), so a compromised site leaks the secret and the bypass reopens until rotation. It is a bypass-prevention control, not an authentication boundary. mTLS (`MutualAuthentication: { Mode: verify, TrustStoreArn }` on the listener, with a **custom** Cloudflare origin-pull certificate — the shared global one has the same any-tenant weakness as the IP list) or Cloudflare Tunnel avoid this, because the credential never reaches the application. Header first, those later if cryptographic assurance is wanted.

## S3 bucket exposure audit — 2026-08-20

Verified live against the account (`aws s3api` output, all 17 buckets). **Result: no accidental public exposure.** Two buckets are public, both deliberately.

| Category | Count | Buckets |
|---|---|---|
| Public by design | 2 | `labor.media`, `s3-ado-lea-rad-p` — static website buckets, `IsPublic=True`, all four BPA flags `false`. Correct: BPA off is what makes them serve. |
| Fully protected | 13 | all four Block Public Access flags `true`, no public policy |
| Not public, but no BPA backstop | 2 | `cf-templates-ingduevmfvm0-eu-central-1`, `cf-templates-ingduevmfvm0-us-east-2` |

`labc-eu-w3-alb-logs` checked in detail: `IsPublic=false`, all four BPA flags, `BucketOwnerEnforced`, ACL grants owner only, and a single policy statement allowing `s3:PutObject` to `logdelivery.elasticloadbalancing.amazonaws.com` scoped to our own account path. No read access to anyone.

- [ ] **Apply BPA to the two `cf-templates` buckets.** Not public today, but the only two in the account with no backstop — a stray policy or ACL would make them public with nothing to stop it. Both are from the older `ingduevmfvm0` family, consistent with creation before S3 enabled BPA by default in April 2023.
  ```
  for b in cf-templates-ingduevmfvm0-eu-central-1 cf-templates-ingduevmfvm0-us-east-2; do
    aws s3api put-public-access-block --bucket "$b" \
      --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  done
  ```
  Zero risk: CloudFormation only ever reaches these from inside the account.

**Do not enable account-level Block Public Access.** It is currently unset (`NoSuchPublicAccessBlockConfiguration`), and enabling it would immediately break `labor.media` and `s3-ado-lea-rad-p`. The account-wide block only becomes available if those two move behind CloudFront + Origin Access Control, which would also give them TLS — S3 website endpoints are HTTP-only — and close the direct-access bypass. That is a project, not a command.

**About the `cf-templates-*` buckets.** Created automatically by CloudFormation when a template is uploaded — by the console's "Upload a template file" flow, or by any CLI deploy of a template over the 51,200-byte inline limit. `ecscluster-vpc-rds-asg/index.template` is **98 KB**, so every cluster deploy stages it in S3; these buckets are live infrastructure, not leftovers, and deleting them only means the next deploy recreates one. Nothing manages or prunes them, so every template version ever uploaded is still there. Severity of exposure would be architecture disclosure, not credentials: no template in the repo carries a hardcoded secret, `RdsMasterPassword` is `NoEcho` with no default, and parameter *values* live in the stack rather than the template. Optional tidy-ups: a lifecycle rule expiring objects after 30–90 days, and passing `--s3-bucket` explicitly on CLI deploys so new ones stop appearing (three distinct bucket ids exist across the regions already).

### Not covered by the audit — bucket settings are only one access path

- [ ] **Read the two interesting IAM policies.** Highest value of the three: a blanket `s3:*` on `*` makes every bucket setting above irrelevant for whoever holds it. `S3FS-Policy` (name suggests s3fs-fuse, commonly written far too broadly) and `AzureAD_SSOUserRole_Policy` (what humans get through SSO, so the largest blast radius).
  ```
  for p in S3FS-Policy s3-ado-lea-rad-p AzureAD_SSOUserRole_Policy; do
    arn="arn:aws:iam::<account>:policy/$p"
    v=$(aws iam get-policy --policy-arn "$arn" --query 'Policy.DefaultVersionId' --output text)
    echo "=== $p"; aws iam get-policy-version --policy-arn "$arn" --version-id "$v" --query 'PolicyVersion.Document'
  done
  ```
  Also check AWS-managed grants, which `--scope Local` does not list: `aws iam list-entities-for-policy --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess`.
- [ ] **Check what is actually inside the two public buckets.** Public is fine for website assets; the risk is a database dump, backup or `.env` that got uploaded alongside them.
  ```
  aws s3api list-objects-v2 --bucket labor.media \
    --query "Contents[?contains(Key,'.sql')||contains(Key,'.zip')||contains(Key,'.env')||contains(Key,'backup')||contains(Key,'.bak')].Key"
  ```
  Repeat for `s3-ado-lea-rad-p`.
- [ ] **Enable IAM Access Analyzer** (free). The only tool that evaluates policy, ACL and BPA together and catches cross-account grants, which are external exposure without ever showing `IsPublic=true`. `aws accessanalyzer list-analyzers --type ACCOUNT` returns nothing today.
- [ ] **Consider AWS Config drift rules** — `s3-bucket-public-read-prohibited`, `s3-bucket-public-write-prohibited`, `s3-bucket-level-public-access-prohibited`, routed to the cluster `AlertTopic`. Since account-level BPA cannot be enabled while the two website buckets exist, detection is the substitute for prevention.
- [ ] **Presigned URLs are undetectable retroactively** — no check above would reveal one. Only CloudTrail data events record their use, and data events are not enabled.

### Hardening on `alb-logs-bucket/index.template` (both regions deployed)

- [ ] **Add a TLS-only deny.** BPA blocks public access but not an authenticated caller using plain HTTP. `"Effect": "Deny"`, `"Principal": "*"`, `"Action": "s3:*"`, condition `{"Bool": {"aws:SecureTransport": "false"}}`. `"Principal": "*"` in a *Deny* is safe — it is the `Allow` + `*` combination that makes a bucket public.
- [ ] **Declare `OwnershipControls: BucketOwnerEnforced` explicitly.** Live state is already correct, but only because it is the current S3 default — the template does not ask for it.
- [ ] **Add an `aws:SourceAccount` condition** to the log-delivery statement. The resource path already pins our account id so the practical risk is low, but AWS's documented policy for this service principal includes a source condition as a confused-deputy guard.

## Cluster dashboard — template-version widget and general build-out (2026-08-20)

`ClusterDashboard` (`${AWS::StackName}-Overview`, in the cluster template since `4ccba95`) currently holds metric widgets only: ECS CPU and memory per service via `SEARCH()`, RDS CPU and connections, rejected VPC connections. ~2 KB of dashboard body. Everything below is additive.

### Template-version widget (the motivating item)

Replaces the hand-maintained version table in the "finish the rollout" item above, which has drifted twice.

- [ ] **Add a `custom` widget backed by a small Lambda.** CloudWatch dashboards support a `custom` widget type whose Lambda returns HTML; the Lambda calls `cloudformation:DescribeStacks` and renders a stack → `TemplateVersion` table. Live on every dashboard load, no metrics involved.
  - Query **both regions** from the one Lambda. CloudWatch dashboards are per-region, so a Paris-only view would only ever tell half the story; an aggregating Lambda avoids needing two dashboards or cross-region widgets.
  - Flag rather than merely list: mark any stack whose version is not the current target, and show `None` explicitly for stacks predating the version stamp. A table that only lists versions still needs a human to spot the gap.
  - IAM: the Lambda needs `cloudformation:DescribeStacks` in both regions. **Viewers need `lambda:InvokeFunction` on it** — custom widgets are invoked with the *viewer's* credentials, so the SSO role has to permit it or the widget renders an error for everyone but the deployer.
  - Cost: one Lambda invocation per dashboard view. Negligible, but not zero, and it fires on every page load.
- [ ] **Decide where the Lambda and the dashboard live.** The dashboard is in the cluster template today, and a widget Lambda is the sort of thing that gets iterated on — which is exactly the argument that put `alb-waf` and `guardduty` in their own stacks, since **every** cluster deploy resolves `{{resolve:ssm:…image_id}}` afresh and produces the four-row AMI cascade. Options: leave both in the cluster stack and accept a cascade per iteration; or move `ClusterDashboard` plus the Lambda into a separate observability stack importing what it needs. The second is more consistent with how this repo already splits frequently-changed resources, at the cost of deleting and recreating the existing dashboard once. Not decided.

### General dashboard build-out

Ordered by how much each would have helped during this session's investigations.

- [ ] **An `alarm` widget listing every cluster alarm in one place.** There are 18 alarms across the cluster, service, WAF and additional-cluster stacks, and no single view of them. Cheapest useful addition on this list — an `alarm` widget takes a list of alarm ARNs and needs no metric maths.
- [ ] **HTTP status widget: `HTTPCode_Target_2XX/4XX/5XX_Count` and `HTTPCode_ELB_5XX_Count`.** **Use `Sum`, never `Average`.** The ALB emits one datapoint of value `1` per response, so `Average` renders a dead-flat line at exactly 1.0 and looks like a broken graph — this cost real time on 2026-08-19. Target-side and ELB-side are mutually exclusive counts, so graph both: one means the container erred, the other that it was never reached.
- [ ] **`RequestCount` with an anomaly band.** This is the blind spot identified 2026-08-19: if traffic is swallowed upstream (CloudFront, Global Accelerator, DNS, a WAF misconfiguration) then 4xx and 5xx are both zero, CPU is low, health checks pass, and every alarm reads green while the site is unreachable. A band on `RequestCount` is the only thing that shows it, and the graph is worth having even before the alarm exists.
- [ ] **`TargetResponseTime`** (p90/p99, not average) — the natural companion to the 5xx widgets when the question is "slow or broken".
- [ ] **WAF widget:** `CountedRequests` and `BlockedRequests` per `Rule` (WebACL dimension `${AWS::StackName}-waf`). The WAF lives in the cluster template and is already deployed in Paris, so this data exists now. The count-mode phase produces exactly the data that decides which rule groups can be promoted, and reading it off a dashboard beats a `get-metric-statistics` call per rule name.
- [ ] **Graph the 4xx anomaly band itself** with `ANOMALY_DETECTION_BAND(m1, 3)` in a metric widget, so the band can be judged visually against real traffic before `EnableHttp4xxAnomalyAlarm` is flipped on per service — which is precisely what the `gwa-gut-web-p` band evaluation item needs.

### Practical notes

- The dashboard body is JSON embedded in a string inside the template. It is awkward to edit and easy to break silently — a malformed widget renders as an error box rather than failing the deploy. Add widgets one at a time and look at the result.
- Dashboards are per-region. Anything meant to cover both clusters either needs cross-region widgets, a duplicate dashboard per region, or an aggregating Lambda as above.
- Nothing here is security-relevant or blocking; it is all about shortening the next investigation.

## EFS root-mount exposure — not implemented, decision pending (2026-08-19)

Context: the ASG `Launchtemplate` UserData used to mount the **EFS root** at `/mnt/efs` on every cluster instance via `/etc/fstab`. Removed 2026-08-19 so a compromised host does not find a standing mount holding every service's data. Nothing below is in any template — this is the follow-up analysis, recorded so the reasoning is not re-derived.

**Residual risk.** Removing the fstab entry is a speed bump, not a boundary. An attacker with host access can still run `mount -t efs -o tls <fs-id>:/ /mnt/efs`: `amazon-efs-utils` ships in the ECS-optimized AMI, and the instance ENI carries `SgVpcEfsAccess`, which `SgVpcEfs` permits on 2049 at both mount targets. Precondition is host access, i.e. a container breakout — containers themselves never see `/mnt/efs`; they are confined to `RootDirectory: /<StackName>` by the task definition.

**Why the security group cannot be the gate.** Tasks run `NetworkMode: bridge`, so they have no ENI of their own — the ECS agent mounts EFS over the *host* ENI. The SG rule that lets the agent mount `/gwa-gut-web-p` is bit-for-bit the rule an attacker uses to mount `/`. Removing it stops every service. There is no network-layer distinction to exploit.

**Why a partial IAM policy cannot be the gate either.** IAM has no condition key for the mounted path — `fs:/sub` vs `fs:/` is an NFS-level distinction EFS never sees as an API call. The only path-aware construct is an EFS access point. And the moment a `FileSystemPolicy` exists at all, EFS switches to default-deny; today's mounts are anonymous (no `AuthorizationConfig`, no `Iam: ENABLED`), so any policy breaks every service until they are migrated. All-or-nothing.

### Option A — detect (cheap, no task definitions touched)

- [ ] **Enable GuardDuty Runtime Monitoring** on `ecscluster-vpc-rds-asg/guardduty`. The detector currently runs with `Features` unset, so runtime coverage is off. It covers ECS-on-EC2 and flags the *precondition* — container escape, suspicious process execution, unexpected host mounts — rather than the mount itself. One parameter, one stack per region, no service rollout.
  - Findings routing already has a home: point the GuardDuty findings rule at the cluster `AlertTopic` (see the note in the alarm section — do this **before** continuing the service rollout, or 21 stacks get updated twice).
  - **Check pricing first.** Unlike the base detector, Runtime Monitoring bills per vCPU-hour for the agent. Modest on a small `t3.small` fleet, but confirm on the GuardDuty Usage page before enabling fleet-wide.

### Option B — prevent (bundle with the rollout that is already owed)

Enforcement is only possible via per-service EFS access points plus `Iam: ENABLED`, so the mount authenticates as the **task role** rather than anonymously. A stolen task credential then yields one service's access point, never the root. Splits into two independently safe phases:

- [ ] **Phase 1 (per service, nothing enforced yet, reversible per stack).** Add an `AWS::EFS::AccessPoint` per service to `ecsservice/index.template` and switch the volume to `AuthorizationConfig: { AccessPointId, Iam: ENABLED }`. `RootDirectory` must move out of the volume config and into the access point (an access point requires the volume's root to be omitted or `/`). Grant the task role `elasticfilesystem:ClientMount`/`ClientWrite` — **not** `ClientRootAccess` — conditioned on `elasticfilesystem:AccessPointArn`.
  - **Create the access points without `PosixUser`.** Forcing a POSIX identity is what breaks readability of existing files, which were written by whatever UID each image runs as (TYPO3, Matomo and the PHP images differ). Without it you still get path confinement and the IAM gate. Decide on POSIX enforcement separately, per service, later.
  - A half-migrated fleet is safe because nothing is enforced until Phase 2.
- [ ] **Phase 2 (one flip, cluster stack).** Add the `FileSystemPolicy` to `Efs` once **every** service is migrated. This is the moment `mount -t efs -o tls <fs-id>:/` starts returning access denied. Verify the migration is complete first — an unmigrated service loses its volume the instant this lands.
- [ ] **Keep the restore path working.** AWS Backup always restores into `aws-backup-restore_<timestamp>/` at the filesystem **root**, which Phase 2 makes unmountable by default. Add a narrowly scoped admin role with `ClientRootAccess` to the file system policy, assumed deliberately for a restore, and update the README EFS-Restore runbook. Arguably an improvement: root access becomes an auditable assumed-role action instead of a standing mount.

**Cost reality check.** Phase 1 is one extra resource in one template. 14 Paris stacks are on `1.0.0` and 19 Frankfurt on `None`, and the four template changes of 2026-08-19 are not rolled out either — so the fleet update is owed regardless and Phase 1 rides along with it.

**Doing nothing further is defensible.** The standing mount is already gone; what remains needs a container breakout, a compromise in which EFS data is one of several things lost. Detection (Option A) is the better marginal spend; Option B is worth it only if the fleet rollout happens anyway.

---

## EFS access and data transfer — session notes 2026-08-18

Context for work in progress, so it survives if the working session is lost.

### The problem

Downloading data off the cluster EFS was painfully slow. Root cause: everything went through an SSM Session Manager tunnel, which is a **control channel** — a single framed WebSocket relayed via the SSM service, no parallelism, no multipart. There is no throughput setting to tune; it performs like a serial console. `scp`/`rsync` over an SSM `ProxyCommand` fix the ergonomics but ride the same stream.

### EFS facts measured 2026-08-16/18

Both Frankfurt file systems: `ThroughputMode: bursting`, `PerformanceMode: generalPurpose`, ~**73 GiB** each (`fs-03238bbb2aabd19a4` 73.1 GiB, `fs-030d8ad5d3cf5e7b5` 73.9 GiB — **which one belongs to `labc-eu-c1` is still unconfirmed**, check `aws efs describe-tags`).

| | Read | Write |
|---|---|---|
| Baseline (continuous) | ~10.7 MiBps | ~3.6 MiBps |
| Burst (credits available) | 300 MiBps | 100 MiBps |

Reading the whole 73 GiB at burst is ~4 minutes of EFS time and consumes only ~1% of a full credit balance (reads meter at one-third; credit cap is 2.1 TiB). **EFS is therefore not the bottleneck** — the transport was, by two orders of magnitude. Once the transport is fixed the limit becomes the office uplink: 73 GiB is ~1h45m at 100 Mbit/s, ~42 min at 250.

Two further details that explain slowness with many small files: every NFS request is metered as **at least 4 KB** of throughput (so a tree of 1 KB files burns ~4× its real size, and drains burst credits that much faster), and read latency is ~1 ms per operation, so serial copies spend most of their time in round trips. Concurrency and `tar`-style streaming are what fix that, not bandwidth.

### Approach chosen: `ecscluster-vpc-rds-asg/efs-access` (written 2026-08-18, **not yet deployed or tested**)

A throwaway stack: EC2 instance in a public subnet with a public IP, EFS mounted at `/mnt/efs`, SSH/SFTP open to one operator CIDR. Deploy, transfer with FileZilla (resume and parallel transfers both work), delete. **No copy of the data lands anywhere outside EFS**, which is the deciding property.

- Parameters: `ClusterStackName`, `AllowedCidr` (regex-limited to /24–/32), `KeypairName`, `EfsSubPath` (default `/`, scope to one service where possible), `PosixUid`/`PosixGid` (default 0), `InstanceType` (default `t3.medium`), `AutoStopAfterHours` (default 8).
- An `AWS::EFS::AccessPoint` enforces `PosixUid`/`PosixGid` for every request through the mount. **This is the part that makes the data readable at all** — without it, `ec2-user` gets permission denied on files owned by the container user.
- Instance stops itself via `shutdown -h` (`InstanceInitiatedShutdownBehavior: stop`) so a forgotten stack stops billing compute; the stack still needs deleting by hand.

**Prerequisite, written but currently patched out of the template.** `efs-access` cannot attach EFS access without the `${AWS::StackName}-SgVpcEfsAccess` export (it was among the exports dropped in the June refactor). The output was removed again on 2026-08-18 so the SNS-only cluster `1.1.0` could deploy on its own, and lives as `ecscluster-vpc-rds-asg/efs-access/SgVpcEfsAccess-export.patch` — **re-apply it with `git apply` and stamp `TemplateVersion` `1.2.0` before deploying `efs-access`, or the mount silently has no security group.**

- [ ] **Re-apply the export patch, stamp `1.2.0`, then deploy the cluster to both regions** so the `SgVpcEfsAccess` export exists. Expect the usual four-row AMI cascade plus one output change. Independent of the `1.1.0` SNS deploy — either order works.
- [ ] **First deploy of `efs-access` — verify these, all untested:** the `accesspoint=fsap-…` fstab option mounts cleanly; the AL2023 SSM AMI alias `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` resolves; `shutdown -h +$(( … ))` arithmetic works (CloudFormation cannot multiply, so it is done in bash); and the Access Point's `RootDirectory` **must already exist** — no `CreationInfo` is set, so a non-existent `EfsSubPath` will fail the mount rather than create the directory.
- [ ] Add `TemplateVersion` to the new template's entry in the versioning task above (it ships with `1.0.0`).
- [ ] Confirm which file system belongs to which cluster before exposing one.

### Alternatives considered and why they lost

- **S3 as intermediary** (`tar | zstd | aws s3 cp -`, presigned PUT, tuned multipart) — fast and needs no new infrastructure, but creates a **second copy of personal data** in a location with its own access surface and retention. That is a DSGVO data-minimisation problem and appears in processing records. Rejected for routine use. If ever needed: SSE-KMS with a CMK, block-public-access, 1-day lifecycle expiry.
- **AWS DataSync** — same second-copy objection, plus per-GB cost. Right tool only if EFS→S3 becomes a recurring pipeline.
- **AWS Transfer Family with EFS backing** — genuinely good: managed SFTP straight onto EFS, no copy at rest, FileZilla-native. Needs `EndpointType: VPC` + *Internet Facing* + Elastic IPs, because that is the only combination supporting **security groups for source-IP filtering** (a `PUBLIC` endpoint cannot have them), and it must sit in a public subnet. Also needs a matching `PosixProfile`. Deferred as overkill for occasional use — revisit if this becomes self-service for several people.
- **VPN + direct NFS mount** — no transfer step at all and macOS can mount NFSv4.1, but `cp` has no resume, which matters at 73 GiB, and it is the largest setup. Right answer if the whole team needs standing access.
- **EC2 Instance Connect Endpoint** — no public IP, no cost, TCP tunnels into private subnets. Not pursued because it is also a managed relay and **its throughput advantage over Session Manager is unverified**.

### Separate finding: no EFS lifecycle policy

The `Efs` resource sets only `Encrypted`, `FileSystemTags` and `PerformanceMode`. With no `LifecyclePolicies`, all ~73 GiB per file system stays in EFS Standard indefinitely — four file systems across two regions. Standard is roughly an order of magnitude more expensive per GiB than Infrequent Access, making this the largest storage cost lever in the stack.

```json
"LifecyclePolicies": [
  { "TransitionToIA": "AFTER_30_DAYS" },
  { "TransitionToPrimaryStorageClass": "AFTER_1_ACCESS" }
]
```

- [ ] Check access patterns before enabling. IA first-byte latency rises to tens of milliseconds and IA reads carry a per-GB retrieval charge — fine for old uploads and archived assets, counterproductive if an application walks the whole tree on a cron. `TransitionToPrimaryStorageClass: AFTER_1_ACCESS` limits the damage. Verify current per-GiB rates for the regions before quoting a saving.
