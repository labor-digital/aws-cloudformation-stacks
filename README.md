# AWS CloudFormation Stacks

Dieses Repository enthält die AWS CloudFormation Stack-Templates, die von LABOR für die Bereitstellung von Infrastruktur und Anwendungen verwendet werden.

Parameter sind nicht hier dokumentiert: jeder Parameter trägt im Template eine `Description` und ist über `AWS::CloudFormation::Interface` gruppiert, die Konsole zeigt beides beim Deployment an. Diese Datei beschreibt **Zweck, Abhängigkeiten und Best Practices** pro Template. Offene Aufgaben und laufende Rollouts stehen in [TASKS.md](TASKS.md), die Änderungshistorie in [CHANGELOG.md](CHANGELOG.md).

---

## Übersicht

| Template | Zweck |
|---|---|
| `ecscluster-vpc-rds-asg` | Vollständiger ECS-Cluster: VPC, RDS Aurora, ASG, ALB, EFS, AWS Backup, DNS Firewall, CloudWatch-Monitoring. |
| `ecscluster-vpc-rds-asg/alb-logs-bucket` | S3-Bucket für ALB-Zugriffslogs mit DSGVO-Lifecycle. Separater Stack, Bucket überlebt Stack-Löschung. |
| `ecscluster-vpc-rds-asg/guardduty` | GuardDuty Detector, Quarantine-SG und Incident-Response-Rolle. Ein Stack pro Region. |
| `ecscluster-vpc-rds-asg/backup-vaults-mirror` | Backup-Vaults in der Zielregion für regionsübergreifende Backup-Kopien. |
| `ecsservice` | Ein containerisierter Service auf einem bestehenden Cluster. |
| `alb-ecsservice-rule` | Zusätzliche Host/Pfad-Regel auf die TargetGroup eines bestehenden ECS-Service. |
| `alb-redirect-rule` | URL-Redirect-Regel auf dem ALB eines bestehenden Clusters. |
| `alb-additional-certificate` | ACM-Zertifikat und Zuweisung als zusätzliches Zertifikat am HTTPS-Listener. |
| `certificate` | Eigenständiges ACM-Zertifikat mit DNS-Validierung. |
| `cloudfront-alb-distribution` | CloudFront-Distribution vor einem ALB, inkl. WAF WebACL. |
| `global-accelerator-alb` | Global Accelerator mit zwei statischen Anycast-IPv4-Adressen vor einem ALB. |

> `ecscluster-ext-additional-cluster` ist veraltet und wird nicht mehr unterstützt.

---

## Abhängigkeiten und Deployment-Reihenfolge

Pro Region in dieser Reihenfolge:

1. **`alb-logs-bucket`** — liefert `BucketName` für den `LogsBucketName`-Parameter des Clusters. Alternativ den Cluster zuerst mit leerem `LogsBucketName` deployen und den Wert später nachziehen.
2. **`ecscluster-vpc-rds-asg`** — der Cluster selbst.
3. **`ecscluster-vpc-rds-asg/guardduty`** — **nach** dem Cluster, nicht davor: die Quarantine-SG importiert `${ClusterStackName}-Vpc`.
4. **`ecscluster-vpc-rds-asg/backup-vaults-mirror`** — in der Zielregion (`BackupCopyDestinationRegion`, Default `eu-north-1`). Muss existieren, bevor Backup-Kopien greifen.
5. **`ecsservice`** — pro Anwendung.
6. Optional: `alb-ecsservice-rule`, `alb-redirect-rule`, `alb-additional-certificate`, `cloudfront-alb-distribution`, `global-accelerator-alb`.

**Cross-Stack-Kontrakt.** Die Abhängigkeiten laufen ausschließlich über CloudFormation-Exports:

