# AWS CloudFormation Stacks

Dieses Repository enthält die AWS CloudFormation Stack-Templates, die von LABOR für die Bereitstellung von Infrastruktur und Anwendungen verwendet werden.

---

## Übersicht

| Template                       | Beschreibung |
|--------------------------------|---|
| `ecscluster-vpc-rds-asg`       | Vollständiger ECS-Cluster-Stack mit VPC, RDS, Auto Scaling Group, Load Balancer, CloudWatch-Überwachung und DNS Firewall für Zero-Trust-Egress-Sicherheit. |
| `ecscluster-vpc-rds-asg/alb-logs-bucket` | ALB-Zugriffslogs mit S3-Lifecycle-Regeln und DSGVO-Aufbewahrungsgrenzen. Separate, unveränderlich gespeicherte Ressource (Löschung von Stack hindert Bucket nicht). |
| `ecscluster-vpc-rds-asg/backup` | Erstellt zusätzliche Backup-Vaults für regionsübergreifende Backups. |
| `ecscluster-vpc-rds-asg/guardduty` | GuardDuty Detector + Quarantine Security Group + IAM-Rollen für Threat Detection und Zero-Trust-Incident-Response. Pro Region ein Stack. |
| `ecsservice`                   | ECS-Service-Stack zur Bereitstellung einer containerisierten Anwendung auf einem bestehenden Cluster. |
| `alb-ecsservice-rule`          | Verbindet einen Hostnamen und Pfad mit der Targetgroup eines bestehenden ECS-Services. |
| `alb-redirect-rule`            | Erstellt eine URL-Redirect-Regel auf dem Application Load Balancer eines bestehenden Clusters. |
| `alb-additional-certificate`   | Erstellt ein SSL-Zertifikat und weist es als zusätzliches Zertifikat dem HTTPS-Listener eines bestehenden ALB zu. |
| `certificate`                  | Erstellt ein SSL-Zertifikat via AWS Certificate Manager (ACM) mit DNS-Validierung. |
| `cloudfront-alb-distribution`  | Erstellt eine CloudFront-Distribution, die Traffic für eine Domain an einen Application Load Balancer weiterleitet, inkl. WAF-Integration. |
| `global-accelerator-alb`       | Erstellt einen AWS Global Accelerator mit einem ALB als Endpoint. Stellt zwei statische Anycast-IPv4-Adressen bereit, die direkt als A-Records in externen DNS-Providern eingetragen werden können. |

> **Hinweis:** Das Template in `ecscluster-ext-additional-cluster` ist veraltet und wird nicht mehr aktiv unterstützt oder dokumentiert.

---

## Architektur- und Designentscheidungen

### Zero-Trust Egress Security: Vierphasiger Rollout

Die Cluster-Infrastruktur folgt einer wiederholbaren, vier-Phasen-Strategie für die Härtung ausgehender Netzwerksicherheit. Jede Phase wird auf einem Cluster validiert, bevor sie auf weitere angewendet wird.

**Phase 1: DNS Monitoring (ALERT-Modus)**
- DNS Firewall mit zwei Regeln: ALLOW für die Whitelist, ALERT für alles andere
- Route 53 Query Logging für DNS-Abfragen in CloudWatch
- GuardDuty aktivieren (Threat Detection basierend auf VPC Flow Logs + DNS Logs)
- Mindestens 7 Tage laufen lassen, um Baseline zu sammeln

**Phase 2: Whitelist-Analyse & Verfeinerung**
- CloudWatch Logs Insights Query ausführen: alle ALERT'd domains dieser Phase
- Gruppieren nach Häufigkeit; legitime Services identifizieren, Tracker/verdächtige Domains filtern
- DNS-Whitelist mit aggrierierten Root-Domains updaten (Wildcards vorsichtig verwenden — `*.example.com` in Route 53 DNS Firewall matched alle Subdomain-Tiefen)
- GuardDuty Findings prüfen und mit DNS-Logs korrelieren

**Phase 3: Security Group Härtung**
- *Step A:* ACCEPT-Mode VPC Flow Logs aktivieren (`EnableEgressAnalysis=true` Parameter), 7–14 Tage laufen, `VpcEgressPortsAnalysis` Query ausführen → Baseline aller egress Ports sammeln
- *Step B:* Prüfen, ob Instanzen bereits Amazon Time Sync Service (`169.254.169.123`) nutzen; falls nein, Port 123/UDP hinzufügen oder auf Time Sync migrieren
- *Step C:* Blanket Allow-All Egress-Regel löschen, explizite Egress-Regeln hinzufügen: 443/TCP (HTTPS/APIs), 587/TCP (SMTP, wenn benötigt), 123/UDP (NTP, wenn nicht Time Sync), 53/TCP+UDP (interne DNS zum VPC CIDR)
- *Step D:* Automated Incident Response: EventBridge + Lambda, die on HIGH-Severity GuardDuty findings eine instance auf die Quarantine Security Group (zero egress) umschalten

**Phase 4: Go Live (BLOCK-Modus)**
- DNS Firewall Catch-All-Regel von ALERT → BLOCK umschalten
- Kritische Anwendungen testen (Email, NTP, APIs)
- Erste 48h CloudWatch BLOCK-Events monitoren
- Rollback-Befehl dokumentieren

