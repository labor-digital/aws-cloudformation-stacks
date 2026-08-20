# CHANGELOG

## Summary

> **Version-numbering caveat.** `ecsservice` `1.1.0` has no committed state of its own — `0056cd0`
> bundled the `1.1.0` alarm-actions work with the `1.2.0` HTTP alarms and stamped `1.2.0`. Every other
> version below is a real committed state. Note also that `1.3.0` covers two `ecsservice` states,
> before and after `8c76965` added `ListenerArnOverride` without a bump.

**`2447c43` · 2026-08-20 — `TemplateVersion` output on the `guardduty` and `alb-logs-bucket` templates**
- Both stamped `1.0.0`. Four templates now carry the output; `backup-vaults-mirror` and the leaf templates still do not — see TASKS.md.

**`8c76965` · 2026-08-20 — internal ALB for VPC-only services (cluster `1.3.0`), `ListenerArnOverride` in `ecsservice`**
- **Cluster `1.2.0` → `1.3.0`:** `InternalLoadbalancer` (`Scheme: internal`, both private subnets), `SgInternalAlb` (tcp/80 from `SgVpcLoadbalancerports`), `InternalHttplistener` (HTTP:80, `fixed-response` 404 default). New exports `${AWS::StackName}-InternalListenerArnHttp` and `-InternalAlbDns`. No TLS — the first consumer (Solr) speaks HTTP, so terminating inside the VPC adds nothing.
- **`ecsservice`, no version bump (stays `1.3.0`):** new `ListenerArnOverride` parameter (String, default `""`) plus the `HasListenerOverride` / `NoListenerOverride` conditions. `LoadbalancerRule.ListenerArn` becomes an `Fn::If`, and `LoadbalancerRuleHttp` gains `"Condition": "NoListenerOverride"` — the 80→443 redirect must not exist on an HTTP-only internal listener. Default empty renders the other 35 stacks byte-identically, so the pending `1.3.0` rollout picks this up at no risk.
- Deployed to Paris 2026-08-20 and verified live (`Scheme: internal`, `state: active`, subnets `SubnetPrivate1`/`SubnetPrivate2`). Frankfurt pending.

**`a675e7d` · 2026-08-20 — WAF rule set trimmed and per-rule promotion made expressible (cluster stays `1.2.0`)**
- Rule set cut from eleven rules to six on the principle that a rule must be generic to be worth its WCU: `AWSManagedRulesCommonRuleSet`, `KnownBadInputsRuleSet`, `SQLiRuleSet`, `WordPressRuleSet` plus two rate rules. Removed `PHPRuleSet`, `AmazonIpReputationList`, `BlockWpBatchRoute`, `BlockWpUserCreation` and `RestrictAdminPaths` — reasons and re-evaluation criteria in TASKS.md.
- The eight per-rule action parameters introduced in `846c0be` are cut to five — `CommonRuleSetAction`, `KnownBadInputsAction`, `SqliRuleSetAction`, `WordPressRulesAction`, `RateLimitAction` — as `IpReputationAction`, `WpCustomRulesAction` and `AdminRestrictionAction` lost their rules. `WafAdminAllowedCidrs` is gone with them.
- **`WafClientIpHeader` is new here**, and with it the split rate rules: `RateLimitForwardedIp` (priority 90) keys on the header for requests that carry it, `RateLimitSourceIp` (91) on the source IP for those that do not, each scope-down-ed so they never double-count. `RateLimitAction=block` is now refused unless the header parameter is set — proxied requests would otherwise aggregate onto Cloudflare's own addresses and blocking would take out every proxied site.
- Rule priorities drop from 23 to 8.
- Measured on the live Paris stack: **1202 WCU of the 1,500 default ceiling.** With the PHP and IP-reputation groups still present it was over 1,300. Read it with `aws wafv2 get-web-acl-for-resource --resource-arn <alb-arn> --query 'WebACL.Capacity'`.
- Also stamps `TemplateVersion` on the `guardduty` template.

**`846c0be` · 2026-08-19 — AWS WAF integrated into the cluster template (`1.2.0`)**
- `WafWebAcl` (`${AWS::StackName}-waf`, scope `REGIONAL`) associates directly with `Loadbalancer`, so no import is needed and one WebACL covers every service behind that ALB. `REGIONAL` works in `eu-west-3`/`eu-central-1` with no `us-east-1` deployment and no CloudFront — unlike the `CLOUDFRONT`-scope WebACL in `cloudfront-alb-distribution`.
- Merged into the cluster template by decision rather than kept as a separate `alb-waf` stack.
- **Per-rule promotion made expressible:** the single global `RuleAction` is replaced by eight `off`/`count`/`block` parameters (`IpReputationAction`, `CommonRuleSetAction`, `KnownBadInputsAction`, `SqliRuleSetAction`, `WordPressRulesAction`, `WpCustomRulesAction`, `AdminRestrictionAction`, `RateLimitAction`), all defaulting to `count`; `off` omits the rule entirely. Eleven rules, 23 priorities — trimmed the next day in `a675e7d`.
- Every rule ships as `count`; nothing is blocked until a parameter is flipped. WAF logging plus a `WafBlockedRequestAlarmThreshold`-gated alarm on the cluster `AlertTopic` make the WebACL observable rather than a black box — at threshold `0` the alarm resource is not created at all.
- **The template crossed 51,200 bytes here** (104 KB), so every cluster deploy now needs an S3 upload or the console; `--template-body` no longer works.
- Note cluster `1.2.0` spans three commits without an intermediate bump: `8f1826d` (EFS host mount removed), this one (WAF added) and `a675e7d` (WAF trimmed). A stack reporting `1.2.0` could be any of the three — check whether `WafWebAcl` exists and how many rules it carries.