| Export | Erzeugt von | Genutzt von |
|---|---|---|
| `${Cluster}-Ecscluster` | Cluster | `ecsservice` |
| `${Cluster}-Vpc` | Cluster | `ecsservice`, `guardduty` |
| `${Cluster}-Efs` | Cluster | `ecsservice` |
| `${Cluster}-ListenerArnHttp` / `-ListenerArnHttps` | Cluster | `ecsservice`, `alb-ecsservice-rule`, `alb-redirect-rule`, `alb-additional-certificate` |
| `${Cluster}-LoadbalancerArn` | Cluster | `ecsservice` (Scale-in-Alarm), `global-accelerator-alb` |
| `${Cluster}-SubnetPrivate1` / `-SubnetPrivate2` | Cluster | weitere RDS/VPN-Konfiguration |
| `${Cluster}-SgVpcLoadbalancerportsAccess` | Cluster | zusätzliche Instanzen mit ALB-Zugriff |
| `${Cluster}-DnsFirewallWhitelistId` / `-DnsFirewallRuleGroupId` | Cluster | Phase-2-Whitelist-Updates, Phase-3-Automation |
| `${Service}-TargetGroupArn` | `ecsservice` | `alb-ecsservice-rule` |
| `${GuardDuty}-DetectorId` / `-QuarantineSgId` / `-IncidentResponseRoleArn` | `guardduty` | Phase-3-Step-D-Automation |
| `${Cert}-CertificateArn` | `certificate`, `alb-additional-certificate` | manuelle Zuweisung |

Ein Stack lässt sich nicht löschen, solange ein anderer seine Exports importiert. Beim Entfernen von Exports zuerst prüfen, ob externe Stacks sie referenzieren.

---

## Templates

### ecscluster-vpc-rds-asg

Vollständige, eigenständige Infrastruktur für den Betrieb von ECS-Services: VPC mit öffentlichen und privaten Subnetzen über zwei AZs samt NAT Gateway, ECS-Cluster (EC2 Launch Type), Auto Scaling Group mit ECS Managed Scaling, ALB mit HTTP- und HTTPS-Listener, Aurora-MySQL-Cluster, EFS, AWS Backup mit optionaler Regionskopie, Route 53 DNS Firewall, VPC Flow Logs, CloudWatch-Alarme mit gespeicherten Logs-Insights-Queries und ein Overview-Dashboard.

**Best Practices**

- **Jedes Stack-Update zeigt vier Zeilen AMI-Kaskade — das ist kein Drift.** `ImageId` ist eine SSM-Dynamic-Reference auf die aktuelle ECS-optimized AMI, die CloudFormation bei jedem Update neu auflöst. Im Change Set erscheinen dann `Launchtemplate` (`DirectModification`, `RequiresRecreation: Never`) und als Folge `Ascalegroup`, `CapacityProvider`, `EcsclusterCapacityProviderAssociation` — die letzten zwei mit `Replacement: Conditional`. Es wird nichts neu erstellt: das Launch Template bekommt eine neue Version, die ASG wird in-place aktualisiert, ihre ARN bleibt stabil. Laufende Instanzen bleiben unberührt, die neue AMI greift erst bei künftigen Launches. Unterscheiden lässt sich das über `ChangeSource` im Change Set: nur `DirectModification` stammt aus dem Template, `ResourceAttribute`/`ResourceReference` sind Folgeänderungen.
- **`AscalegroupDesSize` auf `0` lassen.** ECS Managed Scaling (Target Capacity 80 %) startet Instanzen, wenn Tasks Kapazität brauchen, und fährt sie wieder herunter. Ein leerer Cluster kostet keine EC2-Stunden.
- **`EnableEgressAnalysis` ist temporär.** Aktiviert ACCEPT-Mode Flow Logs für die Phase-3-Step-A-Port-Baseline. Fenster 7–14 Tage, danach zurück auf `false` — ACCEPT-Logs werden pro GB abgerechnet und dominieren sonst die Logging-Kosten.
- **`TemplateVersion`-Output (`1.0.0`) prüfen, statt Git-Historie zu rekonstruieren:** `aws cloudformation describe-stacks --stack-name <cluster> --query "Stacks[0].Outputs[?OutputKey=='TemplateVersion'].OutputValue" --output text`. Kein Output = Stand vor Einführung des Stempels.
- **`BackupRetentionPeriod` steht auf 1 Tag.** Automatische Aurora-Snapshots decken damit nur 24 h ab; alles darüber kommt aus dem AWS-Backup-Vault (6h-Rhythmus, 35 Tage).
- **Alle Log-Gruppen haben 14 Tage Retention (DSGVO).** Das begrenzt jede forensische Analyse auf zwei Wochen — Auswertungen also innerhalb des Fensters fahren, nicht „irgendwann".
- **DNS Firewall läuft im ALERT-Modus.** Der Catch-all ist hartcodiert auf `ALERT`; die Umstellung auf `BLOCK` ist Phase 4 und braucht zuerst eine vollständige Whitelist (siehe TASKS.md). Registry-Domains nicht vergessen, sonst schlägt der Image-Pull beim nächsten Task-Placement fehl.
- **RDS-Logs:** `error` und `slowquery` werden nach CloudWatch exportiert, Schwelle ist `long_query_time` (Engine-Default 10 s). Für einen vollständigen Query-Trace `long_query_time = 0` setzen (dynamisch, kein Reboot) — dann aber `RdsSlowQueryAlarm` (>5/5 Min.) vorübergehend anheben, sonst ist er sofort rot. Der General Log ist keine bessere Wahl: gleiche Statements, aber ohne `Query_time`/`Rows_examined`. Ergebniszeilen enthält keines der beiden Logs.