**Warum die Phasierung:** ALERT-Modus first, weil die Whitelist-Genauigkeit direkt auswirkt — zu eng und legitime Traffic blockiert, zu weit und Sicherheit ist illusorisch. Erst nach einer Woche Datensammlung und gründlicher Analyse ist die Whitelist stabil. Dann folgt die Egress-Härtung isoliert (die Whitelist ist stabil, also keine "war die DNS-Regel zu streng?" Fragen mehr). Quarantine-Automation kommt zuletzt, wenn alle Rules statisch sind. Blockieren kommt erst, wenn alles getestet wurde.

**Infrastruktur-Komponenten:**
- **DNS Firewall** (in `ecscluster-vpc-rds-asg`): Route 53 Resolver mit zwei Regeln (ALLOW Whitelist, ALERT Catch-all). Aktiv ab Phase 1.
- **Route 53 Query Logs** (in `ecscluster-vpc-rds-asg`): Erfasst alle DNS-Abfragen in CloudWatch Logs für Analyse.
- **GuardDuty Detector** (in separatem `guardduty` Stack): Überwacht VPC Flow Logs + Route 53 DNS Logs + CloudTrail auf Bedrohungen. Per Region ein Stack (nicht pro Cluster).
- **Quarantine Security Group** (in `guardduty` Stack): Null Egress-Regeln. Wird von der Phase-3-Step-D-Automation (EventBridge + Lambda) auf Instances angewendet, wenn GuardDuty HIGH-Severity-Findings erkennt.

### Stack-Abhängigkeiten und Lifecycle

**Stack-Reihenfolge pro Region:**
1. `guardduty` Stack (enables GuardDuty, erstellt Quarantine SG und IAM-Rollen)
2. `ecscluster-vpc-rds-asg` Stack (das Cluster selbst, mit DNS Firewall eingebaut)
3. `ecscluster-vpc-rds-asg/alb-logs-bucket` Stack (separate Stack für ALB-Logs, unveränderlich)
4. `ecsservice` Stack(s) (auf dem Cluster deployt)

**Warum separate Stacks für Konto-Ressourcen:**
- **`guardduty`**: Account + Region sind die natürlichen Grenzen. GuardDuty ist nicht an einen Cluster gebunden; ein Detector überwacht die gesamte Region. Würde der Detector im Cluster-Template leben, könnte man ihn nicht zweimal deployen (harter Limit: ein Detector pro Account/Region). Lebte er im Cluster, würde das Löschen eines Cluster-Stacks die Threat Detection für die gesamte Region abschalten — gefährlich.
- **`alb-logs-bucket`**: Das ALB-Logs-Bucket wird mit `DeletionPolicy: Retain` und `UpdateReplacePolicy: Retain` gekennzeichnet — CloudFormation löscht es niemals, selbst wenn der Stack gelöscht wird. Das ist absichtlich (Audit-Trail-Schutz), aber bedeutet auch, dass es nicht als Teil des Cluster-Lifecycle gelten sollte. Eine separate Stack erlaubt es, den Cluster zu löschen ohne Sorgen um Datenverlust.

### EC2-Instanzen: Desired Capacity = 0, ECS Managed Scaling

Die `Ascalegroup` startet mit `DesiredCapacity: 0` (keine Instances beim Deployment). **Warum:**
- **ECS Capacity Provider mit Managed Scaling** überwacht die ECS-Task-Auslastung (Anzahl der Tasks im Cluster vs. verfügbare Kapazität).
- Wenn eine Task nicht eingeplant werden kann (keine verfügbaren Ressourcen), erhöht Capacity Provider `DesiredCapacity` automatisch.
- Wenn Kapazität unterlastet ist, reduziert es die Kapazität wieder.
- Das spart Kosten während der Entwicklung/Staging (0 Instances = $0 pro Stunde für EC2) und optimiert automatisch für Produktion.

**Alte Methode vs. neue Methode:**
| Alte Methode (nicht mehr aktiv) | Neue Methode (Capacity Provider) |
|----------------------------------|----------------------------------|
| `DesiredCapacity: 3` oder höher | `DesiredCapacity: 0` |
| Statische `AlarmAutoscaleScaleUp`/`ScaleDown` Step-Scaling-Alarme, permanent "In Alarm" wenn CPU niedrig | Interner ECS Managed Scaling, keine sichtbaren Alarme |
| Manuelle Tuning der Step-Scaling-Schwellwerte | Einziger Schwellwert: Target Capacity (Standard: 80%) |

### RDS und EFS: Encryption-by-Default

`StorageEncrypted: true` auf `Rdscl` und `Encrypted: true` auf `Efs` — beides unveränderliche Eigenschaften. **Warum:**
- Seit 2023 AWS-Best-Practice für jede Datenpersistenz.
- Kann nicht nachträglich auf einer bestehenden Cluster aktiviert werden — CloudFormation müsste die Ressource ersetzen (Downtime, Datenverlust).
- Eine neue Cluster deployt daher mit Encryption von Anfang an; bestehende Cluster, die aktualisiert werden, müssen eine Blue-Green-Migration durchführen (nicht im Template automatisiert).

### CloudWatch Monitoring und Dashboard

