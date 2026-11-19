# README #

This repo contains all stack-templates used by LABOR on AWS

Parameters are not documented here: every parameter carries a `Description` in its template and is
grouped via `AWS::CloudFormation::Interface`, so the console shows both at deployment time.

### Templates ###

| Template | Purpose |
|---|---|
| `ecscluster-vpc-rds-asg` | Complete ECS cluster: VPC, RDS Aurora, ASG, ALB, EFS, AWS Backup, DNS Firewall, WAF, monitoring |
| `ecscluster-vpc-rds-asg/guardduty` | GuardDuty detector, quarantine SG, incident response role. One stack per region |
| `ecscluster-vpc-rds-asg/backup-vaults-mirror` | Backup vaults in the target region for cross-region copies |
| `ecsservice` | A containerized service on an existing cluster |
| `s3-bucket` | Hardened S3 bucket for ALB access logs or Lambda artifacts; one stack per purpose |
| `cognito-userpool` | Shared Cognito app client for e-mail OTP login with allowlist and Mailjet delivery |
| `alb-ecsservice-rule` | Additional host/path rule onto the target group of an existing service |
| `alb-redirect-rule` | URL redirect rule on the ALB |
| `alb-additional-certificate` | ACM certificate as an additional certificate on the HTTPS listener |
| `certificate` | Standalone ACM certificate with DNS validation |
| `cloudfront-alb-distribution` | CloudFront in front of an ALB, including WAF WebACL |
| `global-accelerator-alb` | Global Accelerator with two static anycast IPv4 in front of an ALB |

`ecscluster-ext-additional-cluster` is deprecated and no longer supported.

### Deployment order ###

Per region. Only step 3 → 4 is enforced by an import; 1 and 2 can be added later.

1. `s3-bucket` with `BucketPurpose=alb-access-logs` — provides `BucketName` for `LogsBucketName`
2. `backup-vaults-mirror` — before the cluster and in the target region
3. `ecscluster-vpc-rds-asg`
4. `guardduty` — after the cluster, the quarantine SG imports `${Cluster}-Vpc`. Once per region
5. Optional: `cognito-userpool` — after the cluster, before any protected service
6. `ecsservice` — per application
7. Optional: the leaf templates listed above

### Service-Template Update Best Practice ###

Before updating a Service-Cloudformation-Stack with a new template it´s good to reduce the current drift of that stack as much as possible.
Normally a Service-Stack will not drift that much, apart from the Service-Taskdefinition. In a case of a fault during the update,
Cloudformation will trigger a Rollback, which will rollback to the last known stack-configuration. The problem is that the docker-image
in this last known configuration could be really old, or worse isn´t available anymore.

So here the best practice steps for an update of a service stack:
* Detect the drift
* If there are more changes detected than the Task-definition of the Service itself, change these settings back
* Update the service-stack without replacing the template and only set the parameter `InitialDockerImage` to the current running image
* Wait till the stack is updated and in a ready state again
* Now update the stack and replace the template an make all the changes you want to

### Why the image parameter matters ###

The service template resolves `InitialDockerImage` through a custom resource that reads the image
the service is currently running. Two properties of that mechanism are easy to get wrong:

* **The custom resource only runs when one of its own properties changes.** On a pure template
  update nothing in the resolver changes, so it is not invoked, and the task definition is written
  from the value stored at its last invocation. Setting `InitialDockerImage` to the running image
  changes a property, forces the invocation and makes the result deterministic.
* **If the service cannot be read** -- it does not exist yet, it is `INACTIVE`, it has no task
  definition, or its last deployment failed -- the resolver falls back to the parameter. That is
  exactly the recovery case, so a stale parameter is what gets deployed.

The images themselves are not permanent. ECR lifecycle rules expire untagged images and keep only a
limited number of tagged ones, and a task definition pins the digest it resolved at registration
time unless the template sets `VersionConsistency` to `disabled`, which it does since service
template version 1.7.0. An image that disappears breaks nothing until the next task start, which
then fails with `CannotPullContainerError: manifest unknown`. Pulling by tag covers deleted untagged
images; it does not help once the tagged image itself has been expired.

### Stack-Role ###

Remember to use an own role for Stack-Creation. [Docs](http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)

### ECR Access across accounts 
To access the ECR Registry from another AWS account (e.g. with an ECS service) it is essential to add the following policy to each repository the foreign account should be able to access.
Replace the $EXT_ACCOUNT_ID variable with the real id of the account that wants to access the repository.
To find the account id, log in to the account and click on "Support" (top left) and "Support Center". At the top of that page you will see the id.

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