**EFS-Restore**

AWS Backup sichert das EFS alle 6 h (35 Tage, `${Cluster}-BackupVault`) und wöchentlich (365 Tage, `${Cluster}-BackupLongTermVault`). Der schnellste Weg nutzt zwei Eigenschaften des Stacks: die UserData mountet die **Wurzel** des Dateisystems auf jeder Instanz unter `/mnt/efs`, und die Instanzrolle hat `AmazonSSMManagedInstanceCore`. Kein neues Dateisystem, kein Mount-Target, kein Bastion — und da kein Port-22-Ingress existiert, ist SSM ohnehin der einzige Shell-Zugang.

1. Recovery Point wählen: `aws backup list-recovery-points-by-backup-vault --backup-vault-name <cluster>-BackupVault`
2. Restore starten (Konsole ist am einfachsten): *Item-level* mit bis zu 5 relativen Pfaden (`/<service-stack-name>` = die `RootDirectory`, die jeder `ecsservice`-Stack mountet) oder *Full*. Ziel: **existierendes Dateisystem**, nicht ein neues.
3. Restore-Rolle: **Default role**. `BackupRole` aus dem Template kann nicht restoren (nur `...ForBackup`, kein `...ForRestores`).
4. Zugriff: `aws ssm start-session --target <instance-id>`, dann `sudo ls /mnt/efs/aws-backup-restore_*`

AWS Backup überschreibt beim EFS-Restore nie, sondern legt immer ein neues Verzeichnis `aws-backup-restore_<timestamp>/` in der Wurzel an — der Restore ist zerstörungsfrei. Verzeichnis danach löschen, es kostet EFS-Storage.

- Bei `AscalegroupDesSize=0` und leerem Cluster gibt es keine Instanz zum Verbinden — Desired temporär auf 1 setzen.
- Ein Recovery Point aus dem `eu-north-1`-Mirror lässt sich nicht direkt in die Quellregion restoren; erst zurückkopieren. Der Mirror ist für Regionsverlust, nicht für Bequemlichkeit.
- **Daten nicht durch den SSM-Tunnel herunterladen** — der ist ein Control Channel (WebSocket über den SSM-Service) und für Bulk-Transfer ungeeignet. Stattdessen über S3, ohne Zwischenkopie auf das EBS-Volume: temporäre `s3:PutObject`-Policy auf `<cluster>-Instancerole`, dann `sudo tar -C /mnt/efs/aws-backup-restore_<ts>/<stack> -cf - . | zstd -T0 -3 | aws s3 cp - s3://<bucket>/restore/<stack>.tar.zst` und lokal per `aws s3 cp` als Multipart herunterladen. `tar` bündelt viele kleine Dateien zu einem Stream — auf EFS meist der eigentliche Engpass. Ohne S3-Gateway-Endpoint läuft der Upload über das NAT Gateway und kostet Data Processing.
- Ist EFS der Engpass, `ThroughputMode` und `BurstCreditBalance` prüfen — aufgebrauchtes Guthaben deckelt auf ~50 KiB/s pro GiB. `t3.small` limitiert Netz und EBS zusätzlich; für große Restores lohnt eine temporäre größere Instanz mit `SgVpcEfsAccess` (`EC2InstanceType` nicht ändern, dort sind nur `t3.small`/`t3.micro` erlaubt).
- Sollen die Daten nur zurück in ein Service-Verzeichnis: `sudo cp -a /mnt/efs/aws-backup-restore_<ts>/<stack>/… /mnt/efs/<stack>/…` bleibt komplett innerhalb EFS.