Die `ecscluster-vpc-rds-asg`-Vorlage enthält jetzt:
- **Metric Filters** für RDS (error log, slow query) und VPC Flow Logs (rejected traffic)
- **CloudWatch Alarms** auf diesen Filtern (Threshold=0 für RDS errors = sofort bei Problemen, Threshold=5 für slow queries, Threshold=500 für rejected connections)
- **CloudWatch Logs Insights Queries** (gespeichert) für Deep-Dive-Analyse:
  - `VpcFlowLogsRejectedTrafficQuery`: Top-N abgelehnte Connections nach Quell-IP und Zielport
  - `RdsErrorLogSummaryQuery`: RDS-Fehler der letzten 24h mit Frequenz
  - `RdsSlowQuerySummaryQuery`: Langsame Queries mit Execution Time, Lock Time, Rows
  - `DnsFirewallWhitelistCandidatesQuery`: DNS ALERT-Abfragen, gruppiert nach Domain für Whitelist-Review
  - `VpcEgressPortsAnalysis` (bedingt, nur wenn `EnableEgressAnalysis=true`): ACCEPT-Mode Flow Logs für Egress-Port-Baseline
- **CloudWatch Dashboard** (`ClusterDashboard`): visuell dargestellt, mit SEARCH-Ausdrücken für Per-Service CPU/Memory, RDS-Metriken, VPC-Ablehnung

**Warum nicht alles in SNS/Email-Alarmen:** Alarmverlauf ist ein Datenpunkt; echte forensische Arbeit erfordert die Raw-Log-Analyse. Gespeicherte Queries ermöglichen Konsistenz über Cluster hinweg und reduzieren Fehler durch manuelles Schreiben komplexer CloudWatch Insights-Syntax.

---

### Service-Autoscaling: Step Scaling mit zustandsbewusstem Scale-in-Alarm

Das `ecsservice`-Template nutzt **Step-Scaling** mit zwei expliziten CloudWatch-Alarmen:

- **`AlarmAutoscaleScaleUp`**: CPU > **65%** (3 Min.) → fügt einen Task hinzu. Im Normalbetrieb "OK".
- **`AlarmAutoscaleScaleDown`** (Metric-Math-Expression): feuert nur, wenn **beide** Bedingungen gelten:
  1. CPU < **15%** *und*
  2. mehr Tasks laufen als `ServiceDesiredCount` (gemessen über ALB `HealthyHostCount` der Service-TargetGroup)

  → entfernt einen Task pro Cooldown, bis die Baseline wieder erreicht ist. Im Normalbetrieb **"OK"** — nicht dauerhaft rot.

**Warum die kombinierte Bedingung:** Die Services laufen im Normalbetrieb bei <1% CPU. Ein reiner CPU-Schwellwert (CPU < 15%) ist damit *immer* wahr — der Scale-down-Alarm wäre permanent "In Alarm" und das Dashboard unbrauchbar (dasselbe Problem hätte Target Tracking: dessen automatisch erzeugter `AlarmLow` bei 90% des Targets ist nicht konfigurierbar). Die Zusatzbedingung "läuft überhaupt mehr als die Baseline?" macht den Alarm zustandsbewusst: Er ist nur rot, *während* ein Scale-in ansteht. Bleibt er länger rot, ist der Scale-in hängengeblieben — der Alarm ist damit gleichzeitig das Anomalie-Signal für "Extra-Tasks bleiben liegen".

**Warum `HealthyHostCount` statt ECS-Task-Metriken:** `RunningTaskCount`/`DesiredTaskCount` existieren nur in Container Insights (`ECS/ContainerInsights`), das im Cluster nicht aktiviert ist (kostet extra). Die ALB-Metrik zählt die registrierten, gesunden Tasks der TargetGroup und ist kostenlos. Wichtig: Verglichen wird gegen den **Parameter** `ServiceDesiredCount` (die Baseline/MinCapacity), nicht gegen die DesiredCount-Metrik — der Autoscaler hebt beim Scale-up den DesiredCount des Service an, eine Metrik-zu-Metrik-Differenz wäre daher immer 0.

**Verhalten bei Deployments:** Rolling Deployments (MaximumPercent 200%) verdoppeln kurz die HealthyHostCount. Der Alarm kann dabei kurz anschlagen; der Scale-down-Versuch ist dann ein No-op, weil die Kapazität bereits auf MinCapacity steht (Application Auto Scaling skaliert nie unter MinCapacity). `EvaluationPeriods: 5` überbrückt typische Deployment-Fenster.

**Operative Alarme (nur Sichtbarkeit, keine Scaling-Aktionen):** Zusätzlich erstellt das Template pro Service bis zu vier Alarme; jeder lässt sich per Threshold `0` deaktivieren:

| Alarm | Parameter | Default | Rationale |
|---|---|---|---|
| HighCpu | `ServiceHighCpuThreshold` | 20% | Baseline liegt bei <1–2%; 20% bedeutet "ernsthaft auffällig", lange bevor die 65%-Skalierung greift. |
| HighMemory | `ServiceHighMemoryThreshold` | 80% | Frühwarnung vor OOM-Kill; Wert anhand realer Nutzungsdaten gewählt (Services mit >80% waren Resize-Kandidaten). |
| LowCpu | `ServiceLowCpuThreshold` | 0 (aus) | Bei <1% CPU-Baseline würde jeder sinnvolle Schwellwert dauerhaft feuern. Opt-in. |
| LowMemory | `ServiceLowMemoryThreshold` | 0 (aus) | Für gezielte Right-Sizing-Reviews (überprovisionierte Services finden), nicht für Dauerbetrieb. Opt-in. |

