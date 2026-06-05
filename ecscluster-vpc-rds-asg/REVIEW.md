# Template Review — `ecscluster-vpc-rds-asg/index.template`

## Medium — ECS scaling

- **`CapacityProvider`** — `ManagedTerminationProtection: DISABLED`. Instances can be terminated mid-task during scale-down without draining. Change to `ENABLED`.
- **`CapacityProvider`** — `MaximumScalingStepSize: 2` is hardcoded and conservative. During traffic spikes the cluster can only add 2 instances per scaling action.

## Low — RDS hardening

- No `EnableIAMDatabaseAuthentication`.
- No `EnableCloudwatchLogsExports` for MySQL error/slow query logs.