---

### ecscluster-vpc-rds-asg/alb-logs-bucket

S3-Bucket für ALB-Zugriffslogs (`${ClusterName}-alb-logs`), separat vom Cluster deployt.

**Abhängigkeiten:** keine. Output `BucketName` wird als `LogsBucketName` in den Cluster-Stack übergeben.

**Best Practices**

- **Separater Stack mit Absicht.** `DeletionPolicy: Retain` und `UpdateReplacePolicy: Retain` — CloudFormation löscht den Bucket nie, auch nicht beim Löschen des Stacks. So lässt sich der Cluster iterieren, ohne den Audit-Trail zu riskieren.
- **Lifecycle deckt alle drei Fälle ab:** `DeleteLogs` (aktuelle Versionen nach `RetentionDays`, Default 14, plus `NoncurrentVersionExpiration` nach 1 Tag), `CleanupDeleteMarkers` und `AbortIncompleteMultipartUploads` nach 7 Tagen. Ohne die Noncurrent-Regel würde der Bucket trotz Versionierung unbegrenzt wachsen und die DSGVO-Obergrenze aushebeln.
- **Bucket-Policy ist regionsgebunden** (ELB-Log-Delivery-Service-Principal). Pro Region ein Bucket.
- ALB-Logging ist kein Selbstläufer: `access_logs.s3.enabled` kann `true` sein, während die Lieferung an der Bucket-Policy scheitert. Nach dem Aktivieren prüfen, ob unter `<prefix>/AWSLogs/<account>/elasticloadbalancing/<region>/` tatsächlich Objekte auftauchen.

---

### ecscluster-vpc-rds-asg/guardduty

GuardDuty Detector, Quarantine Security Group (null Egress-Regeln) und Incident-Response-IAM-Rolle. Grundlage für Phase 1 und Phase 3 Step D.

**Abhängigkeiten:** importiert `${ClusterStackName}-Vpc` für die Quarantine-SG — **muss also nach dem Cluster deployt werden.** Exportiert `DetectorId`, `DetectorArn`, `QuarantineSgId`, `IncidentResponseRoleArn`.

**Best Practices**

- **Ein Stack pro Region, nicht pro Cluster.** GuardDuty erlaubt genau einen Detector pro Account und Region. Läge er im Cluster-Template, würde das Löschen eines Cluster-Stacks die Threat Detection der gesamten Region abschalten. Vor dem Deployment prüfen: `aws guardduty list-detectors` — existiert schon einer, schlägt die Erstellung fehl.
- **`--capabilities CAPABILITY_NAMED_IAM` ist erforderlich** (die Incident-Response-Rolle hat einen expliziten `RoleName`).
- **Nach dem Deployment die Data Sources verifizieren:** `CLOUD_TRAIL`, `DNS_LOGS`, `FLOW_LOGS` müssen `ENABLED` sein. GuardDuty liest diese Streams aus AWS-internen Kopien, nicht aus unseren Log-Gruppen — Detection funktioniert also auch dort, wo unser Flow Log nur `REJECT` erfasst.
- **Findings-Pipeline mit Sample-Findings testen:** `aws guardduty create-sample-findings --detector-id <id> --finding-types Recon:EC2/PortProbeUnprotectedPort`, dann `list-findings` (Propagation dauert 1–2 Minuten) und anschließend `archive-findings`, damit die Testdaten das echte Signal nicht verwässern.
- **Findings benachrichtigen aktuell niemanden** — sie stehen nur in der Konsole (offener Punkt in TASKS.md).
- Root-Console-Zugriffe erzeugen wiederkehrend `Policy:IAMUser/RootCredentialUsage`. Eine IAM-Identität für den Account-Inhaber hält das Signal sauber.

---

### ecscluster-vpc-rds-asg/backup-vaults-mirror

Backup-Vaults in der Zielregion für regionsübergreifende Kopien: `${ClusterName}-BackupVault-Mirror` und `${ClusterName}-BackupLongTermVault-Mirror`.

**Best Practices**