Ergebnis: **Kein Alarm ist im gesunden Zustand rot.** Jeder rote Alarm bedeutet entweder ein laufendes Scaling-Ereignis oder ein echtes Problem.

---

## Templates

### ecscluster-vpc-rds-asg/guardduty

Erstellt einen GuardDuty Detector für Threat Detection sowie Quarantine-Infrastruktur für Zero-Trust-Incident-Response. **Ein Stack pro Region**, nicht pro Cluster (GuardDuty ist Account + Region).

Dieser Stack stellt die Grundlagen für Phase 1 und Phase 3 Step D bereit:

- **GuardDuty Detector**: Analysiert automatisch VPC Flow Logs, Route 53 DNS Logs und CloudTrail. Konfigurierbare Finding-Publishing-Häufigkeit (Standard: FIFTEEN_MINUTES für Echtzeit-Alerts).
- **Quarantine Security Group**: Zero Egress-Regeln — wird von Phase-3-Step-D-Automation verwendet, um kompromittierte Instances zu isolieren (von EventBridge + Lambda auf Basis von HIGH-Severity GuardDuty-Findings).
- **GuardDutyIncidentResponseRole**: IAM-Rolle mit Permissions zum Lesen von GuardDuty-Findings und zum Ändern von Instance-Security-Groups. Wird von der Phase-3-Step-D-Lambda verwendet.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterName` | Name des Clusters für Tagging (z. B. `labc-eu-w3`). Nutzt den Detector nicht: dient nur zur Identifikation und wird auch für die Quarantine-SG verwendet. |
| `FindingPublishingFrequency` | Wie oft GuardDuty neue Findings publiziert: `FIFTEEN_MINUTES` (Echtzeit, Default), `ONE_HOUR` (kosteneffizienter), `SIX_HOURS` (Batch-Modus). |

#### Exports

| Export | Beschreibung |
|---|---|
| `${AWS::StackName}-DetectorId` | GuardDuty Detector ID für EventBridge-Regeln (Phase 3 Step D). |
| `${AWS::StackName}-DetectorArn` | GuardDuty Detector ARN. |
| `${AWS::StackName}-QuarantineSgId` | Quarantine Security Group ID, die von der Phase-3-Step-D-Lambda verwendet wird. |
| `${AWS::StackName}-IncidentResponseRoleArn` | IAM-Rolle ARN für die Phase-3-Step-D-Lambda. |

#### Besonderheiten

- **VPC-Abhängigkeit**: Die Quarantine SG wird in der VPC des Clusters erstellt. Der Stack versucht, die VPC-ID aus `/${ClusterName}/vpc-id` SSM Parameter zu lesen — müsste ggf. mit der tatsächlichen VPC-ID übersteigt oder die Cluster-Vorlage muss die VPC-ID publizieren.
- **Costs**: GuardDuty hat 30 Tage kostenlos pro Region (Trial). Danach ca. $0.30–$1.50 pro Million Ingested Events, abhängig von Volume. Die GuardDuty Usage-Seite zeigt die projizierte Kosten in Echtzeit.

---

### ecscluster-vpc-rds-asg/alb-logs-bucket

Erstellt einen S3-Bucket für ALB-Zugriffslogs mit DSGVO-konformen Lifecycle-Regeln. **Separate Stack** (nicht Teil des Cluster-Stacks), damit das Bucket nicht gelöscht wird, wenn der Cluster-Stack gelöscht wird.

Dieser Stack speichert:
- **Lifecycle-Regel `DeleteLogs`**: Löscht aktuelle Versionen nach `RetentionDays` (Standard: 14 Tage)
- **Lifecycle-Regel `CleanupDeleteMarkers`**: Löscht verwaiste Löschmarker
- **Lifecycle-Regel `NoncurrentVersionExpiration`**: Löscht Noncurrent-Versionen 1 Tag nach sie noncurrent werden — dies verhindert unbegrenztes Wachstum durch Versionierung

**Warum separate Stack:**
- Audit-Trail-Schutz: ALB-Logs sollten länger als der Cluster selbst aufbewahrt werden
- `DeletionPolicy: Retain` auf dem Bucket bedeutet, CloudFormation wird es nie löschen, selbst wenn der Stack gelöscht wird
- Separat zu deployen erlaubt, den Cluster zu iterieren, ohne Sorgen um versehentliche Log-Löschung

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterName` | Cluster-Name für Bucket-Namespacing. Bucket wird `${ClusterName}-alb-logs` genannt. |
| `RetentionDays` | DSGVO-Aufbewahrungsfenster (Standard: 14 Tage). Nach N Tagen werden aktuelle Versionen gelöscht. |

#### Outputs

| Output | Beschreibung |
|---|---|
| `BucketName` | Der S3-Bucket-Name. Wird als `LogsBucketName`-Parameter in den Cluster-Stack übergeben. |

#### Besonderheiten

