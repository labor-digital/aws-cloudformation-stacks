# AWS Cluster with RDS in own VPC #

This template creates a complete stack to run ECS-Services.
It consists of a own VPC, single RDS, single ECS-Cluster and Autoscalinggroup with one Loadbalancer.
The complete logic for Autoscaling is implemented with ECS.MemoryReservation (> 65 | < 43) Cloudwatch Alarms.
Downscaling is secured via Hook to set the instance, which should be removed in a draining-state.
This is handled via SNS-Topic in Lambda-function.