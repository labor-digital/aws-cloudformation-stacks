# Open tasks

Background, rationale and operational procedures live in [README.md](README.md) (per-template Best Practices) and [CHANGELOG.md](CHANGELOG.md). This file is the to-do list only.

## Cluster deployment timeline

Open/in-flight changes per cluster. Rows completed in both regions get removed.

| Change | Paris (labc-eu-w3) | Frankfurt (labc-eu-c1) |
|---|---|---|
| `EnableEgressAnalysis` | ⏳ **switch off** — ran 29 days vs. intended 14, analysis complete | ⏳ enabled 2026-08-14 — run the analysis, then **switch off by 2026-08-28** |
| LII26-96 Phase 2 — whitelist analysis + deploy | ⚠️ overdue — unblocked since 2026-07-16 | ⏳ unblocked since 2026-07-17 |
| `ecsservice` rollout to `1.2.0` | ⏳ 1 of 15 done — `ado-ede-new-s` (staging cluster) | ⏳ 1 of 21 done — `gwa-gut-web-p`; `ado-lea-tut-p` on `1.0.1`, 19 on `None` |
| Service RAM resizes | ✅ 2026-07-09 | ⏳ `gwa-gut-sol-p` (77%). `labs-tin-fro-app-p` (106%) is on `labcluster-eu-c1-cl`, tracked separately |
| GuardDuty projected monthly cost from Usage page | 🗓 open | 🗓 open |
| DNS ALERT data-flow sanity check (`DnsFireWallLogsSummary`, last 24h) | ⏳ optional | ⏳ optional |

---

## Templates

- [ ] **`ecsservice` — finish the rollout, now targeting `1.3.0`.** `1.2.0` adds the ALB-native HTTP alarms (`AlarmHttp5xxTarget`, plus `AlarmHttp4xxTarget` + `BaselineHttp4xxTarget` which ship disabled; `AlarmHttp5xxElb` shipped in `1.2.0` and was deliberately removed again — load-balancer-side 5xx is not a case we need alarmed for now; stacks already on `1.2.0` lose it on their next update), so each remaining stack is updated once for both feature sets. **`1.3.0` (2026-08-19) then removed `AlarmHttp5xxElb` and log anomaly detection and renamed the 4xx pair** — the two stacks already on `1.2.0` need a further pass, and the cluster stack moved to `1.2.0` at the same time (EFS root mount dropped from the launch template; needs an instance refresh to take effect on running instances). `ado-ede-new-s` piloted `1.1.0` and has already made its second pass to `1.2.0`. **Inventory rebuilt from live state 2026-08-19** (`describe-stacks`, both regions), replacing a hand-maintained tally that had drifted twice.