- **Versioning-Sicherheit**: Versioning ist aktiviert (Best Practice für Log-Trails), aber die Lifecycle-Regeln verhindern, dass noncurrent versions sich anhäufen. Ist wichtig: ohne `NoncurrentVersionExpiration` würde der Bucket still unbegrenzlich wachsen, selbst wenn die aktuelle Version gelöscht wird.
- **Bucket-Policy**: Erlaubt dem regionalen ELB-Log-Delivery-Service, Logs zu schreiben. Der Policy ist fest auf die Region des Stacks gebunden.

---

### ecscluster-vpc-rds-asg

Erstellt eine vollständige, eigenständige Infrastruktur für den Betrieb von ECS-Services. Dieser Stack umfasst:

- **VPC** mit öffentlichen und privaten Subnetzen über mehrere Availability Zones (AZs), inkl. NAT Gateway.
- **ECS-Cluster** (EC2 Launch Type).
- **Auto Scaling Group** für EC2-Instanzen (Standard: `t3.small`) — startet initial mit 0 Instanzen, ECS Managed Scaling skaliert automatisch bei Bedarf.
- **Application Load Balancer (ALB)** mit HTTPS-Listener.
- **RDS-Instanz** (Standard: `db.t3.medium`) innerhalb der VPC.
- **ECS Capacity Provider** mit verwalteter Skalierung (Zielkapazität: 80%).
- **AWS Backup** mit optionaler regionsübergreifender Kopie für RDS-Snapshots und EFS.
- **DNS Firewall** (Phase 1 Zero-Trust): Route 53 Resolver mit zwei Regeln (ALLOW Whitelist, ALERT Catch-all). Query Logging in CloudWatch für Analyse.
- **CloudWatch Monitoring**: Metric Filters für RDS (error, slow query) und VPC Flow Logs (rejected traffic), mit Alarmen und gespeicherten Insights-Queries für forensische Analyse.
- **CloudWatch Dashboard**: Vordefiniert mit SEARCH-Ausdrücken für Per-Service CPU/Memory, RDS-Metriken, VPC-Ablehnung.
- **Conditional Egress Analysis**: Parameter `EnableEgressAnalysis` aktiviert ACCEPT-Mode VPC Flow Logs und `VpcEgressPortsAnalysis` Query für Phase 3 Step A (Port-Audit). Standardmäßig aus, wird nur aktiviert, wenn gezielt deployiert.

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
| `DnsFirewallWhitelistDomains` | Komma-separierte Liste von Whitelist-Domains für DNS Firewall (z. B. `*.amazonaws.com,*.docker.com`). Wird in Phase 1 deployiert mit Defaults, in Phase 2 nach Whitelist-Analyse aktualisiert. |
| `LogsBucketName` | Bucket-Name für ALB-Zugriffslogs (z. B. `labc-eu-w3-alb-logs`). Leer lassen zum Deaktivieren. |
| `EnableEgressAnalysis` | `true` oder `false` (Standard: `false`). Aktiviert ACCEPT-Mode VPC Flow Logs und `VpcEgressPortsAnalysis` Query für Phase 3 Step A. Sollte nur während des Port-Audit-Fensters (7–14 Tage) aktiviert sein. |

#### Exports

| Export | Beschreibung |
|---|---|
| `${AWS::StackName}-Ecscluster` | Name des ECS-Clusters. |
| `${AWS::StackName}-ListenerArnHttps` | ARN des HTTPS-Listeners des ALB. |
| `${AWS::StackName}-ListenerArnHttp` | ARN des HTTP-Listeners des ALB. |
| `${AWS::StackName}-Vpc` | ID der VPC. |
| `${AWS::StackName}-Efs` | ID des EFS-Dateisystems. |
| `${AWS::StackName}-LoadbalancerArn` | ARN des Application Load Balancers. |
| `${AWS::StackName}-DnsFirewallRuleGroupId` | DNS Firewall Rule Group ID (benötigt für Phase 3 Step D EventBridge-Regeln und Phase 4 Rollback-Befehl). |
| `${AWS::StackName}-DnsFirewallWhitelistId` | Whitelist Domain List ID (benötigt für Phase 2 Whitelist-Updates). |
| `${AWS::StackName}-SubnetPrivate1`, `SubnetPrivate2` | Interne Subnets (für weitere RDS/VPN-Konfiguration). |

#### Design Notes: Warum ECS Managed Scaling statt statischer Kapazität

Das Cluster startet mit `AscalegroupDesSize: 0`. **Warum:**

1. **Kosten in Entwicklung**: 0 Instanzen = $0 Compute-Kosten bei Nicht-Nutzung. `ecsservice`-Stacks starten Tasks nach Bedarf; der Cluster skaliert dazu hoch.
2. **Automatische Optimierung**: ECS Capacity Provider beobachtet den `MemoryReservation` des Clusters. Wenn Tasks nicht eingeplant können (zu wenig RAM/CPU), erhöht es `DesiredCapacity`. Wenn Kapazität unterlastet (z. B. nachts), senkt es es wieder.
3. **Keine sichtbaren Alarme**: Step Scaling erzeugt permanente `AlarmAutoscaleScaleDown`-Alarme, die "In Alarm" sind sobald CPU niedrig ist (=normal) — rauschig für Monitoring. Managed Scaling nutzt interne Metriken, keine sichtbaren Alarme.