- In der **Zielregion** deployen (`BackupCopyDestinationRegion` des Clusters, Default `eu-north-1`), bevor Kopien erwartet werden — sonst schlagen die Copy-Actions des Backup-Plans fehl.
- Der Mirror ist für Regionsverlust. Ein Restore daraus in die Quellregion braucht erst eine Rückkopie des Recovery Points.

---

### ecsservice

Ein containerisierter Service auf einem bestehenden Cluster: Task Definition (Einzelcontainer, EFS-Mount, Doppler-Secret-Injektion), ECS Service mit ALB-Integration, Listener-Regeln für HTTP (Redirect auf HTTPS) und HTTPS, Step-Scaling-Autoscaling, operative CloudWatch-Alarme, Log-Gruppe mit Anomaly Detector und eine ImageResolver-Lambda.

**Abhängigkeiten:** importiert `${ClusterStackName}-Ecscluster`, `-Vpc`, `-Efs`, `-ListenerArnHttp`, `-ListenerArnHttps`, `-LoadbalancerArn`. Exportiert `${AWS::StackName}-TargetGroupArn`. Aktuelle Template-Version: **`1.0.1`**.

**Best Practices**

- **Vor einem Template-Wechsel den Drift reduzieren.** Ein Service-Stack driftet normalerweise nur in der Task Definition. Schlägt ein Update fehl, rollt CloudFormation auf die letzte bekannte Konfiguration zurück — deren Docker-Image kann sehr alt oder gar nicht mehr vorhanden sein. Vorgehen: Drift erkennen, Abweichungen jenseits der Task Definition manuell zurücksetzen, den Stack **ohne** Template-Austausch mit `InitialDockerImage` = aktuell laufendes Image aktualisieren, und erst danach das Template ersetzen.
- **`SkipImageResolver` bewusst setzen.** `true` (Default) nutzt `InitialDockerImage` direkt — richtig für die Stack-Erstellung und solange das erste Deployment noch nicht stabil läuft. Nach erfolgreichem Start auf `false`, damit Updates das Image vom laufenden Service übernehmen. Bei bestehenden Stacks mit `false` diesen Wert beim Update explizit mitgeben, sonst greift der neue Default und ein veraltetes `InitialDockerImage` wird deployt.
- **`TaskMemory` passt auf die Instanzgröße:** `478`, `956`, `1434`, `1913` MB entsprechen 4, 2, 1 Task(s) pro `t3.small`. Andere Werte verschwenden Kapazität.
- **`ServiceDesiredCount` ist gleichzeitig `MinCapacity`.** Wird die MinCapacity am Scalable Target per Konsole verändert, entsteht Drift, die den Scale-in unsichtbar blockiert; das nächste Stack-Update setzt sie zurück und löst dabei einen Scale-in aus. Vor dem Update vergleichen: `aws application-autoscaling describe-scalable-targets --service-namespace ecs`.
- **`Stat: Average` am Scale-in-Alarm nicht auf `Sum` ändern.** Der Alarm ist eine Metric-Math-Expression (`CPU < ServiceScaleDownCpuThreshold AND HealthyHostCount > ServiceDesiredCount`) und damit im Normalbetrieb `OK` statt dauerhaft rot. Die ALB veröffentlicht `HealthyHostCount` pro AZ, was den Schluss nahelegt, `Average` liefere den AZ-Mittelwert — der Schluss ist falsch: durch Cross-Zone Load Balancing meldet jede AZ die **vollständige** Zahl. Gemessen an `lab-web-fro-p` (2 Tasks, 2 AZs): `Average = 2.0`, `Sum = 4.0`. Mit `Sum` wäre `tasks > ServiceDesiredCount` dauerhaft wahr und jeder Service würde permanent auf MinCapacity gedrückt. Nur neu bewerten, falls `load_balancing.cross_zone.enabled` an einer TargetGroup auf `false` gesetzt wird.
- **Rolling Deployments verdoppeln kurzzeitig `HealthyHostCount`** (MaximumPercent 200 %). Der Scale-in-Alarm kann dabei kurz anschlagen; der Versuch ist ein No-op, weil Application Auto Scaling nie unter MinCapacity geht. `EvaluationPeriods: 5` überbrückt das Fenster.
- **Operative Alarme sind reine Sichtbarkeit** (keine Scaling-Trigger), jeder per Threshold `0` abschaltbar: HighCpu `20` % (Baseline liegt bei <1–2 %, deshalb ist 20 % bereits auffällig), HighMemory `80` % (Frühwarnung vor OOM-Kill), LowCpu und LowMemory `0` = aus (Opt-in für Right-Sizing-Reviews). Ziel: kein Alarm ist im gesunden Zustand rot.
- **Log Anomaly Detection** (`EnableLogAnomalyDetection`, Default `true`) trainiert zwei Wochen auf der Log-Gruppe und meldet danach neue oder ungewöhnlich häufige Log-Muster. Der Detector selbst ist kostenlos. Geeignet für Anwendungslogs mit Log-Level-Keywords; **nicht** geeignet für Access-/Audit-Logs oder sehr lange JSON-Zeilen (nur die ersten 1500 Zeichen werden analysiert) — deshalb bleiben Flow Logs und DNS-Logs bei Metric Filters. Vorabtest: Pattern-Analyse auf der Log-Gruppe; bis ~300 Patterns funktioniert es gut, darüber `false` setzen. **Achtung:** `AnomalyVisibilityTime` steht auf 21 Tagen — ein Anomaly, das so lange unbehoben bleibt, wird automatisch als Normalverhalten akzeptiert. Ein unbeobachteter Detector lernt, Fehler zu tolerieren.
- **ImageResolver-Fallstrick beim Retry nach fehlgeschlagener Erstellung:** existiert der ECS-Service nicht mehr, schlägt die Lambda hart fehl; existiert er, ist aber nie gesund geworden, wird das kaputte Image aus der laufenden Task Definition immer wieder reanimiert. In beiden Fällen hilft `SkipImageResolver=true`.
- **Nur ein Regel-Template pro Service.** `ecsservice` erzeugt schon HTTP- und HTTPS-Listener-Regeln. `alb-ecsservice-rule` zusätzlich für denselben Service führt zu doppelten Regeln auf derselben Priorität und damit zu einem Listener-Priority-Konflikt über zwei Stacks hinweg.

