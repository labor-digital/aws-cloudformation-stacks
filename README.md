# AWS CloudFormation Stacks

Dieses Repository enthält die AWS CloudFormation Stack-Templates, die von LABOR für die Bereitstellung von Infrastruktur und Anwendungen verwendet werden.

---

## Übersicht

| Template | Beschreibung |
|---|---|
| `ecscluster-vpc-rds-asg` | Vollständiger ECS-Cluster-Stack mit VPC, RDS, Auto Scaling Group und Load Balancer. |
| `ecscluster-vpc-rds-asg/backup` | Erstellt zusätzliche Backup-Vaults für regionsübergreifende Backups. |
| `ecsservice-template` | ECS-Service-Stack zur Bereitstellung einer containerisierten Anwendung auf einem bestehenden Cluster. |

> **Hinweis:** Das Template in `ecscluster-ext-additional-cluster` ist veraltet und wird nicht mehr aktiv unterstützt oder dokumentiert.

---

## Templates

### ecscluster-vpc-rds-asg

Erstellt eine vollständige, eigenständige Infrastruktur für den Betrieb von ECS-Services. Dieser Stack umfasst:

- **VPC** mit Subnetzen über mehrere Availability Zones (AZs).
- **ECS-Cluster** (EC2 Launch Type).
- **Auto Scaling Group** für EC2-Instanzen (Standard: `t3.small`).
- **Application Load Balancer (ALB)** mit HTTPS-Listener.
- **RDS-Instanz** (Standard: `db.t3.medium`) innerhalb der VPC.
- **ECS Capacity Provider** mit verwalteter Skalierung (Zielkapazität: 80%).
- **Lambda-Funktion** zur sicheren Instanz-Entfernung (Draining über SNS-Topic).
- **AWS Backup** mit optionaler regionsübergreifender Kopie für RDS-Snapshots.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `KeypairName` | Name des EC2-KeyPairs für SSH-Zugriff. |
| `RdsMasterUsername` | Master-Benutzername für die RDS-Instanz. |
| `RdsMasterPassword` | Master-Passwort für die RDS-Instanz (mind. 32 Zeichen, wird nicht im Log ausgegeben). |
| `HttpsdefaultlistenerCertificate` | ACM-Zertifikats-ARN für den ALB HTTPS-Listener. |
| `EC2MachineImage` | AMI-ID für die ECS-Instanzen. |
| `BackupCopyDestinationRegion` | Zielregion für RDS-Backup-Kopien (Standard: `eu-north-1`). |
| `AscalegroupMinSize` | Minimale Anzahl der EC2-Instanzen im Cluster. |
| `AscalegroupMaxSize` | Maximale Anzahl der EC2-Instanzen im Cluster. |

---

### ecscluster-vpc-rds-asg/backup

Erstellt zusätzliche Backup-Vaults, die für die Spiegelung von Backups in eine andere Region (z. B. `eu-north-1`) benötigt werden. Dieser Stack umfasst:

- **BackupVault**: Ein Standard-Backup-Vault (`${ClusterName}-BackupVault-Mirror`).
- **LongTermBackupVault**: Ein Backup-Vault für Langzeitaufbewahrung (`${ClusterName}-BackupLongTermVault-Mirror`).

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterName` | Name des Clusters, für den die Backup-Vaults erstellt werden. |

---

### ecsservice-template

Dient zur Bereitstellung eines einzelnen ECS-Services auf einem Cluster, der mit `ecscluster-vpc-rds-asg` erstellt wurde. Der Stack umfasst:

- **ECS Task Definition** (Einzelcontainer mit EFS-Mount und Doppler-Secret-Injektion).
- **ECS Service** mit ALB-Integration.
- **ALB Listener Rule** basierend auf Hostname und Pfad.
- **Autoscaling** auf Task-Ebene (CPU/Speicher).
- **EFS Access Point** für persistenten Speicher.
- **IAM-Rollen** für Task und Service.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterStackName` | Name des bestehenden CloudFormation-Stacks des Clusters. |
| `ListenerRuleHost` | Hostname für die ALB-Listener-Regel. |
| `InitialDockerImage` | Docker-Image für das initiale Deployment. |
| `TaskMemory` | Soft Limit für den Arbeitsspeicher pro Task (Empfehlung für `t3.small`: `485`, `970` oder `1940`). |
| `ProjectNameShort` | Projekt-Kurzname (Format: `xxx_xxx_xxx`) für die Doppler-Zuordnung. |
| `ProjectToken` | Doppler Service-Token (Read-only) für die Secret-Injektion. |

---

## Service-Template Update Best Practice

Bevor ein Service-CloudFormation-Stack mit einem neuen Template aktualisiert wird, sollte der aktuelle Drift dieses Stacks so weit wie möglich reduziert werden.

Normalerweise driftet ein Service-Stack nicht signifikant ab, abgesehen von der Task-Definition des Services. Im Falle eines Fehlers während des Updates löst CloudFormation ein Rollback auf die letzte bekannte Stack-Konfiguration aus. Das Problem dabei ist, dass das Docker-Image in dieser letzten bekannten Konfiguration sehr alt sein könnte – oder schlimmer noch, gar nicht mehr verfügbar ist.

**Schritte für ein sicheres Update des Service-Stacks:**

1. Erkennen des Drifts des Stacks.
2. Falls mehr Änderungen als nur die Task-Definition des Services selbst erkannt werden, sollten diese Einstellungen manuell zurückgesetzt werden.
3. Den Service-Stack **ohne Austausch des Templates** aktualisieren – dabei nur den Parameter `InitialDockerImage` auf das aktuell laufende Image setzen.
4. Warten, bis der Stack aktualisiert wurde und wieder in einem bereiten Zustand ist.
5. Nun den Stack erneut aktualisieren, das Template ersetzen und alle gewünschten Änderungen anwenden.

---

## Allgemeine Hinweise

### Stack-Rolle
Verwenden Sie immer eine dedizierte IAM-Rolle für die Erstellung und Aktualisierung von Stacks. Weitere Informationen finden Sie in der [AWS-Dokumentation](http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html).

### ECR-Zugriff über Accounts hinweg
Um einem ECS-Service in einem anderen AWS-Account den Zugriff auf ECR-Images zu ermöglichen, fügen Sie die folgende ressourcenbasierte Richtlinie zum jeweiligen ECR-Repository hinzu. Ersetzen Sie `$EXT_ACCOUNT_ID` durch die ID des externen Accounts.

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
