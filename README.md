# aws-cloudformation-stacks

This repository contains all AWS CloudFormation stack templates used by LABOR.

---

## Overview

| Template | Description |
|---|---|
| `ecscluster-vpc-rds-asg` | Full ECS cluster stack with VPC, RDS, Auto Scaling Group and Load Balancer |
| `ecsservice-template` | ECS service stack to deploy a containerized application onto an existing cluster |

---

## Templates

### ecscluster-vpc-rds-asg

Creates a complete, self-contained infrastructure stack to run ECS services. The stack provisions:

- **VPC** with subnets across multiple availability zones
- **ECS Cluster** with EC2 launch type
- **Auto Scaling Group** for EC2 instances (default: `t3.small`)
- **Application Load Balancer** with HTTPS listener
- **RDS** database instance (default: `db.t3.medium`) inside the VPC
- **CloudWatch Alarms** for memory-based autoscaling (`ECS.MemoryReservation > 65%` → scale out, `< 43%` → scale in)
- **Lambda function** via SNS topic to set EC2 instances into draining state before removal (safe scale-in)
- **AWS Backup** with optional cross-region copy for RDS snapshots

#### Parameters

| Parameter | Description |
|---|---|
| `KeypairName` | EC2 KeyPair name for SSH access |
| `RdsMasterUsername` | Master username for the RDS instance |
| `RdsMasterPassword` | Master password for the RDS instance (min. 32 characters, hidden) |
| `HttpsdefaultlistenerCertificate` | ACM certificate ARN for the ALB HTTPS default listener (4096-bit keys not supported) |
| `AscalegroupMinSize` | Minimum number of EC2 instances in the Auto Scaling Group |
| `AscalegroupMaxSize` | Maximum number of EC2 instances in the Auto Scaling Group |
| `AscalegroupDesSize` | Desired number of EC2 instances in the Auto Scaling Group |
| `EC2MachineImage` | EC2 AMI ID to use for cluster instances |
| `EC2InstanceType` | EC2 instance type (`t3.small` or `t3.micro`, default: `t3.small`) |
| `RdsInstanceType` | RDS instance type (default: `db.t3.medium`) |
| `BackupCopyDestinationRegion` | AWS region for cross-region RDS backup copy (default: `eu-north-1`) |

---

### ecsservice-template

Deploys a single ECS service onto an existing cluster created by `ecscluster-vpc-rds-asg`. The stack provisions:

- **ECS Task Definition** with a single container, EFS volume mount and Doppler secret injection
- **ECS Service** with ALB integration and configurable health checks
- **ALB Listener Rule** based on hostname and path pattern
- **Task-level Auto Scaling** based on CPU and memory utilization
- **EFS Access Point** for persistent storage
- **IAM Roles** for the ECS task and service

#### Parameters

| Parameter | Description |
|---|---|
| `ClusterStackName` | Name of the existing cluster CloudFormation stack |
| `ListenerRuleHost` | Hostname for the ALB listener rule |
| `ListenerRulePath` | Path pattern for the ALB listener rule (default: `*`) |
| `ListenerRulePriority` | Priority for the ALB listener rule |
| `InitialDockerImage` | Docker image to use for the initial deployment |
| `TaskMemory` | Soft memory limit per task in MB. Recommended values for `t3.small`: `485`, `970`, `1940` |
| `ServiceDesiredCount` | Desired (and minimum) number of running task instances [0–4] |
| `ServiceMaxCapacity` | Maximum number of running task instances for autoscaling [1–10] |
| `ECSHealthCheckGracePeriod` | Seconds ECS waits before health-checking a newly started container |
| `ServiceTrafficPort` | Port the container serves traffic on (also used for health checks) |
| `ServiceTrafficProtocol` | Protocol the container uses (`HTTP` or `HTTPS`) |
| `ECSHealthCheckPath` | HTTP path used for the health check (default: `/test.php`) |
| `VolumeMountPath` | Container path where the EFS volume is mounted (default: `/var/www/html_data`) |
| `ProjectNameShort` | Short project identifier in the format `xxx_xxx_xxx` — used to resolve the Doppler project |
| `ProjectEnv` | Deployment environment, used for Doppler config resolution (default: `prd`) |
| `ProjectToken` | Doppler service token for secret injection (read-only service token required, hidden) |
| `ContainerCommand` | Optional command override for the container as a comma-separated list (e.g. `python,app.py`) |

---

## General Notes

### Stack Role

Always use a dedicated IAM role for stack creation and updates.
See the [AWS documentation](http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html) for details.

### ECR Access Across Accounts

To allow an ECS service in a different AWS account to pull images from your ECR registry, add the following resource-based policy to each relevant ECR repository. Replace `$EXT_ACCOUNT_ID` with the account ID of the external account (visible in the AWS Console under **Support → Support Center**).

```json
{
  "Version": "2008-10-17",
  "Statement": [
    {
      "Sid": "EXTERNAL ACCOUNT - Allow ECR Access",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::$EXT_ACCOUNT_ID:root"
      },
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ]
    }
  ]
}
```

---

## Service-Template Update Best Practice

Before updating a service CloudFormation stack with a new template, reduce the current drift of that stack as much as possible.

Normally a service stack will not drift significantly, apart from the service task definition. In case of a fault during the update, CloudFormation will trigger a rollback to the last known stack configuration. The problem is that the Docker image in this last known configuration could be very old — or worse, no longer available.

**Steps for a safe service stack update:**

1. Detect the drift of the stack
2. If there are more changes detected than the task definition of the service itself, revert those settings manually
3. Update the service stack **without replacing the template** — only set the parameter `InitialDockerImage` to the currently running image
4. Wait until the stack is updated and back in a ready state
5. Now update the stack, replace the template and apply all desired changes