**`8f1826d` · 2026-08-19 — alarm cleanup, 4xx rename, EFS host mount removed (`ecsservice` `1.3.0`, cluster `1.2.0`)**
- `AlarmHttp5xxElb` removed together with `ServiceHttp5xxElbThreshold` and `EnableHttp5xxElbAlarm` — load-balancer-side 5xx is not a case we need alarmed at the moment
- Log anomaly detection removed entirely: `LogAnomalyDetector`, `ServiceLogAnomalyAlarm`, `EnableLogAnomalyDetection`, `EnableAnomalyDetector`. Unusable against our log format — Apache access lines collapse into a single pattern. Added three days earlier in `3e5ad18`; deployed stacks lose the detector on their next update
- 4xx pair renamed for legibility: `Http4xxAnomalyDetector` → `BaselineHttp4xxTarget`, `AlarmHttp4xxAnomaly` → `AlarmHttp4xxTarget`; `AlarmName` becomes `${AWS::StackName}-AlarmHttp4xxTargetAnomaly`. Both resources are replaced on the next update
- `AlarmHttp4xxTarget` gained `DependsOn: [ "BaselineHttp4xxTarget" ]` — without it, deleting the pair can fail because `DeleteAnomalyDetector` is rejected while an alarm still references the metric
- **Cluster:** the ASG launch template no longer mounts the EFS **root** at `/mnt/efs` via `/etc/fstab`. Services are unaffected (they mount through the task definition); the EFS-Restore runbook now mounts by hand. Takes effect on running instances only after an instance refresh

**`0056cd0` · 2026-08-19 — SNS alert path and ALB-native HTTP alarms (cluster `1.1.0`, `ecsservice` `1.2.0`)**
- Filed under a TASKS-sounding subject, but this is the notification work: **cluster `1.0.0` → `1.1.0`** adds `AlertTopic` (`${AWS::StackName}-alerts`), the optional `AlertEmail` parameter, a topic policy for `cloudwatch.amazonaws.com` + `events.amazonaws.com`, the `${AWS::StackName}-AlertTopicArn` export, and `AlarmActions` on all four cluster alarms.
- **`ecsservice` `1.0.1` → `1.2.0`** in one step, bundling what the rollout plan called `1.1.0` and `1.2.0`: `AlarmActions` on `ServiceHigh{Cpu,Memory}Alarm` and `ServiceLow{Cpu,Memory}Alarm` importing `${ClusterStackName}-AlertTopicArn`, plus the ALB-native alarms `AlarmHttp5xxTarget` (`ServiceHttp5xxTargetThreshold`), `AlarmHttp5xxElb` (`ServiceHttp5xxElbThreshold`) and the `Http4xxAnomalyDetector` / `AlarmHttp4xxAnomaly` pair (`ServiceHttp4xxAnomalyBand`), the last two shipping disabled.
- **Deploy order matters:** the High alarms are on by default, so their `Fn::ImportValue` fails the service update if the cluster stack has not been deployed first.
- `AlarmActions` is deliberately **not** wired to `AlarmAutoscaleScaleDown` — it is red during every normal scale-in by design.
- `AlertTopic` is deliberately not KMS-encrypted: payloads carry metric names, thresholds and stack names only. If that changes, the key policy must also grant `kms:GenerateDataKey*`/`kms:Decrypt` to both service principals or delivery fails silently.
- Delivery verified end-to-end in both regions with `aws cloudwatch set-alarm-state`, which exercises the topic policy — `aws sns publish` does not.

**`3e5ad18` · 2026-08-16 — optional log anomaly detection in `ecsservice` (`1.0.1`)**
- `LogAnomalyDetector` + `ServiceLogAnomalyAlarm`, gated by `EnableLogAnomalyDetection` (defaulting to `true`). **Reverted three days later in `8f1826d`** — kept in this history because every stack deployed at `1.0.1` carries a live detector until its next update.

**`597e8c5` · 2026-08-14 — `TemplateVersion` output and egress analysis query fix (cluster `1.0.0`)**
- First `TemplateVersion` output on the cluster template. Stacks reporting `None` predate it — see README "Template-Versionierung"
- `VpcEgressPortsAnalysis` narrowed to the private subnets (`/^10\.1\.[34]\./`) with a `srcport != 443/80` backstop and `limit` raised to 500, fixing two defects in the saved query: it counted inbound replies, and NAT double-counted connections. **Not yet deployed to Paris**, whose 2026-08-07 analysis ran against the old query.

