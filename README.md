# README #

This repo contains all stack-templates used by LABOR on AWS

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