| Region | Services | State |
|---|---|---|
| Paris `labc-eu-w3` — **all `-s`, staging** | 15 | `ado-ede-new-s` on `1.2.0`; the other 14 on `1.0.0` |
| Frankfurt `labc-eu-c1` — **all `-p`, production** | 21 | `gwa-gut-web-p` on `1.2.0`; `ado-lea-tut-p` on `1.0.1`; 19 on `None` (pre-versioning) |

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
  - [x] **Template written 2026-08-19, cfn-lint clean, not deployed.** `ecscluster-vpc-rds-asg/alb-waf`, importing `${ClusterStackName}-LoadbalancerArn` and associating a `REGIONAL` WebACL with the ALB. Separate stack, following the `alb-logs-bucket` / `guardduty` precedent, so it can be iterated without touching the 71 KB cluster template or triggering the AMI cascade. Works in `eu-west-3`/`eu-central-1` with no `us-east-1` deployment and no CloudFront. One WebACL per cluster covers every service behind that ALB (21 Frankfurt, 15 Paris).
    - Rule groups: `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, `AWSManagedRulesSQLiRuleSet`, `AWSManagedRulesWordPressRuleSet`, `AWSManagedRulesPHPRuleSet`, `AWSManagedRulesAmazonIpReputationList`, plus a rate-based rule. The SQLi and WordPress groups are the ones that address injection chains of the kind above; none of them are in the existing `cloudfront-alb-distribution` WebACL.
    - Custom rules worth adding: block `rest_route=/batch/v1` and `/wp-json/batch/v1`; block unauthenticated `POST` to `/wp-json/wp/v2/users`; restrict `/wp-admin/*` and `/typo3/*` to office IPs.
    - **Deploy with `OverrideAction: Count` first.** Block-mode managed rules in front of production TYPO3, Matomo and Solr will produce false positives, and a WAF that breaks a client site gets switched off wholesale. Count for a week, read the per-rule metrics, then flip the clean groups to block — the same evidence-before-enforcement discipline as the DNS Firewall ALERT→BLOCK phases.
    - Enable **WAF logging** and alarm on a blocked-request surge via the cluster `AlertTopic`, so the WebACL is observable rather than a black box.
    - Costs a WebACL fee plus a per-rule-group fee per region, plus per-million-requests; verify current rates. AWS Managed Rules carry no extra charge except Bot Control / ATP / Fraud Control, which are not proposed here.
  - [ ] **Deploy Frankfurt first, in count mode.** Under 51 KB, so no S3 upload:
    ```
    aws cloudformation deploy --region eu-central-1 --stack-name labc-eu-c1-waf \
      --template-file ecscluster-vpc-rds-asg/alb-waf/index.template \
      --parameter-overrides ClusterStackName=labc-eu-c1
    ```
    Every rule defaults to `count`, so no action override is needed on first deploy and nothing is blocked.
    Then Paris as `labc-eu-w3-waf` with `ClusterStackName=labc-eu-w3`. Production is the one that matters here, but Paris is the cheaper place to discover a false positive.
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
    - **Promote with confidence:** `IpReputationAction` (third-party IP intelligence; only exposure is a shared NAT address being listed) and `KnownBadInputsAction` (narrow, exploit-payload specific).
    - **Let the counts decide:** `SqliRuleSetAction` (can trip on content or search queries containing SQL-like strings), `WordPressRulesAction` (check it does not catch Matomo tracking POSTs), `RateLimitAction` (depends on whether a client sits behind a large corporate NAT).
    - **`WpCustomRulesAction` needs a test before promotion.** The `POST /wp/v2/users` half is safe, but `/batch/v1` is a **core REST route the WordPress block editor uses when saving** — blocking it can break the admin editor. Keep it counting and try editing a post before enforcing.
    - **`CommonRuleSetAction` last, and expect exclusions rather than merely a delay.** Watch these named rules in the count data — each has a specific, predictable cause:
      - `SizeRestrictions_BODY` — bodies over 8 KB, i.e. **every file upload** in the TYPO3 or WordPress backend. Fix with a `RuleActionOverride`, or raise the body inspection limit via `AssociationConfig` (which costs more).
      - `GenericRFI_BODY` — matches `://` in body parameters; editors pasting URLs into content trip it.
      - `CrossSiteScripting_BODY` — rich-text editors submit HTML by design.
      - `NoUserAgent_HEADER` — API clients and cron callers that send no user agent.
      Adding the groups in `count` carries no traffic risk at all; the risk is entirely in promotion, and it is concentrated here.
    - **`AdminRestrictionAction` is not a false-positive question, it blocks everything outside the listed CIDRs by definition.** **Decided 2026-08-19: clients edit their own content, so `AdminRestrictionAction` stays `off`.** A CIDR allowlist would lock out editors at `gwa`, `tro`, `ado`, `mei` and `aut`, and maintaining one list per client is not realistic. Admin paths therefore need protection that does not depend on source IP — a rate-based rule scoped to `/wp-login.php` and `/typo3/index.php` is the cheapest next step, and worth adding to the template as its own rule rather than relying on the global rate limit.
  - [ ] **Managed rule group versions are not pinned — decide deliberately.** `ManagedRuleGroupStatement` has an optional `Version`; the template omits it, so every group tracks AWS's default version and new signatures arrive automatically. That is most of the value (a new CVE signature lands in Known Bad Inputs without anyone acting) and also the risk (a new version can introduce a false positive on a Saturday). The alternative is pinning versions and updating on purpose, which trades that risk for the work of tracking releases. Unpinned is the right default here given the team size; record it as a choice rather than an oversight.

  - [ ] **Set `BlockedRequestAlarmThreshold` only after switching to block.** In count mode nothing is blocked, so the alarm would sit permanently silent and look like coverage.

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