Deployte Versionen aller Service-Stacks einer Region:

```bash
aws cloudformation describe-stacks --region <region> \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName, version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" \
  --output table
```

Der Filter auf `TargetGroupArn` begrenzt die Liste auf `ecsservice`-Stacks; `None` bedeutet ein Stand vor Einführung der Versionierung.

---

### alb-ecsservice-rule

Zusätzliche Host/Pfad-Regel (HTTP und HTTPS) auf die TargetGroup eines bestehenden ECS-Service.

**Abhängigkeiten:** importiert `${ClusterStackName}-ListenerArnHttp`/`-ListenerArnHttps` und `${EcsServiceStackName}-TargetGroupArn`.

**Best Practices**

- **Nur für Services, die außerhalb von `ecsservice` deployt wurden**, oder für zusätzliche Hostnamen. Zusammen mit `ecsservice` für denselben Service entstehen doppelte Regeln auf derselben Priorität.
- `ListenerRulePriority` muss pro Listener eindeutig sein — Konflikte fallen erst beim Deployment auf.

---

### alb-redirect-rule

URL-Redirect-Regel auf dem ALB: HTTP wird auf HTTPS umgeleitet, HTTPS auf den Ziel-Hostnamen unter Beibehaltung von Pfad und Query-String.

**Abhängigkeiten:** importiert die Listener-ARNs des Clusters.

**Best Practices**

- `301` (Default) nur verwenden, wenn der Redirect dauerhaft ist — Browser cachen ihn hartnäckig. Für temporäre Umleitungen `302`.
- `ListenerRulePriority` muss pro Listener eindeutig sein.

---

### alb-additional-certificate

ACM-Zertifikat mit DNS-Validierung, zugewiesen als zusätzliches Zertifikat am HTTPS-Listener. Bestehende Zertifikate bleiben unverändert.

**Abhängigkeiten:** importiert `${ClusterStackName}-ListenerArnHttps`. Exportiert `${AWS::StackName}-CertificateArn`.

**Best Practices**