**`7adefc8` · 2026-07-10 — `ecsservice`: parameterised scaling thresholds, `SkipImageResolver` default, template versioning**
- Scale thresholds moved out of the alarms into parameters: `ServiceScaleUpCpuThreshold` (65), `ServiceScaleDownCpuThreshold` (15)
- `SkipImageResolver` default changed `false` → `true` — new services skip the ECS lookup during creation and while iterating on a failing first deployment; set it to `false` once the service runs. Mitigates the failed-first-create retry loop.
- New `TemplateVersion` stack output (`1.0.0`). Stacks showing `None` predate versioning — see README "Template-Versionierung"

**`c4564d7` · 2026-07-10 — `ecsservice`: state-aware scale-in alarm and operational alarms**
- `AlarmAutoscaleScaleDown` rewritten as a metric-math alarm — `IF(cpu < ${ServiceScaleDownCpuThreshold} AND tasks > ${ServiceDesiredCount}, 1, 0)`, `EvaluationPeriods: 5`, `TreatMissingData: notBreaching`. Replaces the CPU-only alarm that was permanently red at the <1–2% idle baseline. Task count comes from ALB `HealthyHostCount` (Container Insights is not enabled). See README "Service-Autoscaling".
- Step adjustment switched from `MetricIntervalUpperBound: 0` to `MetricIntervalLowerBound: 0` to match the inverted alarm polarity (now `GreaterThanThreshold 0` over a 0/1 expression)
- Four conditional operational alarms, each disabled by setting its threshold to `0`: HighCpu (20), HighMemory (80), LowCpu (0, opt-in), LowMemory (0, opt-in). Visibility only — no scaling actions, and no `AlarmActions` wired up yet.
- **New cross-stack import:** `${ClusterStackName}-LoadbalancerArn`. The cluster stack must export it (present since `40e2451`), otherwise the service stack update fails at import resolution.

**`219ce33` · 2026-07-10 — move the `guardduty` stack into `ecscluster-vpc-rds-asg/`**

**`3eb2d1f` · 2026-07-09 — add `guardduty` stack (detector, quarantine SG, incident-response role)**
- One stack per region, not per cluster — a GuardDuty detector is limited to one per account/region, and deleting a cluster stack must not disable threat detection region-wide. Rationale in README.
- Exports `DetectorId`, `QuarantineSgId`, `IncidentResponseRoleArn` for the Phase 3 Step D automation
- Deployed Paris 2026-07-09; FlowLogs/DNSLogs/CloudTrail data sources verified 2026-07-10. Frankfurt pending.

**`4ccba95` · 2026-06-24 — egress analysis resources and cluster dashboard**
- `EnableEgressAnalysis` parameter (default `false`) gates a temporary ACCEPT-mode VPC Flow Log with its own log group and role, plus the `VpcEgressPortsAnalysis` saved query. Temporary by design — ACCEPT flow logs bill per GB.
- `ClusterDashboard` (`${AWS::StackName}-Overview`): ECS CPU and memory per service via `SEARCH()`, RDS CPU + connections, rejected VPC connections

**`475a21a` · 2026-06-19 — metric filters, alarms and saved queries for VPC and RDS logs**
- RDS: `RdsErrorMetricFilter` + `RdsErrorAlarm` (any `[ERROR]` entry), `RdsSlowQueryMetricFilter` + `RdsSlowQueryAlarm` (>5 slow queries / 5 min), and the `RdsErrorLogSummary` / `RdsSlowQuerySummary` Insights queries
- VPC: `VpcFlowLogsRejectedMetricFilter` + `VpcFlowLogsRejectedAlarm` (>500 rejects / 5 min), `VpcFlowLogsRejectedTraffic` query

**`1457fe8` · 2026-06-18 — RDS logging and security hardening**
- `EnableCloudwatchLogsExports: ["error", "slowquery"]` on the Aurora cluster, plus `slow_query_log = 1` in the cluster parameter group (without the parameter the slowquery export stays empty)
- `RdsErrorLogGroup` / `RdsSlowQueryLogGroup` pre-created with 14-day retention — RDS otherwise creates them with never-expire
- Frankfurt (`labc-eu-c1`) verified live 2026-08-14 via `describe-db-clusters`: `error`, `slowquery`. Paris not re-verified — it leads the rollout, so presumed live.
- The slow-query threshold is the engine default `long_query_time = 10s`. Lowering it (e.g. `0` to trace every statement) also trips `RdsSlowQueryAlarm` — raise or disable that alarm for the duration of the trace.

**`7fabcf8` · 2026-06-18 — associate the DNS Firewall rule group with the ECS cluster VPC**

**`8cbc659` · 2026-06-09 — add Route 53 DNS Firewall in ALERT mode (LII26-94)**

| Resource | Type | Purpose |
|---|---|---|
| `DnsQueryLogGroup` | `AWS::Logs::LogGroup` | CloudWatch log group for DNS queries, 14-day retention |
| `DnsFirewallWhitelistDomainList` | `AWS::Route53Resolver::FirewallDomainList` | Empty allowlist — populated after Phase 2 analysis |
| `DnsFirewallCatchAllDomainList` | `AWS::Route53Resolver::FirewallDomainList` | Contains `*`, matches all unwhitelisted domains |
| `DnsFirewallRuleGroup` | `AWS::Route53Resolver::FirewallRuleGroup` | Rule 1 (priority 100): ALLOW whitelist / Rule 2 (priority 200): ALERT catch-all |
| `DnsFirewallRuleGroupAssociation` | `AWS::Route53Resolver::FirewallRuleGroupAssociation` | Attaches the rule group to the VPC |
| `DnsQueryLoggingConfig` | `AWS::Route53Resolver::ResolverQueryLoggingConfig` | Routes DNS queries to the log group |
| `DnsQueryLoggingConfigAssociation` | `AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation` | Associates logging config with the VPC |
| `DnsFirewallAlertMetricFilter` | `AWS::Logs::MetricFilter` | Counts `firewall_rule_action = ALERT` events |
| `DnsFirewallAlertAlarm` | `AWS::CloudWatch::Alarm` | Fires when ALERT events exceed 100/5min — adjust after baseline is established |

