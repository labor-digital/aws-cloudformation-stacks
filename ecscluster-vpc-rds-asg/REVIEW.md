# Template Review — `ecscluster-vpc-rds-asg/index.template`

## Critical — data loss risk

- **`Rdscl`** — no `DeletionPolicy`. Stack deletion destroys the database without a snapshot. Add `"DeletionPolicy": "Snapshot"` and `"UpdateReplacePolicy": "Snapshot"`.
- **`Efs`** — no `DeletionPolicy`. Stack deletion destroys the file system. Add `"DeletionPolicy": "Retain"`.
- **`Rdscl`** — `BackupRetentionPeriod: 1`. Only 1 day of automated backups. Production minimum should be 7 days.

## Critical — functional issue

**`Httpdefaultlistener`** (port 80) forwards traffic directly to `Deftarget`, which is configured with `Protocol: HTTPS` and `HealthCheckProtocol: HTTPS`. In a typical ECS setup where SSL terminates at the ALB, the HTTP listener should redirect to HTTPS (301) rather than forward to an HTTPS target group.

## Medium — health check configuration

- **`Deftarget`** — `HealthCheckTimeoutSeconds: 5` is tight for HTTPS (handshake + response). Increase to 10.
- **`Deftarget`** — `Matcher.HttpCode: "200"` rejects all other 2xx responses (201, 204, redirects). Change to `"200-299"`.

## Medium — ECS scaling

- **`CapacityProvider`** — `ManagedTerminationProtection: DISABLED`. Instances can be terminated mid-task during scale-down without draining. Change to `ENABLED`.
- **`CapacityProvider`** — `MaximumScalingStepSize: 2` is hardcoded and conservative. During traffic spikes the cluster can only add 2 instances per scaling action.

## Low — RDS hardening

- No `EnableIAMDatabaseAuthentication`.
- No `EnableCloudwatchLogsExports` for MySQL error/slow query logs.
