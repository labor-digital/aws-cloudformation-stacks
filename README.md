# AWS CloudFormation Stacks

Dieses Repository enthält die AWS CloudFormation Stack-Templates, die von LABOR für die Bereitstellung von Infrastruktur und Anwendungen verwendet werden.

---

## Übersicht

| Template | Beschreibung |
|---|---|
| `ecscluster-vpc-rds-asg` | Vollständiger ECS-Cluster-Stack mit VPC, RDS, Auto Scaling Group und Load Balancer. |
| `ecscluster-vpc-rds-asg/backup` | Erstellt zusätzliche Backup-Vaults für regionsübergreifende Backups. |
| `ecsservice-template` | ECS-Service-Stack zur Bereitstellung einer containerisierten Anwendung auf einem bestehenden Cluster. |
| `alb-redirect-rule` | Erstellt eine URL-Redirect-Regel auf dem Application Load Balancer eines bestehenden Clusters. |
| `alb-additional-certificate` | Erstellt ein SSL-Zertifikat und weist es als zusätzliches Zertifikat dem HTTPS-Listener eines bestehenden ALB zu. |
| `certificate` | Erstellt ein SSL-Zertifikat via AWS Certificate Manager (ACM) mit DNS-Validierung. |

> **Hinweis:** Das Template in `ecscluster-ext-additional-cluster` ist veraltet und wird nicht mehr aktiv unterstützt oder dokumentiert.

---

## Templates

### ecscluster-vpc-rds-asg

Erstellt eine vollständige, eigenständige Infrastruktur für den Betrieb von ECS-Services. Dieser Stack umfasst:

- **VPC** mit öffentlichen und privaten Subnetzen über mehrere Availability Zones (AZs), inkl. NAT Gateway.
- **ECS-Cluster** (EC2 Launch Type).
- **Auto Scaling Group** für EC2-Instanzen (Standard: `t3.small`) — startet initial mit 0 Instanzen, ECS Managed Scaling skaliert automatisch bei Bedarf.
- **Application Load Balancer (ALB)** mit HTTPS-Listener.
- **RDS-Instanz** (Standard: `db.t3.medium`) innerhalb der VPC.
- **ECS Capacity Provider** mit verwalteter Skalierung (Zielkapazität: 80%).
- **AWS Backup** mit optionaler regionsübergreifender Kopie für RDS-Snapshots und EFS.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `KeypairName` | Name des EC2-KeyPairs für SSH-Zugriff. |
| `RdsMasterUsername` | Master-Benutzername für die RDS-Instanz. |
| `RdsMasterPassword` | Master-Passwort für die RDS-Instanz (mind. 32 Zeichen, wird nicht im Log ausgegeben). |
| `HttpsdefaultlistenerCertificate` | ACM-Zertifikats-ARN für den ALB HTTPS-Listener. |
| `EC2InstanceType` | Instanztyp für die EC2-Maschinen im Cluster (Standard: `t3.small`). |
| `RdsInstanceType` | Instanztyp für die RDS-Datenbank (Standard: `db.t3.medium`). |
| `AscalegroupMinSize` | Minimale Anzahl der EC2-Instanzen (Standard: `0` — ASG startet leer, ECS Managed Scaling übernimmt). |
| `AscalegroupDesSize` | Gewünschte Anzahl der EC2-Instanzen beim Deployment (Standard: `0`). |
| `AscalegroupMaxSize` | Maximale Anzahl der EC2-Instanzen im Cluster (Standard: `3`). |
| `BackupCopyDestinationRegion` | Zielregion für Backup-Kopien (Standard: `eu-north-1`, leer lassen zum Deaktivieren). |

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

### alb-redirect-rule

Erstellt eine URL-Redirect-Regel auf dem Application Load Balancer (ALB) eines bestehenden Clusters. Der Stack umfasst:

