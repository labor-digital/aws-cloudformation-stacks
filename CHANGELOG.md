# CHANGELOG

## Summary
    
**Uncommitted**
- [Shared ALB access logs bucket — new template](#shared-alb-access-logs-bucket) — pending deployment
- [ALB Access Logs — optional via `LogsBucketName`](#alb-access-logs--optional-via-logsbucketname-parameter) — pending `alb-logs-bucket` deployment
- Rename `ecscluster-vpc-rds-asg/backup` → `ecscluster-vpc-rds-asg/backup-vaults-mirror`

**`41c330f` · 2026-06-03 — remove unused Network ACL and associated resources**
- [NACL removed](#nacl-removed)

**`197fd7b` · 2026-06-03 — remove IPv6 open access, enable VPC flow logs, enforce ALB deletion protection, add automated security updates**
- [Dead IPv6 rules removed from security groups](#dead-ipv6-rules-removed-from-security-groups)
- [VPC Flow Logs added](#vpc-flow-logs-added)
- [ALB Deletion Protection enabled](#alb-deletion-protection-enabled)
- [`dnf-automatic` added to EC2 UserData](#dnf-automatic-added-to-ec2-userdata)

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

## `alb-logs-bucket/index.template` — new template

### Shared ALB access logs bucket
New dedicated stack, deployed once per region. ALB access logs must be written to S3 (no CloudWatch option) — without the correct bucket policy, ALB silently fails to write with no error. The bucket is shared across cluster stacks, each writing under its own prefix (the stack name; `AWSLogs/<account-id>/...` is appended automatically by ALB).

- **Encryption:** SSE-S3 (AES256) — KMS is not supported for ALB log delivery
- **Versioning:** enabled — protects against accidental object deletion
- **Public access:** fully blocked on all four settings
- **Lifecycle:** objects deleted after 90 days (configurable via `RetentionDays`) — DSGVO storage limitation requires deletion, not archival; IP addresses in ALB logs are personal data under Art. 5(1)(e)
- **Lifecycle:** incomplete multipart uploads aborted after 7 days — silently abandoned uploads accumulate cost
- **Bucket policy:** `logdelivery.elasticloadbalancing.amazonaws.com` service principal (modern post-Aug 2022 approach), scoped to `AWSLogs/<account-id>/*`
- **`DeletionPolicy: Retain`** — bucket and logs survive stack deletion

---

## `ecscluster-vpc-rds-asg/index.template`

### ALB Access Logs — optional via `LogsBucketName` parameter
Added optional `LogsBucketName` parameter (default empty string). When empty, behavior is identical to before — logging stays off. When set, the `AccessLogsEnabled` condition activates and the ALB is configured with `access_logs.s3.enabled = true`, the bucket name, and the stack name as prefix. The `AWS::NoValue` pattern is used to omit the bucket and prefix attributes entirely from the array when logging is disabled.

**To enable:** deploy `alb-logs-bucket/index.template` in `eu-west-3` first, then pass the resulting bucket name as `LogsBucketName` when creating or updating the cluster stack.

### NACL removed
Removed all five NACL resources (`Netacl`, `NetaclEntry1`, `NetaclEntry2`, `AssociateNetacl1`, `AssociateNetacl2`). Both entries allowed all traffic in both directions (`Protocol: -1`, `0.0.0.0/0`) — functionally identical to the AWS default NACL. Subnets automatically fall back to the default NACL on removal; no change in traffic behavior.

The alternative of making the NACL restrictive was rejected: NACLs are stateless, requiring explicit rules for ephemeral return traffic (ports 1024–65535), which is easy to misconfigure silently. Security groups already handle fine-grained access control at the instance level.

### Dead IPv6 rules removed from security groups
`SgPublicHttpHttps` and `SgPublicHttps` both had `::/0` ingress rules for ports 80 and 443. The ALB is configured as `IpAddressType: ipv4` — it never accepts IPv6 traffic, so those rules were dead weight. Removed two `::/0` rules from each security group; IPv4 `0.0.0.0/0` rules are untouched.

### VPC Flow Logs added
Three new stack-managed resources:
- **`VpcFlowLogGroup`** (`AWS::Logs::LogGroup`) — 90-day retention. IP addresses are personal data under DSGVO; retention period and legal basis (typically Art. 6(1)(f) legitimate interest) should be documented in the VVT. Note: log group and its data are lost on stack deletion — consider `DeletionPolicy: Retain` if continuity across stack recreations is needed.
- **`VpcFlowLogRole`** (`AWS::IAM::Role`) — scoped to write access on the specific log group only, assumed by `vpc-flow-logs.amazonaws.com`
- **`VpcFlowLog`** (`AWS::EC2::FlowLog`) — `TrafficType: ALL`, delivers to CloudWatch. Useful for debugging blocked traffic, security audits, and tracing what reaches or leaves the VPC.

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