**Alte vs. neue Methode:**
- Alt: `DesiredCapacity: 3`, `AlarmAutoscaleScaleDown` wenn CPU < 15%, `AlarmAutoscaleScaleUp` wenn CPU > 65% → permanente Alarme
- Neu: `DesiredCapacity: 0`, Capacity Provider passt automatisch an (Metric: `MemoryReservation` vs. 80% Target) → saubere Alarme, besserer Cost Control

---



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

### ecsservice

Dient zur Bereitstellung eines einzelnen ECS-Services auf einem Cluster, der mit `ecscluster-vpc-rds-asg` erstellt wurde. Der Stack umfasst:

- **ECS Task Definition** (Einzelcontainer mit EFS-Mount und Doppler-Secret-Injektion).
- **ECS Service** mit ALB-Integration.
- **ALB Listener Rule** basierend auf Hostname und Pfad.
- **Autoscaling** auf Task-Ebene via Target-Tracking-Policy (Ziel: durchschnittliche CPU-Auslastung, siehe [Designentscheidung](#service-autoscaling-target-tracking-statt-step-scaling)).
- **Operative CloudWatch-Alarme** (HighCpu, HighMemory, optional LowCpu/LowMemory) — reine Sichtbarkeit, keine Scaling-Trigger.
- **EFS Access Point** für persistenten Speicher.
- **IAM-Rollen** für Task und Service.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterStackName` | Name des bestehenden CloudFormation-Stacks des Clusters. |
| `ListenerRuleHost` | Hostname für die ALB-Listener-Regel. |
| `InitialDockerImage` | Docker-Image für das initiale Deployment. |
| `SkipImageResolver` | `true` (Standard): `InitialDockerImage` wird direkt verwendet — für Stack-Erstellung und solange das erste Deployment noch nicht stabil läuft. Nach erfolgreichem Service-Start auf `false` setzen, damit Stack-Updates das Image vom laufenden Service übernehmen (verhindert Rollback auf veraltete Images). |
| `TaskMemory` | Soft Limit für den Arbeitsspeicher pro Task in MB (`478`, `956`, `1434` oder `1913` — so gewählt, dass 4, 2 bzw. 1 Task exakt auf eine `t3.small`-Instanz passen). |
| `ProjectNameShort` | Projekt-Kurzname (Format: `xxx_xxx_xxx`) für die Doppler-Zuordnung. |
| `ServiceDesiredCount` | Gewünschte Anzahl der Task-Instanzen (entspricht auch dem Minimum für Autoscaling; im Normalbetrieb laufen exakt so viele Tasks). |
| `ServiceMaxCapacity` | Maximale Anzahl der Task-Instanzen für Autoscaling. |
| `ServiceScaleUpCpuThreshold` | CPU-Schwellwert (%) für automatisches Scale-up (Standard: `65`). |
| `ServiceScaleDownCpuThreshold` | CPU-Schwellwert (%) für automatisches Scale-down — greift nur, solange mehr Tasks als `ServiceDesiredCount` laufen (Standard: `15`). |
| `ServiceHighCpuThreshold` | Schwellwert (%) für den HighCpu-Alarm (Standard: `20`; `0` = deaktiviert). |
| `ServiceHighMemoryThreshold` | Schwellwert (%) für den HighMemory-Alarm (Standard: `80`; `0` = deaktiviert). |
| `ServiceLowCpuThreshold` | Schwellwert (%) für den LowCpu-Alarm (Standard: `0` = deaktiviert; Opt-in für Right-Sizing-Reviews). |
| `ServiceLowMemoryThreshold` | Schwellwert (%) für den LowMemory-Alarm (Standard: `0` = deaktiviert; Opt-in für Right-Sizing-Reviews). |
| `ECSHealthCheckGracePeriod` | Wartezeit in Sekunden, bevor ECS den Health-Check startet (Standard: `0`). |
| `ServiceTrafficPort` | Port, auf dem der Container Traffic entgegennimmt (Standard: `443`). |
| `ServiceTrafficProtocol` | Protokoll des Containers (`HTTP` oder `HTTPS`, Standard: `HTTPS`). |
| `ECSHealthCheckPath` | Pfad für den Health-Check (Standard: `/test.php`). |
| `VolumeMountPath` | Pfad im Container, an dem das EFS-Volume gemountet wird (Standard: `/var/www/html_data`). |
| `ProjectEnv` | Umgebung des Projekts für Doppler-Konfiguration (Standard: `prd`). |
| `ProjectToken` | Doppler Service-Token (Read-only) für die Secret-Injektion. |
| `ContainerCommand` | Startbefehl für den Container als kommaseparierte Liste (z. B. `python,app.py`). Leer lassen für den Image-Standard. |
| `ListenerRulePriority` | Priorität der Listener-Regel (muss eindeutig pro Listener sein). |

#### Exports

| Export | Beschreibung |
|---|---|
| `${AWS::StackName}-TargetGroupArn` | ARN der TargetGroup. |

---

### alb-ecsservice-rule

Verbindet einen Hostnamen und Pfad mit der Targetgroup eines bestehenden ECS-Services. Dieser Stack umfasst:

- **ALB Listener Rule (HTTP)**: Leitet eingehende HTTP-Anfragen basierend auf Hostname und Pfad zur Targetgroup des ECS-Services weiter.
- **ALB Listener Rule (HTTPS)**: Leitet eingehende HTTPS-Anfragen basierend auf Hostname und Pfad zur Targetgroup des ECS-Services weiter.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterStackName` | Name des bestehenden CloudFormation-Stacks des Clusters, dessen ALB-Listener verwendet werden. |
| `EcsServiceStackName` | Name des bestehenden CloudFormation-Stacks des ECS-Services, dessen TargetGroup verwendet wird. |
| `ListenerRuleHost` | Hostname, auf den die Listener-Regel reagiert (z. B. `www.example.com`). |
| `ListenerRulePath` | Pfadmuster für die Listener-Regel (Standard: `*`). |
| `ListenerRulePriority` | Priorität der Listener-Regel (muss eindeutig pro Listener sein). |

---

### alb-redirect-rule

Erstellt eine URL-Redirect-Regel auf dem Application Load Balancer (ALB) eines bestehenden Clusters. Der Stack umfasst:

- **ALB Listener Rule (HTTP)**: Leitet eingehende HTTP-Anfragen basierend auf Hostname und Pfad automatisch zu HTTPS (Port 443) weiter.
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

### cloudfront-alb-distribution

Erstellt eine CloudFront-Distribution, die eingehenden Traffic für eine Domain an einen Application Load Balancer (ALB) weiterleitet. Der Stack umfasst:

- **CloudFront Distribution** mit HTTP/2+3, IPv6, SNI-only TLS (mind. TLSv1.2) und konfigurierbarer Price Class.
- **WAF WebACL** (Scope: `CLOUDFRONT`, optional) mit AWS Managed Rules (Common Rule Set, Known Bad Inputs, IP Reputation List) sowie Rate Limiting (2.000 Anfragen/IP/5 min). Kann über den Parameter `EnableWAF` deaktiviert werden (z. B. für Staging-Umgebungen).
- **Custom Cache Policy**: Respektiert Cache-Control-Header des ALB, alle Query Strings im Cache-Key, schließt jedoch alle Cookies vom Cache-Key aus. Leitet zudem spezifische Header (`Host`, `Origin`, `X-Method-Override`, `X-HTTP-Method`, `X-HTTP-Method-Override`) an den Origin weiter und bezieht diese in den Cache-Key ein.
- **AWS-managed Origin Request Policy** (`AllViewer`): Leitet alle Viewer-Header inkl. `Host`-Header, alle Cookies und Query Strings an den ALB weiter — erforderlich, da der ALB anhand des `Host`-Headers routet.
- **AWS-managed Response Headers Policy** (`SecurityHeadersPolicy`): Setzt Security-Header (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, X-XSS-Protection).
- **Origin Verify Header**: Ein konfigurierbarer Custom-Header, der an den ALB weitergeleitet wird, um sicherzustellen, dass nur CloudFront-Anfragen den ALB erreichen.

> **Hinweis:** Das ALB-Zertifikat muss den im Parameter `DomainName` angegebenen Domain-Namen abdecken (SAN oder Wildcard), da CloudFront den originalen `Host`-Header weiterleitet.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `DomainName` | Der vollqualifizierte Domain-Name (FQDN), der über diese Distribution ausgeliefert wird (z. B. `www.example.com`). Muss mit dem ACM-Zertifikat übereinstimmen. |
| `AcmCertificateArn` | ARN des ACM-Zertifikats für die Domain. **Muss in `us-east-1` liegen** (CloudFront-Anforderung). |
| `AlbDnsName` | DNS-Name des Application Load Balancers als Origin (z. B. `my-alb-123456789.eu-central-1.elb.amazonaws.com`). |
| `OriginVerifyHeader` | Name des Custom-Headers zur ALB-Absicherung (Standard: `X-Origin-Verify`). |
| `OriginVerifyValue` | Geheimer Wert für den `OriginVerifyHeader`. ALB-Listener-Rules sollten nur Anfragen mit diesem Header/Wert durchlassen. |
| `PriceClass` | CloudFront Price Class, bestimmt die genutzten Edge Locations. `PriceClass_100`: Nordamerika & Europa (günstigste Option, Standard). `PriceClass_200`: Nordamerika, Europa, Asien, Naher Osten & Afrika. `PriceClass_All`: Alle Edge Locations weltweit (höchste Abdeckung, höchste Kosten). |
| `EnableWAF` | WAF WebACL aktivieren (`true`, Standard) oder deaktivieren (`false`). Bei Deaktivierung entfallen die WAF-Kosten (~$9/Monat Fixkosten), jedoch auch der Schutz vor SQLi, XSS, bekannten Bad Inputs, IP-Reputation-Filterung und Rate Limiting. AWS Shield Standard (DDoS-Basisschutz) bleibt immer aktiv. Empfohlen: `true` für Produktionsumgebungen. |

#### Outputs

| Output | Beschreibung |
|---|---|
| `DistributionId` | ID der erstellten CloudFront-Distribution. |
| `DistributionDomainName` | CloudFront-Domain-Name der Distribution (z. B. `d1234abcdef.cloudfront.net`). Einen CNAME- oder ALIAS-Eintrag für die eigene Domain auf diesen Wert setzen. |

---

### global-accelerator-alb

Erstellt einen AWS Global Accelerator mit einem Application Load Balancer (ALB) als Endpoint. Der Stack umfasst:

- **Global Accelerator** mit zwei statischen Anycast-IPv4-Adressen, die direkt als **A-Records** in beliebigen externen DNS-Providern eingetragen werden können — ohne CNAME-Abhängigkeit.
- **Listener** für TCP auf Port 80 und 443 mit konfigurierbarer Client-Affinität.
- **Endpoint Group** in der Stack-Region mit dem ALB als Endpoint und aktivierter Client-IP-Weiterleitung.

> **Hinweis:** Global Accelerator ist ein globaler Service und wird immer in `us-west-2` (Oregon) verwaltet, unabhängig von der Stack-Region. Die Endpoint Group wird jedoch in der gewählten Stack-Region erstellt.

#### Wichtige Parameter

| Parameter | Beschreibung |
|---|---|
| `ClusterStackName` | Name des CloudFormation-Stacks des Clusters (`ecscluster-vpc-rds-asg`), dessen ALB als Endpoint registriert wird. |
| `EndpointWeight` | Gewichtung des ALB-Endpoints (0–255). Relevant bei mehreren Endpoints in einer Gruppe. Standard: `128`. |
| `ClientAffinityEnabled` | Client-Affinität (Sticky Sessions) basierend auf der Quell-IP. `SOURCE_IP`: gleiche Client-IP wird konsistent an denselben Endpoint geleitet. `NONE`: keine Affinität (Standard). |

> **Hinweis:** Der Stack kann in derselben Region wie der ALB deployt werden — ein Deployment in `us-east-1` ist, anders als bei CloudFront, nicht erforderlich.

#### Outputs

| Output | Beschreibung |
|---|---|
| `AcceleratorArn` | ARN des erstellten Global Accelerators. |
| `AcceleratorDnsName` | DNS-Name des Global Accelerators (z. B. `xxxxxxxxxxxxxxxx.awsglobalaccelerator.com`). |
| `StaticIp1` | Erste statische Anycast-IPv4-Adresse — direkt als A-Record eintragen. |
| `StaticIp2` | Zweite statische Anycast-IPv4-Adresse — direkt als A-Record eintragen. |

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

### Template-Versionierung

Das `ecsservice`-Template trägt seine Version als Stack-Output `TemplateVersion` (aktuell `1.0.0`). Bei jeder inhaltlichen Template-Änderung wird die Version im Template mit angehoben — der Output wird beim nächsten Stack-Update automatisch gestempelt und zeigt damit, welcher Template-Stand auf welchem Stack deployt ist.

Deployte Versionen aller Service-Stacks einer Region auf einen Blick (CloudShell):

```bash
aws cloudformation describe-stacks --region eu-west-3 \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName, version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" \
  --output table
```

Stacks ohne `TemplateVersion`-Output (Anzeige `None`) laufen auf einem Template-Stand vor Einführung der Versionierung (< 1.0.0). Der Filter auf `TargetGroupArn` begrenzt die Liste auf ecsservice-Stacks.

---

## Deployment & Operations

### Cluster-Rollout-Reihenfolge

Neue Region oder Cluster-Update? Folgendes Deployment-Pattern hat sich bewährt:

1. **`guardduty` Stack** (neue Region)
   ```bash
   aws cloudformation create-stack \
     --stack-name labc-eu-c1-guardduty \
     --template-body file://ecscluster-vpc-rds-asg/guardduty/index.template \
     --parameters \
       ParameterKey=ClusterName,ParameterValue=labc-eu-c1 \
       ParameterKey=ClusterStackName,ParameterValue=labc-eu-c1 \
       ParameterKey=FindingPublishingFrequency,ParameterValue=FIFTEEN_MINUTES \
     --region eu-central-1
   ```

2. **`ecscluster-vpc-rds-asg` Stack** (neue Region oder Update)
   - Phase 1 läuft im ALERT-Modus (kein Blocking)
   - Erst nach Phase 2 (Whitelist verfeinert) auf BLOCK-Modus wechseln

3. **`alb-logs-bucket` Stack** (neue Region)
   - Output `BucketName` wird in Cluster-Stack als `LogsBucketName` verwendet

4. **`ecsservice` Stack(s)** auf dem Cluster (nach Bedarf)

### Zero-Trust Rollout: Was Wann Tun

**Phase 1 (Woche 1–2):** DNS Firewall ALERT-Modus, GuardDuty sammelt Baseline

**Phase 2 (nach Tag 7):** DNS-Whitelist verfeinern, `DnsFirewallWhitelistDomains` updaten

**Phase 3 (nach Phase 2 validiert):** 
- Step A: `EnableEgressAnalysis=true`, Port-Baseline sammeln
- Step B: NTP-Konfiguration prüfen
- Step C: Security Group explizite Egress-Regeln, `EnableEgressAnalysis=false`
- Step D: Lambda + EventBridge für Quarantine-Automation

**Phase 4 (nach Step D validiert):** DNS Firewall ALERT → BLOCK, Apps testen, 48h monitoren

### Häufige Operational Tasks

**RDS-Fehler der letzten 24h:** `RdsErrorLogSummaryQuery` in CloudWatch Logs Insights

**Welche egress Ports benutzt meine App?** Phase 3 Step A: `EnableEgressAnalysis=true` → 7–14 Tage → `VpcEgressPortsAnalysis` Query

**Wurde Traffic blockiert?** Filter `action = "BLOCK"` in `DnsQueryLoggingGroup`

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