- **ALB Listener Rule (HTTP)**: Leitet eingehende HTTP-Anfragen basierend auf Hostname und Pfad zur Ziel-URL weiter, unter Beibehaltung von Pfad und Query-String.
- **ALB Listener Rule (HTTPS)**: Leitet eingehende HTTPS-Anfragen basierend auf Hostname und Pfad zur Ziel-URL weiter, unter Beibehaltung von Pfad und Query-String.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterStackName` | Name des bestehenden CloudFormation-Stacks des Clusters, dessen ALB-Listener verwendet werden. |
| `ListenerRuleHost` | Hostname, auf den die Listener-Regel reagiert (z. B. `old.example.com`). |
| `ListenerRulePath` | Pfadmuster für die Listener-Regel (Standard: `*`). |
| `ListenerRulePriority` | Priorität der Listener-Regel (muss eindeutig pro Listener sein). |
| `ListenerRuleUrl` | Ziel-Hostname für die Weiterleitung (z. B. `www.example.com`). Pfad und Query-String werden aus der ursprünglichen Anfrage übernommen. |
| `ListenerRuleHttpCode` | HTTP-Statuscode für die Weiterleitung: `301` (Permanent) oder `302` (Temporär). Standard: `301`. |

---

### alb-additional-certificate

Erstellt ein SSL-Zertifikat via AWS Certificate Manager (ACM) und weist es als zusätzliches Zertifikat dem HTTPS-Listener des Application Load Balancers eines bestehenden Clusters zu. Das bestehende Standard-Zertifikat sowie weitere bereits zugewiesene Zertifikate werden dabei nicht verändert.

- **ACM Certificate**: Erstellt ein neues SSL-Zertifikat für den angegebenen Common Name mit DNS-Validierung.
- **ALB Listener Certificate**: Weist das neue Zertifikat als zusätzliches Zertifikat dem HTTPS-Listener zu, ohne bestehende Zertifikate zu ersetzen.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterStackName` | Name des bestehenden CloudFormation-Stacks des Clusters, dessen ALB HTTPS-Listener verwendet wird. |
| `CertificateCommonName` | Der Common Name (Domain) für das SSL-Zertifikat (z. B. `www.example.com` oder `example.com`). |
| `AddWildcardSan` | Auf `true` setzen, um `*.CertificateCommonName` als Subject Alternative Name (SAN) hinzuzufügen. Sinnvoll bei Root-Domains (z. B. `example.com`), damit das Zertifikat auch alle Subdomains (`*.example.com`) abdeckt. Standard: `false`. |

#### Exports

| Export | Beschreibung |
|---|---|
| `${AWS::StackName}-CertificateArn` | ARN des neu erstellten SSL-Zertifikats. |

#### Hinweis: DNS-Validierung während der Stack-Erstellung

Da ACM die Zertifikate per DNS-Validierung ausstellt, **pausiert der CloudFormation-Stack während der Erstellung**, bis das Zertifikat erfolgreich validiert wurde. Während der Stack den Status `CREATE_IN_PROGRESS` hat, müssen folgende Schritte manuell durchgeführt werden:

1. In der AWS-Konsole zu **AWS Certificate Manager (ACM)** navigieren.
2. Das neu erstellte Zertifikat (Status: *Ausstehende Validierung*) öffnen.
3. Die angezeigten **CNAME-Einträge** für die DNS-Validierung kopieren.
4. Diese CNAME-Einträge in der zuständigen **DNS-Zone** (z. B. Route 53 oder externer DNS-Anbieter) für die Domain `CertificateCommonName` (und ggf. `*.CertificateCommonName`) eintragen.
5. Warten, bis ACM die Validierung bestätigt — danach setzt CloudFormation die Stack-Erstellung automatisch fort.

#### Hinweis: Stack-Löschung kann beim ersten Versuch fehlschlagen

Beim Löschen dieses Stacks kann es vorkommen, dass der erste Löschversuch fehlschlägt, da CloudFormation das Zertifikat noch als „in Verwendung" betrachtet (es ist dem ALB-Listener zugewiesen). In diesem Fall einfach einige Minuten warten und den Stack anschließend erneut löschen.

---

### certificate

Erstellt ein SSL-Zertifikat via AWS Certificate Manager (ACM) mit DNS-Validierung. Dieses Template ist nützlich, wenn ein Zertifikat unabhängig von einem Load Balancer erstellt werden soll, um es später manuell oder in anderen Stacks zu verwenden.

- **ACM Certificate**: Erstellt ein neues SSL-Zertifikat für den angegebenen Common Name mit DNS-Validierung.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `CertificateCommonName` | Der Common Name (Domain) für das SSL-Zertifikat (z. B. `www.example.com` oder `example.com`). |
| `AddWildcardSan` | Auf `true` setzen, um `*.CertificateCommonName` als Subject Alternative Name (SAN) hinzuzufügen. Sinnvoll bei Root-Domains (z. B. `example.com`), damit das Zertifikat auch alle Subdomains (`*.example.com`) abdeckt. Standard: `false`. |

#### Exports

| Export | Beschreibung |
|---|---|
| `${AWS::StackName}-CertificateArn` | ARN des neu erstellten SSL-Zertifikats. |

#### Hinweis: DNS-Validierung während der Stack-Erstellung

Da ACM die Zertifikate per DNS-Validierung ausstellt, **pausiert der CloudFormation-Stack während der Erstellung**, bis das Zertifikat erfolgreich validiert wurde. Während der Stack den Status `CREATE_IN_PROGRESS` hat, müssen folgende Schritte manuell durchgeführt werden:

1. In der AWS-Konsole zu **AWS Certificate Manager (ACM)** navigieren.
2. Das neu erstellte Zertifikat (Status: *Ausstehende Validierung*) öffnen.
3. Die angezeigten **CNAME-Einträge** für die DNS-Validierung kopieren.
4. Diese CNAME-Einträge in der zuständigen **DNS-Zone** (z. B. Route 53 oder externer DNS-Anbieter) für die Domain `CertificateCommonName` (und ggf. `*.CertificateCommonName`) eintragen.
5. Warten, bis ACM die Validierung bestätigt — danach setzt CloudFormation die Stack-Erstellung automatisch fort.

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