- **Der Stack pausiert bei `CREATE_IN_PROGRESS`, bis die DNS-Validierung abgeschlossen ist.** In dieser Zeit manuell: in ACM das Zertifikat mit Status *Pending Validation* öffnen, die CNAME-Einträge kopieren und in der zuständigen DNS-Zone anlegen. Danach läuft CloudFormation automatisch weiter.
- Bei Root-Domains `AddWildcardSan=true` setzen, damit `*.example.com` mitabgedeckt ist.
- **Die Stack-Löschung schlägt beim ersten Versuch oft fehl**, weil das Zertifikat noch als „in Verwendung" am Listener gilt. Einige Minuten warten und erneut löschen.

---

### certificate

Eigenständiges ACM-Zertifikat mit DNS-Validierung, ohne Load-Balancer-Bindung — für spätere manuelle Verwendung oder andere Stacks. Exportiert `${AWS::StackName}-CertificateArn`.

**Best Practices**

- Gleiche DNS-Validierung wie bei `alb-additional-certificate`: der Stack wartet, bis die CNAME-Einträge gesetzt sind.
- Für CloudFront muss das Zertifikat in **`us-east-1`** liegen.

---

### cloudfront-alb-distribution

CloudFront-Distribution vor einem ALB: HTTP/2 und HTTP/3, IPv6, SNI-only TLS ab TLSv1.2, WAF WebACL (AWS Managed Rules: Common Rule Set, Known Bad Inputs, IP Reputation List, plus Rate Limiting 2.000 Anfragen/IP/5 Min.), Cache Policy die Cache-Control des Origins respektiert und Cookies aus dem Cache-Key ausschließt, `AllViewer` Origin Request Policy, `SecurityHeadersPolicy` und ein Origin-Verify-Header.

**Best Practices**

- **Der WAF-Scope `CLOUDFRONT` existiert ausschließlich in `us-east-1`.** Ein Deployment mit `EnableWAF=true` in einer anderen Region schlägt sofort fehl (`WAFInvalidOperationException`). Aktuell ungelöst — siehe TASKS.md. Für einen ALB gilt das nicht: ein WebACL mit Scope `REGIONAL` wird in derselben Region wie der ALB erstellt.
- **Das ACM-Zertifikat muss in `us-east-1` liegen**, und das **ALB**-Zertifikat muss den `DomainName` abdecken (SAN oder Wildcard), weil CloudFront den originalen `Host`-Header weiterleitet.
- **`OriginVerifyValue` ist nur wirksam, wenn der ALB ihn auch erzwingt.** Die Listener-Regeln müssen Anfragen ohne diesen Header ablehnen, sonst bleibt der ALB direkt aus dem Internet erreichbar und CloudFront ist umgehbar.
- `EnableWAF=false` spart die WAF-Fixkosten (~9 $/Monat), entfernt aber SQLi-, XSS-, Bad-Input-, IP-Reputation- und Rate-Limiting-Schutz. AWS Shield Standard (L3/L4-DDoS) bleibt immer aktiv und kostenlos.

---

### global-accelerator-alb

Global Accelerator mit zwei statischen Anycast-IPv4-Adressen vor einem ALB, TCP-Listener auf 80 und 443, Endpoint Group in der Stack-Region mit Client-IP-Weiterleitung.

**Abhängigkeiten:** importiert `${ClusterStackName}-LoadbalancerArn`.

**Best Practices**

- **Für externe DNS-Provider ohne CNAME-Flattening.** Die beiden statischen IPs lassen sich direkt als A-Records eintragen — der eigentliche Grund für dieses Template.
- Anders als CloudFront ist **kein Deployment in `us-east-1` nötig**; der Stack läuft in der Region des ALB. Global Accelerator selbst wird intern in `us-west-2` verwaltet.
- `ClientAffinityEnabled=SOURCE_IP` nur setzen, wenn die Anwendung Sticky Sessions tatsächlich braucht.

---

## Allgemeine Hinweise

### Stack-Rolle

Immer eine dedizierte IAM-Rolle für Erstellung und Update von Stacks verwenden — siehe [AWS-Dokumentation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html).

### ECR-Zugriff über Accounts hinweg

Damit ein ECS-Service in einem anderen AWS-Account ECR-Images ziehen kann, folgende ressourcenbasierte Richtlinie am ECR-Repository ergänzen (`$EXT_ACCOUNT_ID` ersetzen):

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