Outputs exported: `DnsFirewallWhitelistId`, `DnsFirewallRuleGroupId` — for automation to add domains to the whitelist.

**`8fee739` · 2026-06-05 — update log retention and enhance ALB/ECS configurations**
- [VPC Flow Logs `TrafficType` changed to `REJECT`](#vpc-flow-logs-added) — reduces volume ~95%, cost from ~$40-45/month to a few dollars
- VPC Flow Logs and ALB access logs retention set to 14 days (DSGVO)
- `alb-logs-bucket` — bucket name derived from `ClusterName` parameter (`<ClusterName>-alb-logs`); bucket policy fixed to allow any prefix (`*/AWSLogs/<account>/*`)
- `ecsservice` — `ImageResolverLogGroup` added with 14-day retention
- ALB access logs deployed and verified on `labc-eu-w3` — logs writing to `labc-eu-w3-alb-logs/labc-eu-w3/`

**`041da8d` · 2026-06-05 — switch VPC Flow Logs `TrafficType` to `REJECT`**

**`677019e` · 2026-06-05 — remove unused Network ACL, IPv6 cleanup, VPC Flow Logs, ALB hardening, dnf-automatic, optional ALB access logs**
- [NACL removed](#nacl-removed)
- [Dead IPv6 rules removed from security groups](#dead-ipv6-rules-removed-from-security-groups)
- [VPC Flow Logs added](#vpc-flow-logs-added)
- [ALB Deletion Protection enabled](#alb-deletion-protection-enabled)
- [`dnf-automatic` added to EC2 UserData](#dnf-automatic-added-to-ec2-userdata)
- [ALB Access Logs — optional via `LogsBucketName`](#alb-access-logs--optional-via-logsbucketname-parameter)

**`f299faa` · 2026-06-05 — export private subnets for cross-stack references**

**`1d66894` · 2026-06-04 — remove unused security groups and rename `SgPublicHttps` to `SgPublicHttpHttps`**

**`41c330f` · 2026-06-03 — remove unused Network ACL and associated resources**

**`197fd7b` · 2026-06-03 — remove IPv6 open access, enable VPC flow logs, enforce ALB deletion protection, add automated security updates**

**`c58bee4` · 2026-06-02 — add ImageResolver Lambda for ECS task image management, support SkipImageResolver, enable circuit breaker rollback**
- [`InitialDockerImage` stale image fix — Lambda custom resource](#initialdockerimage-stale-image-fix--lambda-custom-resource)

**`dfa216b` · 2026-05-15 — revert managed scaling target capacity**

**`e0eb57a` · 2026-05-13 — add ALB listener rules and target group export for advanced routing**

**`1a95fc9` · 2026-05-13 — increase scaling limits for ASG and ECS Managed Scaling**

**`e38149a` · 2026-05-13 — update `TaskMemory` parameter with adjusted defaults and allowed values**

**`003f01b` · 2026-05-10 — increase ASG max instance limit from 10 to 20**

**`f08ed3d` · 2026-05-06 — rename `ListenerRuleRedirectUrl` to `ListenerRuleRedirectHost`**

**`8df275c` · 2026-05-06 — enhance ALB redirect rule template with configurable path and query options**

**`40e2451` · 2026-04-28 — add Global Accelerator template and export ALB ARN**

**`0800e0a` · 2026-04-27 — add configurable WAF support to CloudFront-ALB distribution**

**`3e3d65b` · 2026-04-27 — add configurable CloudFront PriceClass parameter**

**`4b96ec6` · 2026-04-27 — remove custom CachePolicy, OriginRequestPolicy, and ResponseHeadersPolicy**

**`a6f766d` · 2026-04-27 — add CloudFront-ALB distribution template with WAF and security configurations**

**`7a243a9` · 2026-04-27 — add certificate template for SSL certificates with optional wildcard SAN**

**`a4822a0` · 2026-04-14 — add ALB additional certificate and redirect rule templates**

**`af8279b` · 2026-04-08 — streamline EFS mounting process in ECS cluster UserData**

**`2c366f0` · 2026-04-07 — enable ECS Managed Scaling and refine cluster configuration**

**`7f813e0` · 2026-04-07 — switch to SSM-based ECS-optimized AMI and remove redundant UserData commands**

**`c734438` · 2026-04-07 — add private subnets, NAT gateway, and update dependent resources**

**`0159d0a` · 2026-04-03 — fix log group and stream resource definitions in ecsservice**

**`ac2efe3` · 2026-04-03 — replace `nfs-utils` with `amazon-efs-utils` and improve EFS mounting**

**`032cee2` · 2026-04-03 — replace manual scaling with ECS Capacity Provider**

**`b1e41d0` · 2026-03-03 — add mirror backup vaults, update backup settings**

**`e147429` · 2026-01-22 — allow optional override of default docker cmd; add Solr port 8983**

**`af0e64e` · 2025-12-09 — add auto public IP to launch template**

**`22d61a5` · 2025-12-05 — fix ECS service restart in UserData of EC2 launch config**

**`9b5a60f` · 2025-11-19 — add RDS cluster to AWS Backup**

**`b7794a3` · 2025-11-19 — fix autoscaling hook Lambda and re-add EFS mount on ECS instances**

**`01307ed` · 2025-11-19 — add EFS volume mount and refine parameters**

**`d5310af` · 2025-11-19 — use export/import of cluster variables in service template**

**`2b07992` · 2025-11-19 — set EFS as encrypted**

**`a282c47` · 2025-11-18 — initial work on updating cluster and service templates**

---

## `ecscluster-vpc-rds-asg/alb-logs-bucket/index.template` — new template

### Shared ALB access logs bucket
New dedicated stack, deployed once per region. ALB access logs must be written to S3 (no CloudWatch option) — without the correct bucket policy, ALB silently fails to write with no error. The bucket is shared across cluster stacks, each writing under its own prefix (the stack name; `AWSLogs/<account-id>/...` is appended automatically by ALB).

- **Encryption:** SSE-S3 (AES256) — KMS is not supported for ALB log delivery
- **Versioning:** enabled — protects against accidental object deletion
- **Public access:** fully blocked on all four settings
- **Lifecycle:** objects deleted after 14 days (configurable via `RetentionDays`, default 14) — DSGVO storage limitation requires deletion, not archival; IP addresses in ALB logs are personal data under Art. 5(1)(e)
- **Lifecycle:** incomplete multipart uploads aborted after 7 days — silently abandoned uploads accumulate cost
- **Bucket policy:** `logdelivery.elasticloadbalancing.amazonaws.com` service principal (modern post-Aug 2022 approach), scoped to `AWSLogs/<account-id>/*`
- **`DeletionPolicy: Retain`** — bucket and logs survive stack deletion

---

## `ecscluster-vpc-rds-asg/index.template`

### Internal ALB for VPC-only services (`1.3.0`)

Three resources plus two exports, alongside the existing public `Loadbalancer` / `Httpdefaultlistener` / `Httpsdefaultlistener` / `Deftarget` set:

- **`InternalLoadbalancer`** — `Scheme: internal`, placed in `SubnetPrivate1` and `SubnetPrivate2`
- **`SgInternalAlb`** — ingress tcp/80 from `{Ref: SgVpcLoadbalancerports}`, which is precise rather than VPC-CIDR-wide and only possible because this lives in the same stack. `SecurityGroups` also carries `SgVpcLoadbalancerportsAccess`, so the internal ALB may already reach container dynamic ports 32768–61000 with no extra instance-side rule
- **`InternalHttplistener`** — `HTTP:80`, `DefaultActions` a `fixed-response` 404. No TLS: the first consumer speaks HTTP, so terminating inside the VPC would add nothing
- Exports `${AWS::StackName}-InternalListenerArnHttp` and `-InternalAlbDns`

**Why in the cluster template rather than its own stack.** It is cluster-level singleton infrastructure, the sibling of the resources listed above. The split-stack precedents (`guardduty`, `alb-logs-bucket`) exist for things that are optional per cluster and iterated often, which this is not — and a separate stack could not use `SgVpcLoadbalancerports` for its ingress rule without the cluster stack exporting it anyway.

**No DNS record.** Consumers use the exported hostname rather than a private hosted zone. Trade-off accepted: an ALB *replacement* (a `Name` or subnet change, not a plain update) changes the hostname, so a consumer holding it in configuration goes stale — rare, and the failure is loud. Services attach with `ListenerRuleHost=*`, which is fine on a listener serving only internal traffic.

**First consumer is Solr** (`gwa-gut-sol-s`, then `gwa-gut-sol-p`), which is consumed by `gwa-gut-web-p` on the same cluster in the same VPC — the public round-trip was a template artefact. Rollout steps and the two snags (listener-rule replacement, health checks moving to the internal ALB) are in TASKS.md.


### AWS WAF on the cluster ALB (`1.2.0`, trimmed in `a675e7d`)

`WafWebAcl` (`${AWS::StackName}-waf`, scope `REGIONAL`) associates directly with `Loadbalancer`, so no import is needed and one WebACL covers every service behind that ALB — 21 in Frankfurt, 15 in Paris. Scope `REGIONAL` works in `eu-west-3`/`eu-central-1` without any `us-east-1` deployment and without CloudFront, which is what the `CLOUDFRONT`-scope WebACL in `cloudfront-alb-distribution` cannot do.

**As built** (after the `a675e7d` trim): `AWSManagedRulesCommonRuleSet`, `KnownBadInputsRuleSet`, `SQLiRuleSet`, `WordPressRuleSet`, plus two general rate rules at 2,000 requests per IP per 5 minutes. **1202 WCU of the 1,500 default ceiling**, measured live. `CommonRuleSet` exclusions and scope-down statements consume WCU, so budget from the 298 headroom rather than from 1,500.

**Everything ships as `count`.** Five `off`/`count`/`block` parameters — `CommonRuleSetAction`, `KnownBadInputsAction`, `SqliRuleSetAction`, `WordPressRulesAction`, `RateLimitAction` — all default to `count`, so promotion is a parameter change on a normal stack update and never a template edit; `off` omits the rule entirely. Block-mode managed rules in front of production TYPO3, Matomo and Solr will produce false positives, and a WAF that breaks a client site gets switched off wholesale — the same evidence-before-enforcement discipline as the DNS Firewall ALERT→BLOCK phases.

**Two guards worth knowing.** `RateLimitAction=block` is refused unless `WafClientIpHeader` is set, because proxied requests would otherwise aggregate onto Cloudflare's own addresses. And `WafBlockedRequestAlarmThreshold` at `0` leaves the alarm resource uncreated, so the first real block would be invisible — set it in the same deploy as any promotion.

**Two consequences of it living here.** Each cluster update re-resolves the SSM AMI reference and so shows the four-row cascade (harmless — nothing is recreated, running instances untouched), and **at 104 KB the template exceeds the 51,200-byte inline limit**, so deploys go via S3 or the console.

AWS also enables `OnSourceDDoSProtectionConfig` on the WebACL by default (`ALBLowReputationMode: ACTIVE_UNDER_DDOS`, observed on the Paris deployment). This template does not configure it. It blocks low-reputation sources automatically *while a DDoS is detected*, which partially offsets dropping `AmazonIpReputationList` — but only under attack conditions, not for routine traffic.


### EFS root mount removed from the ASG launch template (`1.2.0`)

The `Launchtemplate` UserData used to create `/mnt/efs`, append an `/etc/fstab` entry for the **root** of the file system (`<Efs>:/ /mnt/efs efs _netdev,tls 0 0`) and `mount -a`. All seven lines are gone; UserData now only registers the instance with the ECS cluster and sets up `dnf-automatic`.

**Rationale:** a standing root mount put every service's data on every host, ready to read the moment anyone reached a shell. Containers never used it — `ecsservice` mounts EFS through the task definition (`EFSVolumeConfiguration` with `RootDirectory: /<StackName>`, `TransitEncryption: ENABLED`), which the ECS agent mounts itself; no template anywhere uses a `SourcePath` host bind mount. So removing it costs the services nothing.

**What it does and does not buy.** It removes a standing mount, not the capability: an attacker with host access can still run `mount -t efs -o tls <fs-id>:/ /mnt/efs`, because `amazon-efs-utils` ships in the ECS-optimized AMI and the instance ENI carries `SgVpcEfsAccess`, which `SgVpcEfs` permits on 2049. That SG rule cannot be removed — tasks run `NetworkMode: bridge`, so the agent mounts over the host ENI and the rule serving the services is the same one an attacker would use. Real enforcement would need EFS access points plus IAM authorization; see the "EFS root-mount exposure" section in `TASKS.md`.

**Operational impact.** Existing instances keep the mount until an instance refresh — a launch template change only affects newly launched instances. The EFS-Restore runbook in the README depended on this mount (AWS Backup always restores into `aws-backup-restore_<timestamp>/` at the file system root) and now mounts by hand and unmounts afterwards. The `efs-access` stack is **not** a substitute: its access point is confined to `EfsSubPath` and forces `PosixUid`/`PosixGid`.


### ALB Access Logs — optional via `LogsBucketName` parameter
Added optional `LogsBucketName` parameter (default empty string). When empty, behavior is identical to before — logging stays off. When set, the `AccessLogsEnabled` condition activates and the ALB is configured with `access_logs.s3.enabled = true`, the bucket name, and the stack name as prefix. The `AWS::NoValue` pattern is used to omit the bucket and prefix attributes entirely from the array when logging is disabled.

**To enable:** deploy `ecscluster-vpc-rds-asg/alb-logs-bucket/index.template` in `eu-west-3` first, then pass the resulting bucket name as `LogsBucketName` when creating or updating the cluster stack.

### NACL removed
Removed all five NACL resources (`Netacl`, `NetaclEntry1`, `NetaclEntry2`, `AssociateNetacl1`, `AssociateNetacl2`). Both entries allowed all traffic in both directions (`Protocol: -1`, `0.0.0.0/0`) — functionally identical to the AWS default NACL. Subnets automatically fall back to the default NACL on removal; no change in traffic behavior.

The alternative of making the NACL restrictive was rejected: NACLs are stateless, requiring explicit rules for ephemeral return traffic (ports 1024–65535), which is easy to misconfigure silently. Security groups already handle fine-grained access control at the instance level.

### Dead IPv6 rules removed from security groups
`SgPublicHttpHttps` and `SgPublicHttps` both had `::/0` ingress rules for ports 80 and 443. The ALB is configured as `IpAddressType: ipv4` — it never accepts IPv6 traffic, so those rules were dead weight. Removed two `::/0` rules from each security group; IPv4 `0.0.0.0/0` rules are untouched.

### VPC Flow Logs added
Three new stack-managed resources:
- **`VpcFlowLogGroup`** (`AWS::Logs::LogGroup`) — 14-day retention. IP addresses are personal data under DSGVO; retention period and legal basis (typically Art. 6(1)(f) legitimate interest) should be documented in the VVT. Note: log group and its data are lost on stack deletion — consider `DeletionPolicy: Retain` if continuity across stack recreations is needed.
- **`VpcFlowLogRole`** (`AWS::IAM::Role`) — scoped to write access on the specific log group only, assumed by `vpc-flow-logs.amazonaws.com`
- **`VpcFlowLog`** (`AWS::EC2::FlowLog`) — `TrafficType: REJECT`, delivers to CloudWatch. Only logs dropped traffic — accepted traffic is not recorded. `ALL` was considered but rejected due to cost: a small cluster generates ~87 GB/month uncompressed with `ALL`, costing ~$40-45/month in CloudWatch ingestion alone. `REJECT` reduces volume by ~95% and brings cost to a few dollars per month, while still covering the primary use case of detecting blocked traffic and security incidents.

### ALB Deletion Protection enabled
`deletion_protection.enabled` flipped from `false` to `true`. Prevents accidental stack deletion or manual ALB deletion — CloudFormation will error on delete until the flag is explicitly disabled first.

### `dnf-automatic` added to EC2 UserData
UserData now installs `dnf-automatic`, sets `upgrade_type = security` (security patches only — full updates are handled via planned AMI refresh, not unattended), and enables the timer at boot. Configured via two `sed` commands against `/etc/dnf/automatic.conf`.

Applying this change requires deploying the stack update (creates a new Launch Template version) and then replacing instances — either by terminating one (the ASG uses `LatestVersionNumber` and will boot the replacement with the new UserData) or via a full instance refresh.

**Verified on 2026-06-03:**
```bash
$ systemctl status dnf-automatic.timer
● dnf-automatic.timer - dnf-automatic timer
     Loaded: loaded (/usr/lib/systemd/system/dnf-automatic.timer; enabled; preset: disabled)
     Active: active (waiting) since Wed 2026-06-03 12:32:14 UTC; 2min 36s ago
    Trigger: Thu 2026-06-04 06:51:40 UTC; 18h left
   Triggers: ● dnf-automatic.service

$ grep -E 'upgrade_type|apply_updates' /etc/dnf/automatic.conf
upgrade_type = security
apply_updates = yes

$ sudo systemctl start dnf-automatic
$ journalctl -u dnf-automatic --no-pager
Jun 03 12:37:34 ip-<private-ip>.ec2.internal systemd[1]: Starting dnf-automatic.service - dnf automatic...
Jun 03 12:37:34 ip-<private-ip>.ec2.internal dnf-automatic[3178]: Last metadata expiration check: 0:05:23 ago on Wed Jun  3 12:32:11 2026.
Jun 03 12:37:34 ip-<private-ip>.ec2.internal systemd[1]: dnf-automatic.service: Deactivated successfully.
Jun 03 12:37:34 ip-<private-ip>.ec2.internal systemd[1]: Finished dnf-automatic.service - dnf automatic.
```

---

## `ecsservice/index.template`

### `ListenerArnOverride` — attach a service to a non-default listener (`1.3.0`, `8c76965`)

New `ListenerArnOverride` parameter (String, default `""`) plus the `HasListenerOverride` / `NoListenerOverride` conditions. `LoadbalancerRule.ListenerArn` becomes an `Fn::If` choosing between the parameter and the usual `${ClusterStackName}-ListenerArnHttps` import.

- **`LoadbalancerRuleHttp` gains `"Condition": "NoListenerOverride"`.** The 80→443 redirect must not exist on an HTTP-only internal listener, or every request 301s to a port nothing is listening on.
- **The target group is deliberately kept.** This is smaller than the `ExposeViaLoadBalancer` idea it replaced and avoids its side effect: `AlarmAutoscaleScaleDown` reads task count from ALB `HealthyHostCount`, so a service with no target group would need a different source or the alarm disabled.
- **Default empty renders the other 35 stacks byte-identically**, so the pending `1.3.0` rollout picks this up at no risk. Shipped without a version bump — `1.3.0` therefore means two different template states depending on whether a stack was updated before or after `8c76965`.
- Changing `ListenerArn` on a deployed stack *replaces* the listener rule, and CloudFormation creates the replacement before deleting the original — so the target group is briefly referenced from two load balancers. Rolls back cleanly if AWS rejects it, but do it in a window.


### Alarm cleanup and 4xx rename (`1.3.0`)

**`AlarmHttp5xxElb` removed.** The alarm, its `ServiceHttp5xxElbThreshold` parameter and the `EnableHttp5xxElbAlarm` condition are gone. Load-balancer-generated 5xx (503 no healthy targets, 502 malformed or aborted response, 504 target timeout) is deliberately no longer alarmed. `AlarmHttp5xxTarget` is unchanged and still covers the case the application logs *can* explain.

**Log anomaly detection removed.** `LogAnomalyDetector`, `ServiceLogAnomalyAlarm`, the `EnableLogAnomalyDetection` parameter (which defaulted to `true`, so every service at `1.1.0`+ has a live detector) and the `EnableAnomalyDetector` condition. The feature is ineffective against our log format: CloudWatch compresses events into patterns by masking dynamic content as tokens, so every Apache access line collapses into one pattern and all the variation — status, URL, client — is discarded. AWS names access/audit logs as unsuited. The service `LogGroup` itself is untouched. **Do not re-add without changing the log format first.**

**4xx pair renamed.** `Http4xxAnomalyDetector` → `BaselineHttp4xxTarget` and `AlarmHttp4xxAnomaly` → `AlarmHttp4xxTarget`, following the shape that makes `AlarmHttp5xxTarget` readable: kind (`Alarm` / `Baseline`) + what (`Http4xx`) + whose (`Target`, i.e. target-side rather than LB-side). `Baseline` says the resource holds an expected range rather than detecting anything by itself. The console-visible `AlarmName` keeps the word: `${AWS::StackName}-AlarmHttp4xxTargetAnomaly`, so an operator can still tell it is band-based and not a fixed threshold. The `EnableHttp4xxAnomalyAlarm` / `ServiceHttp4xxAnomalyBand` parameters and the `EnableHttp4xxAnomaly` condition were **not** renamed — parameter renames break deployed stacks.

**`DependsOn` added.** `AlarmHttp4xxTarget` now declares `DependsOn: [ "BaselineHttp4xxTarget" ]`. Nothing else ordered them: an anomaly detector is bound to its alarm implicitly, by matching namespace, metric, dimensions and stat, never by `Ref`. Without the dependency CloudFormation was free to delete the detector first when the pair is disabled or the stack removed, and `DeleteAnomalyDetector` fails while an alarm still references that metric — landing the stack in `DELETE_FAILED`.

**Rollout impact.** Renaming a logical ID replaces the resource, so `BaselineHttp4xxTarget` and `AlarmHttp4xxTarget` are deleted and recreated on the next update of any stack that has the pair enabled (currently only `gwa-gut-web-p`). The detector's model rebuilds immediately from retained `HTTPCode_Target_4XX_Count` history — the metric is published continuously and kept 15 months — so no fresh training period is incurred. Removed parameters are dropped automatically by CloudFormation; no deploy tooling passes them.


### `InitialDockerImage` stale image fix — Lambda custom resource
**Problem:** the pipeline uses `deploy-docker-to-ecs.sh` to update ECS directly, bypassing CloudFormation. This left `InitialDockerImage` frozen at the value from stack creation. Any subsequent CF stack update (e.g. changing `TaskMemory`) would roll the running image back to that stale value. The direct ECS deploy also gave no feedback on task health — the pipeline step always succeeded regardless of container state.

**Approaches evaluated:**

| Approach | Verdict |
|---|---|
| CF deploy (`cloudformation deploy` in pipeline) | Shelved — introduces ROLLBACK_FAILED risk; failure mode more severe than direct ECS deploy |
| SSM Parameter Store + direct ECS deploy | Shelved — SSM param orphaned on stack delete; pipeline must run before stack creation |
| Mutable ECR tag (`latest`) | Shelved — loses per-deploy traceability; ECS won't pull new image without force-deploy |
| Process only | Rejected — relies on discipline, no enforcement |
| Lambda custom resource (stack-contained) | **Selected** |

**Implementation:** three stack-managed resources — `ImageResolverRole`, `ImageResolverFunction`, `ImageResolver` (custom resource), all deleted with the stack.

- **On `Create`:** Lambda returns `InitialDockerImage` directly — no running service exists yet
- **On `Update`:** Lambda calls `ecs:DescribeServices` to get the active task definition ARN, then `ecs:DescribeTaskDefinition` to read its image — CF always uses the currently deployed image
- **`SkipImageResolver` parameter** (`true`/`false`, default `false`): bypasses the ECS lookup and uses `InitialDockerImage` directly, for forcing a specific image
- **IAM role** scoped to `ecs:DescribeServices` and `ecs:DescribeTaskDefinition` only, plus `AWSLambdaBasicExecutionRole`
- All non-secret parameters listed as custom resource properties so the Lambda triggers on any stack update
- `NoEcho` parameters (e.g. `ProjectToken`) intentionally excluded — CloudFormation rejects passing `NoEcho` values to custom resources
- `TaskDefinition` uses `Fn::GetAtt: [ImageResolver, Value]` for its image

**`DeploymentCircuitBreaker`** added to the `Service` resource (`Enable: true`, `Rollback: true`) — ECS detects failing tasks quickly and automatically rolls back to the previous task definition.

**Migration caveat — existing service stacks:** service stacks deployed before `c58bee4` don't have the Lambda yet. When the cluster stack is updated (for any reason), CF may re-evaluate task definitions on those older service stacks and roll back to `InitialDockerImage` — causing a `CannotPullContainerError` if that image no longer exists in ECR.

**Migration procedure for each affected service stack:**
1. Redeploy via the pipeline first to get the service running with a known good image
2. Find the latest image tag in ECR: `aws ecr describe-images --repository-name <repo> --region eu-central-1 --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageTags[0]' --output text`
3. Deploy the updated `ecsservice/index.template` with `InitialDockerImage` set to that tag — on first deploy the Lambda runs as `Create` and uses `InitialDockerImage`, so it must be current
4. After this first update, subsequent stack updates use the Lambda's `Update` path which reads the running image from ECS automatically
