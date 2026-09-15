# AWS CloudFormation Stacks

Die CloudFormation-Templates, mit denen LABOR Infrastruktur und Anwendungen bereitstellt.

Parameter sind hier **nicht** dokumentiert — jeder trägt im Template eine `Description` und ist über
`AWS::CloudFormation::Interface` gruppiert, die Konsole zeigt beides beim Deployment. Diese Datei
beschreibt **Zweck, Deployment und Betriebswissen**, unabhängig davon, was gerade deployt ist. Offene
Punkte und der Stand der Cluster: [TASKS.md](TASKS.md). Abfragen: [queries.md](queries.md).

---

## Übersicht

| Template | Zweck |
|---|---|
| `ecscluster-vpc-rds-asg` | Vollständiger ECS-Cluster: VPC, RDS Aurora, ASG, ALB, EFS, AWS Backup, DNS Firewall, WAF, Monitoring |
| `ecscluster-vpc-rds-asg/alb-logs-bucket` | S3-Bucket für ALB-Zugriffslogs mit DSGVO-Lifecycle; überlebt die Stack-Löschung |
| `ecscluster-vpc-rds-asg/guardduty` | GuardDuty Detector, Quarantine-SG, Incident-Response-Rolle. Ein Stack pro Region |
| `ecscluster-vpc-rds-asg/backup-vaults-mirror` | Backup-Vaults in der Zielregion für regionsübergreifende Kopien |
| `ecsservice` | Ein containerisierter Service auf einem bestehenden Cluster |
| `alb-ecsservice-rule` | Zusätzliche Host/Pfad-Regel auf die TargetGroup eines bestehenden Service |
| `alb-redirect-rule` | URL-Redirect-Regel auf dem ALB |
| `alb-additional-certificate` | ACM-Zertifikat als zusätzliches Zertifikat am HTTPS-Listener |
| `certificate` | Eigenständiges ACM-Zertifikat mit DNS-Validierung |
| `cloudfront-alb-distribution` | CloudFront vor einem ALB, inkl. WAF WebACL |
| `global-accelerator-alb` | Global Accelerator mit zwei statischen Anycast-IPv4 vor einem ALB |

> `ecscluster-ext-additional-cluster` ist veraltet und wird nicht mehr unterstützt.

---

# Deployment

## Reihenfolge

Pro Region. Der Name des Cluster-Stacks steht schon vor Schritt 1 fest, weil Schritt 1 und 2 ihn brauchen.

1. **`alb-logs-bucket`** — liefert `BucketName` für `LogsBucketName`. Nachziehbar.
2. **`backup-vaults-mirror`** — **vor** dem Cluster und in der **Zielregion**
   (`BackupCopyDestinationRegion`, Default `eu-north-1`).
3. **`ecscluster-vpc-rds-asg`**
4. **`guardduty`** — **nach** dem Cluster, die Quarantine-SG importiert `${Cluster}-Vpc`. Einmal pro Region.
5. **`ecsservice`** — pro Anwendung.
6. Optional: `alb-ecsservice-rule`, `alb-redirect-rule`, `alb-additional-certificate`,
   `cloudfront-alb-distribution`, `global-accelerator-alb`.

Nur 3→4 ist durch einen Import erzwungen. 1 und 2 lassen sich nachziehen — bis dahin fehlen ALB-Logs bzw.
die Regionskopien.

## Drift prüfen

Vor jedem Template-Wechsel, und bei den beiden Stellen unten auch vor einem reinen Parameter-Update.

```bash
# Cluster: weicht die Realität vom Template ab?
aws cloudformation detect-stack-drift --stack-name <cluster>
aws cloudformation describe-stack-resource-drifts --stack-name <cluster> \
  --stack-resource-drift-status-filters MODIFIED DELETED
```

- **Ein Service-Stack driftet normalerweise nur in der Task Definition** — das ist erwartet, der
  `ImageResolver` fängt es ab.
- ⚠️ **`ServiceDesiredCount` ist gleichzeitig `MinCapacity` am Scalable Target.** Wurde sie per Konsole
  verändert, blockiert die Drift den Scale-in unsichtbar, und das nächste Stack-Update setzt sie zurück —
  und löst dabei einen Scale-in aus. Vorher vergleichen:
  ```bash
  aws application-autoscaling describe-scalable-targets --service-namespace ecs
  ```
- ⚠️ **Log-Retention und RDS-Version driften von selbst.** `AutoMinorVersionUpgrade` steht auf `true`, die
  Engine zieht also an der Template-Angabe vorbei; von Hand gehobene Retention-Werte fallen beim nächsten
  Update auf die festverdrahteten 14 Tage zurück.
- **Bekannte Dauerdrift** in beiden Regionen: `DnsQueryLoggingConfig`, `Rdscl`, `Rdsinstance1`. Der Stand
  je Cluster steht in [TASKS.md](TASKS.md).

## Die Fallen

Das sind die Punkte, die einen Deploy kosten. Sortiert nach Zeitpunkt, an dem sie zuschlagen.

**Vor dem Hochladen**

- ⚠️ **Der Cluster ist zu groß für einen Inline-Deploy.** CloudFormation nimmt per `--template-body`
  höchstens 51.200 Byte. Deploys laufen über S3 (`--template-url`) oder die Konsole, die den Upload selbst
  übernimmt.
- **Nach jeder Handbearbeitung `cfn-lint` laufen lassen.** CloudFormation meldet Formatfehler als
  `Template format error` ohne Zeilennummer; `cfn-lint` nennt die Stelle.
- **`--capabilities CAPABILITY_NAMED_IAM`** beim GuardDuty-Stack (die Incident-Response-Rolle hat einen
  expliziten `RoleName`) und beim Cluster.

**Beim Setzen der Parameter**

- ⚠️ **`AscalegroupDesSize` kann jedes Update zu einem Ausfall machen.** Sein `MaxValue` ist `15`, während
  ECS Managed Scaling die echte Kapazität laufend verschiebt. Liegt sie darüber, zieht CloudFormation sie
  herunter — und weil `ManagedTerminationProtection` auf `DISABLED` steht, werden die Tasks **abgeworfen
  statt gedraint**. Ist-Kapazität **unmittelbar vor dem Ausführen** lesen, nicht beim Erzeugen des Change
  Sets. Läuft die Gruppe über `15`, erst den `MaxValue` heben.
- ⚠️ **Parameter, die in der Zielversion neu sind, haben keinen bisherigen Wert.** `aws cloudformation
  deploy` übernimmt für alles Übrige den Stack-Wert, für neue Parameter aber den **Template-Default**. Bei
  den `*AlarmAction`-Schaltern heißt das: ein Upgrade mit Defaults schaltet Alarme stumm, die vorher
  benachrichtigt haben. Immer explizit mitgeben.
- ⚠️ **`SkipImageResolver` bei bestehenden Stacks mit `false` bei jedem Update explizit mitgeben** — sonst
  greift der Default `true` und ein veraltetes `InitialDockerImage` wird deployt.
- ⚠️ **`ClusterName` in `backup-vaults-mirror` ist der Name des Cluster-*Stacks*, kein freier Bezeichner.**
  Der Cluster baut die Ziel-ARN aus seinem eigenen `${AWS::StackName}`. Weicht der Name ab, schlagen die
  Copy-Actions fehl — die täglichen Backups laufen weiter, nur die Regionskopie fehlt.
- **`RateLimitAction=block` ohne `WafClientIpHeader` lehnt CloudFormation ab** (`Rules`-Bedingung
  `WafRateLimitNeedsClientIpHeader`). Sonst aggregieren bei proxied Sites alle Requests auf die Adressen
  des Proxys und ein Block sperrt ihn für alle Sites aus.
- **`EgressExtraRules` und `DnsFirewallWhitelistDomains` sind regionsspezifisch.** Die Defaults tragen die
  Werte einer Umgebung; eine andere Region damit zu deployen nagelt Mail oder Telemetrie auf den falschen
  Host fest.

**Beim Ausführen**

- ⚠️ **Ein ALB kann nur ein WebACL tragen.** Wurde je eines manuell angehängt, kollidiert die Association
  und das Update scheitert — vorher `aws wafv2 get-web-acl-for-resource --resource-arn <alb-arn>`.
- ⚠️ **Ein GuardDuty-Detector pro Account und Region.** Existiert schon einer, schlägt die Erstellung fehl:
  `aws guardduty list-detectors`.
- ⚠️ **`ListenerRulePriority` kollidiert erst beim Deployment.** CloudFormation sieht die Belegung anderer
  Stacks nicht. Betrifft `ecsservice`, `alb-ecsservice-rule` und `alb-redirect-rule` gemeinsam.
- ⚠️ **Nur ein Regel-Template pro Service.** `ecsservice` legt seine beiden Listener-Regeln selbst an;
  `alb-ecsservice-rule` zusätzlich für denselben Service erzeugt doppelte Regeln auf derselben Priorität —
  ein Konflikt über zwei Stacks hinweg, den keiner der beiden allein erkennen kann.
- **Zertifikats-Stacks pausieren bei `CREATE_IN_PROGRESS`,** bis die DNS-Validierung durch ist. Solange
  manuell: in ACM die CNAME-Einträge kopieren und in der DNS-Zone anlegen.
- ⚠️ **Der WAF-Scope `CLOUDFRONT` existiert ausschließlich in `us-east-1`.** `EnableWAF=true` in einer
  anderen Region schlägt sofort mit `WAFInvalidOperationException` fehl. Ebenso muss ein Zertifikat für
  CloudFront in `us-east-1` liegen. Für den ALB gilt beides nicht.
- **Service-Alarme brauchen einen Cluster auf mindestens `1.1.0`,** weil sie
  `${ClusterStackName}-AlertTopicArn` importieren.

**Beim Wechsel auf ein neues Template**

- **Erst den Drift reduzieren** (siehe oben). Schlägt ein Update fehl, rollt CloudFormation auf die letzte
  bekannte Konfiguration zurück — deren Image kann sehr alt oder gelöscht sein. Also: Abweichungen jenseits
  der Task Definition zurücksetzen, den Stack **ohne** Template-Austausch mit `InitialDockerImage` =
  laufendes Image aktualisieren, und erst danach das Template ersetzen.
- **Die Launch-Template-Version rollt die Flotte nicht.** Die ASG trägt **keine `UpdatePolicy`** — ein
  neues AMI tauscht keine laufende Instanz aus, nur neu gestartete bekommen es. Eine gemischte Flotte nach
  einem Update ist der Normalfall. Dasselbe gilt für jede Security Group, die über das Launch Template
  zugewiesen wird.
- ⚠️ **Zu enge Egress- oder DNS-Regeln brechen keine laufenden Container, sondern den nächsten
  Image-Pull.** Nichts startet oder skaliert mehr, während alles gesund aussieht. Mit einem **erzwungenen
  Deployment** testen, nicht durch Aufrufen der Website.

## Cross-Stack-Kontrakt

Alles außer `LogsBucketName` läuft über Exports:

| Export | Von | Für |
|---|---|---|
| `${Cluster}-Ecscluster`, `-Vpc`, `-Efs` | Cluster | `ecsservice`, `guardduty` (nur `-Vpc`) |
| `${Cluster}-ListenerArnHttp` / `-ListenerArnHttps` | Cluster | `ecsservice`, `alb-*-rule`, `alb-additional-certificate` |
| `${Cluster}-LoadbalancerArn` | Cluster | `ecsservice` (Scale-in-Alarm), `global-accelerator-alb` |
| `${Cluster}-AlertTopicArn` | Cluster (ab `1.1.0`) | `ecsservice` (Alarme, `ImageRegressionGuard`) |
| `${Service}-TargetGroupArn` | `ecsservice` | `alb-ecsservice-rule` |
| `${LogsBucket}-BucketName` / `-BucketArn` | `alb-logs-bucket` | Cluster — **als Parameter von Hand**, nicht per `ImportValue` |
| `${Cert}-CertificateArn` | `certificate`, `alb-additional-certificate` | manuelle Zuweisung |
| `${CloudFront}-DistributionId` / `-DistributionDomainName` | `cloudfront-alb-distribution` | manuelle Verwendung |
| `${Accel}-AcceleratorArn` / `-AcceleratorDnsName` / `-StaticIp1` / `-StaticIp2` | `global-accelerator-alb` | DNS-Einträge |
| `${Cluster}-SubnetPrivate1/2`, `-Subnet1/2`, `-SgVpcLoadbalancerportsAccess`, `-WebAclArn`, `-DnsFirewall*Id` | Cluster | derzeit von keinem Template importiert |
| `${GuardDuty}-DetectorId/-DetectorArn/-QuarantineSgId/-IncidentResponseRoleArn` | `guardduty` | derzeit von keinem Template importiert |

Ein Stack lässt sich nicht löschen, solange ein anderer seine Exports importiert. **Die Hälfte der
Cluster-Exports wird von keinem Template hier importiert — sie sind trotzdem verbindlich**, weil Stacks
außerhalb dieses Repositories sie referenzieren können.

`WafLogGroupName` und `TemplateVersion` sind **keine** Exports, nur über `describe-stacks` lesbar:

```bash
# deployte Versionen aller Service-Stacks einer Region ('None' = vor der Versionierung)
aws cloudformation describe-stacks --region <region> \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName, version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" \
  --output table
```

## Löschverhalten

- ⚠️ **Keine einzige Ressource im Cluster trägt eine `DeletionPolicy`.** Ein `delete-stack` löscht
  **RDS-Cluster und EFS samt Daten**, ohne finalen Snapshot. Die Backup-Vaults überleben, aber der Weg
  zurück ist ein Restore.
- **Die ALB Deletion Protection blockiert das Löschen** und muss vorher manuell abgeschaltet werden — der
  einzige eingebaute Bremsklotz.
- **`alb-logs-bucket` überlebt jedes Löschen** (`DeletionPolicy` und `UpdateReplacePolicy` auf `Retain`) —
  mit Absicht, damit der Cluster iterierbar bleibt, ohne den Audit-Trail zu riskieren.
- **Zertifikats-Stacks scheitern beim ersten Löschversuch oft**, weil das Zertifikat noch als „in
  Verwendung" am Listener gilt. Einige Minuten warten.

---

# Betrieb

## Logs

Sechs CloudWatch-Log-Gruppen im Cluster, drei je Service, plus ALB Access Logs in S3. **Alle auf 14 Tage
festverdrahtet (DSGVO)** — jede Analyse ist damit auf zwei Wochen begrenzt.

| Log-Gruppe | Inhalt | Parameter |
|---|---|---|
| `${Cluster}-VpcFlowLogs` | abgelehnte VPC-Verbindungen (nur `REJECT`) | — |
| `${Cluster}-VpcAcceptFlowLogs` | erlaubte Verbindungen; temporäre Egress-Baseline | `EnableEgressAnalysis` |
| `${Cluster}-DnsFirewallLogs` | alle DNS-Anfragen inkl. Firewall-Aktion | — |
| `/aws/rds/cluster/<Rdscl>/error` | Aurora Error Log | — |
| `/aws/rds/cluster/<Rdscl>/slowquery` | Slow Query Log | `RdsLongQueryTime` |
| `aws-waf-logs-${Cluster}-waf` | vollständige Requests, `authorization`/`cookie` redigiert | — |
| S3 `<LogsBucket>/<Cluster>/` | ALB Access Logs — Statuscodes und URLs | `LogsBucketName` |
| `${Service}-LogGroup` | stdout/stderr des Containers (`awslogs`, Prefix `ECSDockerTask`) | — |
| `/aws/lambda/<Service>-ImageResolver` | Auflösung des Images bei jedem Update | — |
| `/aws/lambda/<Service>-ImageRegressionGuard` | Entscheidung bei jedem Rollout | — |

**Fünf gespeicherte Queries** (Konsole → Logs Insights → *Queries*), jede mit Log-Gruppe und Zeitfenster:
`VpcEgressPortsAnalysis` (7 d), `DnsFireWallLogsSummary` (14 d), `VpcFlowLogsRejectedTraffic` (1 h),
`RdsErrorLogSummary` (24 h), `RdsSlowQuerySummary` (24 h). Weitere Blöcke in [queries.md](queries.md).

**Vom Logeintrag zum Alarm:** Metric Filter schreiben `AlertedQueries`, `BlockedQueries`,
`RejectedConnections`, `ErrorCount` und `SlowQueryCount` fort. Die WAF-Alarme lesen dagegen direkt aus
`AWS/WAFV2`.

## Alarme

**Jeder hat einen `off`/`dashboard`/`alert`-Schalter und einen eigenen Schwellenparameter** — benannt nach
dem Alarm (`DnsFirewallAlarmAction` / `-Threshold`, `RdsConnectionsAlarmAction` / `-Threshold` und so fort; beide Rate-Limit-Alarme teilen sich
`RateLimitAlarmAction` und `RateLimitAlarmThreshold`). Default überall `dashboard`:

- `off` — Alarm wird nicht angelegt.
- `dashboard` — Alarm existiert, Zustand und Historie laufen, aber `ActionsEnabled: false`: **keine
  Benachrichtigung**. Der Zustand zum Kalibrieren, ohne die Historie wegzuwerfen.
- `alert` — publiziert zusätzlich ins Cluster-Topic.

> ⚠️ **`dashboard` heißt nicht „erscheint auf dem Dashboard".** Es heißt allein `ActionsEnabled: false`.
> Das Alarm-Widget auf `${Cluster}-Overview` macht den Namen seit `1.7.0` näherungsweise wahr.

> ⚠️ **`notBreaching` hat eine Kehrseite:** schreibt ein Metric Filter nie einen Datenpunkt, steht sein
> Alarm dauerhaft auf `OK` — ununterscheidbar von „alles in Ordnung". Vor dem Heben auf `alert` prüfen, ob
> die Metrik überhaupt schreibt.

**Konsequenz: nach einem frischen Deploy benachrichtigt der Cluster-Stack niemanden.** Einzelne Alarme
bewusst heben, sobald ihre Schwelle gegen echten Traffic gelesen wurde — zuerst `KnownBadInputs` und
`SQLi` (leise und aussagekräftig), nicht `CommonRuleSet` (Grundrauschen).

**Zwölf Cluster-Alarme.** Fast alle nach demselben Muster: Summe über 5 Minuten, eine Auswertungsperiode,
`notBreaching`. Ausnahme ist `rds-connections` mit `Maximum`.

| Alarm | Misst | Schwelle | Wozu |
|---|---|---|---|
| `dns-firewall-alert-surge` | DNS-Anfragen mit Aktion `ALERT` | `100` | Sprung = unerwarteter externer Zugriff |
| `dns-firewall-blocked` | abgewiesene Anfragen | `0` | existiert nur unter `BLOCK`, Default `alert` |
| `vpc-rejected-surge` | abgelehnte VPC-Verbindungen | `500` | Portscan oder kaputte Konfiguration |
| `rds-error` | `[ERROR]`-Zeilen im Aurora-Log | `0` | feuert bei **jedem** Eintrag — die lauteste Quelle |
| `rds-slow-queries` | Slow-Query-Zeilen | `5` | „langsam" steuert `RdsLongQueryTime` |
| `elb-5xx` | 5xx **vom Load Balancer** (502/503/504) | `10` | was der Besucher sieht — für Target-5xx unsichtbar |
| `rds-connections` | offene DB-Verbindungen (`Maximum`) | `60` | der einzige Alarm, der Erschöpfung **kommen** sieht |
| `AlarmWafCommonRuleSet` | WAF-Treffer | `300` | trefferstärkste Regel, niedrige Schwelle wäre dauerrot |
| `AlarmWafKnownBadInputs` | WAF-Treffer | `50` | sollte fast still sein — interessantestes Signal |
| `AlarmWafSQLi` / `AlarmWafWordPress` | WAF-Treffer | `20` | die leisesten Managed-Gruppen |
| `AlarmWafRateLimitSourceIp` / `-ForwardedIp` | WAF-Treffer | `10` | teilen Schalter und Schwelle |

- **`RdsErrorAlarmThreshold` ist der einzige, der `0` erlaubt** — und `0` ist dort der Zweck. Alle anderen
  beginnen bei `1`.
- **`elb-5xx` ist cluster-weit.** `HTTPCode_ELB_5XX_Count` trägt **keine** `TargetGroup`-Dimension — er
  sagt, dass etwas nicht erreichbar ist, nicht *was*; dafür das Alarmfenster gegen
  `HTTPCode_Target_5XX_Count` und `UnHealthyHostCount` je Target Group legen.
- ⚠️ **Die Schwelle `10` verdeckt ein echtes Problem.** Mit `MinimumHealthyPercent: 50` hat ein Service mit
  einer Task während des Deployments **kein** gesundes Ziel — rund 90 Sekunden 503 pro Deploy, kein
  legitimer Beitrag, sondern ein Ausfall. Offener Punkt in TASKS.md.
- **`rds-connections` misst `Maximum`, nicht `Sum`** — `DatabaseConnections` ist ein Momentanwert,
  Summieren ergäbe ein Vielfaches. Die Obergrenze ist `max_connections`: auf `db.t3.medium` rund
  **138–145**, weil `log` in RDS-Parameterformeln **Basis 2** ist und der Multiplikator `60` ein Drittel
  über dem Aurora-Default liegt. Cluster-weit — alle Service-Stacks teilen sich das Budget, der Alarm sagt
  also *dass* es eng wird, nicht *wer* die Verbindungen hält.
- **Jeder WAF-Alarm folgt dem Modus seiner Regel:** `CountedRequests` solange sie zählt, `BlockedRequests`
  sobald sie blockt — dieselbe Schwelle vor und nach der Promotion.

**Acht Alarme je Service.** Die beiden Autoscaling-Alarme steuern die Scaling Policies und melden
**absichtlich nicht** ans Cluster-Topic.

| Alarm | Misst | Schwelle / Schalter |
|---|---|---|
| `AlarmAutoscaleScaleUp` / `-ScaleDown` | ECS-CPU 3×60 s / Metrik-Mathematik 5×60 s | `65` / `15` % — Scaling-Trigger, nicht abschaltbar |
| `AlarmHighCpu` | ECS-CPU, 5 Min. | `20` %; `dashboard` |
| `AlarmHighMemory` | ECS-Memory, 5 Min. | `80` %; `dashboard` |
| `AlarmLowCpu` / `-LowMemory` | ECS-CPU / -Memory, 2×5 Min. | `0`; `off` |
| `AlarmHttp5xxTarget` | `HTTPCode_Target_5XX_Count` | `5`/5 Min.; `dashboard` |
| `AlarmHttp4xxTargetAnomaly` | Anomalieband auf `HTTPCode_Target_4XX_Count` | Band `3`; `dashboard` |

- ⚠️ **Die Low-Alarme können mit Default `0` nie auslösen** (`LessThanThreshold` gegen `0`). Wer sie
  einschaltet, muss zuerst eine echte Schwelle setzen — sonst entsteht Abdeckung, die keine ist.
- **`dashboard` als Default ist gemessen:** über 15 Services haben 43 von 45 Alarmen nie ausgelöst. Ein
  Default auf `alert` hätte Stacks zum Melden gebracht, die bisher gar keine Service-Alarme hatten.
- **`AlarmHighCpu` bei `20` % ist für eine JVM zu eng.** Ein Solr-Start erreicht kurzzeitig ~29 % — jeder
  Neustart eines solchen Service meldet. Per-Stack über `ServiceHighCpuThreshold` heben.
- **`AlarmHttp5xxTarget` meldet, dass die Anwendung geantwortet hat — mit 5xx.** Das steht in der
  Log-Gruppe. Default `5`/5 Min. statt `1`, weil Rolling Deployments transiente 5xx erzeugen.
  Loadbalancer-seitige 5xx liegen im Cluster-Alarm `elb-5xx`.
- **`AlarmHttp4xxTargetAnomaly` ist ein Stolperdraht, keine Diagnose.** Er meldet Abweichungen von der
  eigenen Baseline, kann aber weder Statuscode noch URL nennen — Nachverfolgung in den ALB-Access-Logs. Nur
  die **obere** Bandgrenze alarmiert. Keine Anlaufzeit: die Metrik wird durchgehend veröffentlicht und 15
  Monate aufbewahrt. Auf Services mit wenig Verkehr bleibt er laut, daher Default `dashboard`. Kostet das
  Dreifache eines normalen Alarms. Scanner, die den ALB ohne passende Listener-Regel treffen, landen in
  `HTTPCode_ELB_4XX_Count` auf Cluster-Ebene und sind hier **nicht** erfasst.
- ⚠️ **`BaselineHttp4xxTarget` und `AlarmHttp4xxTarget` sind per `DependsOn` gekoppelt — nicht entfernen.**
  Ein Anomaly Detector ist seinem Alarm nur implizit zugeordnet. Ohne die Kante darf CloudFormation den
  Detector zuerst löschen, und `DeleteAnomalyDetector` scheitert, solange ein Alarm die Metrik referenziert
  — der Stack landet in `DELETE_FAILED`.

## Benachrichtigung und Dashboard

- **Ein SNS-Topic pro Cluster** (`${Cluster}-alerts`, Export `-AlertTopicArn`) für Cluster- *und*
  Service-Alarme. Empfänger nie pro Service pflegen.
- `AlertEmail` leer = Topic ohne Subscription, Alarme publizieren ins Leere. Die Subscription muss per Link
  bestätigt werden, während CloudFormation schon `CREATE_COMPLETE` meldet.
- **Slack ist nicht angebunden** — eine reine `https`-Subscription auf einen Slack-Webhook funktioniert
  nicht.
- **Dashboard `${Cluster}-Overview`**, 3-Stunden-Fenster, ab `1.7.0` acht Widgets: ECS-CPU und -Memory je
  Service (per `SEARCH()`, neue Services erscheinen automatisch), RDS-CPU/-Connections und abgelehnte
  VPC-Verbindungen je mit ihrer Schwelle, ein Alarmstatus-Widget, sowie drei Logs-Insights-Ansichten
  (unabgedeckte DNS-Namen, abgelehnte Verbindungen, langsamste Queries).
  Die Alarme stehen im Widget mit konstruierter ARN statt per `Ref`, weil die meisten an ihrem
  `*AlarmAction`-Parameter hängen — Folge: ein auf `off` gestellter Alarm erscheint als „unavailable".

## GuardDuty im Betrieb

- **Data Sources verifizieren:** `CLOUD_TRAIL`, `DNS_LOGS`, `FLOW_LOGS` müssen `ENABLED` sein. GuardDuty
  liest AWS-interne Kopien, nicht unsere Log-Gruppen — Detection funktioniert also auch dort, wo unser Flow
  Log nur `REJECT` erfasst.
- **Pipeline mit Sample-Findings testen** (`create-sample-findings`, dann `list-findings`, danach
  `archive-findings`, damit die Testdaten das echte Signal nicht verwässern).
- ⚠️ **Findings benachrichtigen niemanden** — sie stehen nur in der Konsole, es fehlt die EventBridge-Regel.
- **Runtime Monitoring ist aus** (`RUNTIME_MONITORING` ungesetzt). Damit wird nichts erfasst, was
  *innerhalb* eines Containers passiert — eine dort geschriebene Datei ist für Flow Logs, DNS Logs und
  CloudTrail unsichtbar, und die Writable Layer verschwindet beim nächsten Deployment. Wird **pro
  vCPU-Stunde** abgerechnet.
- Root-Console-Zugriffe erzeugen wiederkehrend `Policy:IAMUser/RootCredentialUsage`.

## ALB-Logging prüfen

`access_logs.s3.enabled` kann `true` sein, während die Lieferung an der Bucket-Policy scheitert. Nach dem
Aktivieren prüfen, ob unter `<prefix>/AWSLogs/<account>/elasticloadbalancing/<region>/` Objekte ankommen.

⚠️ **Verschlüsselung ist SSE-S3, nicht KMS — und das ist kein Versäumnis.** ALB-Log-Delivery unterstützt
kein KMS. Wer auf SSE-KMS umstellt, bricht die Lieferung **stillschweigend**: kein Fehler, nur keine
Objekte mehr.

---

# Wie es funktioniert

## Netzwerk, Datenbank, Dateisystem

- **DHCP-Options** setzen hartcodiert `DomainName: ec2.internal` — das ist die `us-east-1`-Schreibweise,
  außerhalb heißt die Zone `<region>.compute.internal`. Relevant für die DNS-Firewall-Whitelist.
- **Patches auf den Instanzen: `dnf-automatic`,** vom Launch Template per UserData installiert und mit
  `upgrade_type = security`, `apply_updates = yes` scharf geschaltet. Sicherheitsupdates werden also
  automatisch **installiert**.
  ⚠️ **Aber nie aktiviert.** `reboot` bleibt ungesetzt, also beim Default `never` — Kernel- und
  glibc-Updates liegen installiert vor und greifen erst nach einem Neustart. Und nichts startet neu: die
  ASG hat keine `UpdatePolicy`, es gibt keinen Instance Refresh, und ein neues AMI im Launch Template
  erreicht nur neu gestartete Instanzen. Eine Instanz sammelt damit unbegrenzt Patches an, die nicht
  wirken. Der einzige Weg ist heute manuell: drainen, ohne Verringerung der Wunschkapazität terminieren,
  die ASG stellt aus der aktuellen Launch-Template-Version nach. Offener Punkt in [TASKS.md](TASKS.md).

- **Aurora MySQL:** TLS erzwungen (`require_secure_transport = ON`), Storage verschlüsselt, nicht
  öffentlich erreichbar. **`BackupRetentionPeriod` hartcodiert auf 1 Tag** — automatische Snapshots decken
  nur 24 h ab, alles darüber kommt aus AWS Backup. `slow_query_log = 1`, Schwelle über `RdsLongQueryTime`;
  für einen vollständigen Trace `0` setzen (dynamisch) und `RdsSlowQueryAlarm` vorübergehend anheben.
- **EFS:** TLS beim Mount (`TransitEncryption: ENABLED` je Task Definition), Storage verschlüsselt. Das
  Volume `data` hängt mit `RootDirectory: /<Stackname>` — die Trennung der Services ist eine
  Verzeichniskonvention, kein erzwungener Access Point.
- **Backup:** zwei Regeln, beide auf EFS *und* RDS — alle 6 h ab `00:30 UTC` → 35 Tage, sonntags
  `05:00 UTC` → 365 Tage, jeweils mit Mirror-Copy in die Zielregion. Ein leerer
  `BackupCopyDestinationRegion` schaltet die Kopien ganz ab. Der Mirror ist für Regionsverlust; ein Restore
  daraus in die Quellregion braucht erst eine Rückkopie.

## DNS Firewall

Zwei Regeln: Whitelist `ALLOW` (Prio 100), Catch-all `*` (Prio 200). Der Catch-all ist per Default
**`ALERT`** — es wird protokolliert und trotzdem aufgelöst.

- **Durchsetzung ist ab `1.7.0` ein Parameter.** `DnsFirewallCatchAllAction` schaltet `ALERT`/`BLOCK`,
  `DnsFirewallBlockResponse` die Antwort (`NXDOMAIN` oder `NODATA`). Rückweg ebenso. `NXDOMAIN` meldet die
  Domain als nicht existent — ein schneller eindeutiger Fehler statt eines Timeouts. `BlockResponse` wird
  per `Fn::If` nur bei `BLOCK` gesetzt: Route 53 weist die Property an einer `ALERT`-Regel zurück.
- **Vor dem Umschalten:** `DnsFireWallLogsSummary` über mindestens 7 Tage, bis keine legitime Domain mehr
  alarmiert.
- ⚠️ **Die CNAME-Kette wird mitgeprüft.** AWS' Default bewertet **alle** Glieder einer Weiterleitung. Ein
  Name auf der Whitelist, dessen Kette sie verlässt, löst trotzdem den Catch-all aus — protokolliert unter
  dem **ursprünglich angefragten Namen**, sieht also nach einem kaputten Whitelist-Eintrag aus.
  `DnsFirewallRedirectionAction` (ab `1.7.0`, Default `TRUST_REDIRECTION_DOMAIN`, Alternative
  `INSPECT_REDIRECTION_DOMAIN` = AWS' Default) stellt das um: ist der angefragte Name erlaubt, gilt die
  Kette als erlaubt. `TRUST` ist trotz des strenger klingenden `INSPECT` die **engere** Erlaubnis — um ein
  CDN-gestütztes Ziel unter `INSPECT` durchzulassen, müsste man den ganzen CDN-Namensraum erlauben.
- **Wildcards decken beliebige Tiefe ab.** `*.example.com` trifft `a.b.example.com`; der Stern muss das
  linkeste Label vollständig ersetzen (`*prod.example.com` ist ungültig). Die **Apex-Domain deckt er
  nicht** ab — die gehört separat auf die Liste.
- ⚠️ **`ALLOW` erzeugt keinen Logeintrag.** Erlaubt und ungeprüft sehen im Query-Log identisch aus — in
  beiden Fällen fehlen `firewall_rule_action` und `firewall_rule_group_id`. Aus dem Ausbleiben eines ALERT
  lässt sich **nicht** schließen, dass eine Regel gegriffen hat.
- **Was sie nicht kann:** sie sieht nur Anfragen an den VPC-Resolver. Wer einen externen Resolver fragt oder
  eine IP direkt anwählt, läuft vorbei — `BLOCK` ergibt erst zusammen mit `53 → VPC-CIDR` in den
  Egress-Regeln ein geschlossenes Bild.
- **Zwei Alarme, zwei Fragen.** `dns-firewall-alert-surge` ist ein **Mengenalarm** — eine einzelne neue
  Domain bewegt ihn nie; dafür die gespeicherte Query. `dns-firewall-blocked` meldet jede Abweisung und
  existiert nur unter `BLOCK`.
- ⚠️ **Zwei Metriken, weil die Firewall unter `BLOCK` eine andere Aktion schreibt.** Ein Filter nur auf
  `ALERT` hätte im Moment des Umschaltens aufgehört zu zählen und Alarm wie Query still auf null fallen
  lassen. Seit `1.7.0` gibt es `AlertedQueries` und `BlockedQueries`. Der Alarmname trägt weiterhin
  `alert-surge`; Umbenennen ersetzt den Alarm und verwirft seine Zustandshistorie.
- **Ein Neuheitsdetektor fehlt.** Metric Filter zählen Treffer, sie verfolgen keine Domain-Kardinalität.

## Egress der EC2-Instanzen

`EgressPolicy` (`open`/`restricted`, Default `open`) und `EgressExtraRules`. `open` ist eine explizite
Allow-all-Regel, identisch zum vorherigen impliziten Zustand.

| Regel | Ziel | Woher |
|---|---|---|
| `443/TCP` | `0.0.0.0/0` | fest, nicht abschaltbar |
| `53/UDP` + `53/TCP` | **VPC-CIDR** | fest, nicht abschaltbar |
| bis zu vier weitere TCP-Regeln | je eigene CIDR | `EgressExtraRules` |

- **`EgressExtraRules` nimmt `port:cidr`-Paare.** Port und Ziel stehen im selben Eintrag, weil zwei
  parallele Listen bei Verschiebung still den falschen Port zum falschen Ziel öffnen.
- **Warum Zieladressen zählen:** die DNS-Firewall sieht nie eine Verbindung, sie beantwortet nur eine
  Auflösung. Die CIDR in der SG-Regel ist das **einzige** im Template, das begrenzt, wohin Verkehr darf.
- **`53` ist die Klammer zur DNS-Firewall** — sie zwingt jede Auflösung über den VPC-Resolver. **`443`
  lässt sich nicht anpinnen**, weil Drittanbieter über Namen erreicht werden und ihre Adressen wechseln.
- **Feste Slots statt Liste.** Reines CloudFormation kann aus einer Liste unbekannter Länge keine N Regeln
  bauen; `Fn::ForEach` bräuchte `AWS::LanguageExtensions`, und der Transform macht
  „Use existing template"-Updates unbrauchbar — genau den Weg, auf dem hier jede Promotion läuft.
- **`80/TCP` und `123/UDP` fehlen bewusst.** Port 80 wurde in 28 Tagen von keiner Cluster-Instanz benutzt;
  `169.254.169.123` ist link-local und unterliegt gar keiner Security Group. Und ein fehlender Port meldet
  sich von selbst — nach der Härtung wird jeder `REJECT` zum Signal mit Quelle und Ziel.
- **Warum eine eigene Gruppe `SgEgress`:** SG-Regeln sind **additiv** über alle Gruppen einer Instanz.
  `SgVpcMysqlAccess`, `SgVpcLoadbalancerports` und `SgVpcEfsAccess` hängen alle am Launch Template — eine
  davon zu beschränken bewirkt nichts. Unter `restricted` tragen die drei eine Platzhalterregel auf
  `127.0.0.1/32`: eine **leere** `SecurityGroupEgress`-Liste lässt CloudFormation die Standardregel wieder
  anlegen, „kein Egress" muss als Regel ins Nichts geschrieben werden.
- ⚠️ **Reihenfolge — der eine Weg, sich auszusperren.** `SgEgress` erreicht eine Instanz über das Launch
  Template, und die ASG hat keine `UpdatePolicy`. Wer vorher die Flotte nicht erneuert hat, hat Instanzen
  ohne die Gruppe — und die Neutralisierung der drei anderen greift auf deren ENIs **sofort**. Vorher:
  ```bash
  aws ec2 describe-instances --filters Name=tag:Name,Values=<stack>-Instance \
    --query 'Reservations[].Instances[].[InstanceId,SecurityGroups[].GroupName]' --output text
  ```
- **Was `restricted` leistet:** jeder andere Port ist zu — keine Reverse Shell, kein ausgehendes SSH, kein
  Datenbankclient, kein Spam-Relay, und der REJECT-Log wird zum Signal.
- **Was es nicht leistet:** `443` bleibt zu jeder Adresse offen, was jedem genügt, der Codeausführung hat.
  Eine hart eingetragene IP braucht keine Auflösung; **DNS-over-HTTPS** läuft auf 443 zu Resolvern mit fest
  eingebauten Adressen und umgeht die 53er-Regel *und* die Firewall. Das zu schließen hieße, die Verbindung
  zu prüfen statt die Auflösung — Network Firewall über den TLS-SNI oder ein Proxy.
- Nicht angewendet auf `SgPublicHttpHttps`, `SgVpcLoadbalancerportsAccess`, `SgVpcMysql`, `SgVpcEfs`: der
  ALB braucht Egress zu seinen Targets, die anderen initiieren nach außen nichts.

## VPC Flow Logs

- **Ein Flow Log auf VPC-Ebene, `TrafficType: REJECT`** — `ALL` erzeugt ein Vielfaches an Volumen und
  liefert für die Portscan-Erkennung nichts dazu.
- **`EnableEgressAnalysis=true` legt einen zweiten im ACCEPT-Modus an** — die Grundlage für die
  Egress-Baseline. Temporär: nach 7–14 Tagen zurück auf `false`, ACCEPT-Logs rechnen pro GB ab. Er wird nur
  von `VpcEgressPortsAnalysis` gelesen, nicht alarmiert.

## WAF

Ein `REGIONAL` WebACL am ALB (`DefaultAction: Allow`), schützt alle Services dahinter. Nicht zu verwechseln
mit dem WebACL in `cloudfront-alb-distribution`.

| Prio | Regel | Action-Parameter | Prüft |
|---|---|---|---|
| 20 | `AWSManagedRulesCommonRuleSet` | `CommonRuleSetAction` | XSS, Path Traversal, schlechte User Agents — häufigste False-Positive-Quelle |
| 30 | `AWSManagedRulesKnownBadInputsRuleSet` | `KnownBadInputsAction` | Payloads breit ausgenutzter CVEs |
| 40 | `AWSManagedRulesSQLiRuleSet` | `SqliRuleSetAction` | SQL-Injection |
| 50 | `AWSManagedRulesWordPressRuleSet` | `WordPressRulesAction` | WordPress-Signaturen |
| 90 / 91 | `RateLimitForwardedIp` / `RateLimitSourceIp` | `RateLimitAction` | Rate-Limit auf Client-IP-Header bzw. Source IP; 90 existiert nur mit `WafClientIpHeader` |

- **Fünf Schalter für sechs Regeln** (beide Rate-Regeln teilen einen), Default überall `count` — **beim
  ersten Deploy wird nichts blockiert.** Promotion pro Regel: eine Woche `CountedRequests` lesen, dann
  `block`.
- Der Client-IP-Header ist nur vertrauenswürdig, solange der ALB nicht direkt erreichbar ist.

## ImageResolver

**Problem:** Deployt wird über die Pipeline, nicht über CloudFormation — das laufende Image ist also immer
ein anderes als `InitialDockerImage`. Ohne Gegenmaßnahme würfe jedes Stack-Update den Service auf ein
womöglich Monate altes, in ECR längst gelöschtes Image zurück (`CannotPullContainerError`).

**Lösung:** Eine Custom Resource liest das *tatsächlich laufende* Image aus ECS; die Task Definition
referenziert `Fn::GetAtt: [ImageResolver, Value]`.

> ⚠️ **Sie läuft nicht bei jedem Update.** CloudFormation ruft eine Custom Resource nur auf, wenn sich eine
> **ihrer Properties** ändert — `ServiceToken` bleibt gleich, auch wenn der Lambda-Code darin ausgetauscht
> wird. Ein reines Template-Update liefert daher den **zwischengespeicherten** Wert; im Change Set
> erscheint die Ressource als `Modify`/`Conditional` und beim Ausführen passiert nichts. Harmlos, solange
> der Cache stimmt — dort liegt aber das Restrisiko.

Ablauf (IAM: `ecs:DescribeServices` + `ecs:DescribeTaskDefinition`), jeder Zweig protokolliert seine
Entscheidung:

1. `Delete` → sofort `SUCCESS`.
2. `Create` → `InitialDockerImage`; beim Anlegen existiert noch kein Service.
3. `SkipImageResolver=true` → `InitialDockerImage`, ohne ECS zu befragen.
4. **`InitialDockerImage` in diesem Update geändert** → dieser Wert gewinnt (erkannt über
   `OldResourceProperties`).
5. Sonst → aktive Task Definition des Service, davon das Image des ersten Containers.
6. Jeder Fehler ist `FAILED` — das Update scheitert, statt still ein falsches Image zu setzen.

- **`SkipImageResolver`** (Default `true`): `true` für die Stack-Erstellung und solange das erste Deployment
  nicht stabil läuft, danach `false`.
- **Ein Image gezielt setzen geht ohne den Schalter** — Schritt 4. Der Schutz greift nur, wenn der Parameter
  *unverändert* bleibt.
- **Retry nach fehlgeschlagener Erstellung:** existiert der Service nicht mehr, schlägt die Lambda hart
  fehl; existiert er, ist aber nie gesund geworden, wird das kaputte Image immer wieder reanimiert. Beides
  löst `SkipImageResolver=true` mit korrektem `InitialDockerImage`.

**Verworfene Alternativen** — damit sie nicht alle paar Monate neu vorgeschlagen werden:

| Ansatz | Warum nicht |
|---|---|
| `cloudformation deploy` in der Pipeline | Bringt `ROLLBACK_FAILED` ins Spiel — schlimmer als ein fehlgeschlagener ECS-Deploy |
| SSM Parameter Store + direkter ECS-Deploy | Der Parameter überlebt das Löschen des Stacks als Waise |
| Mutabler ECR-Tag (`latest`) | Verliert die Rückverfolgbarkeit, und ECS zieht ohne Force-Deployment kein neues Image |
| Nur Prozessdisziplin | Nicht durchsetzbar |

Die präventive Lösung wäre, `DOPPLER_TOKEN` über Secrets Manager `valueFrom` zu beziehen — dann liefe das
Token gar nicht mehr durch ein Stack-Update. Als Option vermerkt, nicht umgesetzt.

## Wann ein altes Image zurückkommt

> **Ein altes Image kommt zurück, wenn CloudFormation die Task Definition neu schreibt, ohne dass der
> Resolver dabei läuft.** Dann setzt `Fn::GetAtt` den zwischengespeicherten Wert seines letzten Laufs ein.

Sieben Parameter beeinflussen die Task Definition; **ab `1.6.0` sind alle sieben Resolver-Properties** —
`ContainerCommand`, `ProjectEnv`, `ProjectNameShort`, `ServiceTrafficPort`, `TaskMemory`, `VolumeMountPath`
und, neu, `ProjectToken`.

| # | Auslöser | Warum der Resolver schweigt |
|---|---|---|
| 1 | **`ProjectToken` allein rotiert** — bis `1.5.0` | war keine Property. Ab `1.6.0` geschlossen |
| 2 | **Template-Änderung, die den `Task`-Block verändert** | eine Template-Änderung berührt keine Property |
| 3 | **Ein Update schlägt fehl und rollt zurück** | CloudFormation stellt seinen letzten Stand wieder her |
| 4 | **Der Service wird auf die CloudFormation-Revision gezogen** | Folge von 1–3: `Service.TaskDefinition` ist `{Ref: Task}` |
| 5 | **`SkipImageResolver` bleibt auf `true`** | er läuft, gibt aber bedingungslos `InitialDockerImage` zurück |

Fall 2 ist enger als er klingt: entscheidend ist, dass ein Update die `Task`-Ressource **wirklich** anfasst.
Fall 5 ist der einzige, der sich durch bloßes Nachsehen ausschließen lässt.

**Fall 4 unterschätzt man am ehesten**, weil er unsichtbar vorbereitet wird: die Pipeline registriert bei
jedem Deploy eine neue Revision direkt in ECS, CloudFormation kennt nur seine eigene, und beide Zählungen
laufen auseinander. Ein reines Template-Update ändert daran nichts — sobald aber einer der Fälle 1–3 eine
neue Revision erzeugt, zieht der Service mit. Wie weit sie auseinanderliegen:

```bash
aws ecs describe-services --cluster <cluster>-Ecscluster --services <stack>-Service \
  --query "services[0].taskDefinition" --output text
aws cloudformation describe-stack-resource --stack-name <stack> --logical-resource-id Task \
  --query "StackResourceDetail.PhysicalResourceId" --output text
```

> **Fall 1 ist ab `1.6.0` geschlossen.** Die frühere Annahme, `NoEcho`-Parameter könnten keine
> Custom-Resource-Properties sein, ist falsch: CloudFormation nimmt sie an und übergibt den Wert im
> Klartext, und eine Rotation weckt den Resolver. Neue Sichtbarkeit erkauft das nicht — ein Change Set
> meldet `ProjectToken` in `BeforeContext` wie `AfterContext` als `****`. `NoEcho` maskiert Ausgaben, nicht
> die Übergabe; übrig bleibt das Lambda-Event, erreichbar nur für den, der das Token ohnehin über
> `ecs:DescribeTaskDefinition` lesen kann.
>
> ⚠️ **Bei der Secrets-Migration muss diese Property mit weg.** Das erzwingt sich weitgehend selbst, weil
> `{"Ref": "ProjectToken"}` ungültig wird, sobald der Parameter entfernt wird — gefährlich ist nur eine
> Migration, die ihn behält.

Fall 2, 3 und 5 bleiben. **Erkannt werden alle fünf** vom ImageRegressionGuard.

**Die praktische Regel:** Wer den `Task`-Block ändert oder das Doppler-Token rotiert, gibt im selben Update
`InitialDockerImage` mit dem laufenden Image mit. Ab `1.5.0` gewinnt dieser Wert.

## ImageRegressionGuard

`EnableImageRegressionAlarm` (Default `true`). Trotz des Namens **kein CloudWatch-Alarm**, sondern
EventBridge-Regel plus Lambda, die direkt ins Cluster-`AlertTopic` publiziert: sie horcht auf
`SERVICE_DEPLOYMENT_IN_PROGRESS`, vergleicht die Deployments `PRIMARY` und `ACTIVE` und holt für beide
Images per `ecr:DescribeImages` die `imagePushedAt`. Ist das eingehende **älter**, geht eine Meldung raus.

- **Region und Account kommen aus der Bildreferenz selbst**, nicht aus der Region der Lambda — die
  Repositories liegen in `eu-central-1`, die Cluster nicht zwingend.
- **Vergleich bewusst „älter als das laufende", nicht „nicht das neueste in ECR"** — das Repo ist über
  Umgebungen geteilt, ein Staging-Push sähe sonst neuer aus als ein korrektes Produktions-Image.
- **Detektiv, nicht präventiv** — feuert beim Rollout-*Start*. Ergänzt den `DeploymentCircuitBreaker`, der
  nur bei Health-Fehlern zurückrollt. **Absichtliche Rollbacks lösen ihn ebenfalls aus.**
- ⚠️ **Er schweigt still, wenn eine Push-Zeit fehlt** — kein Alarm heißt nicht „geprüft und in Ordnung".
  Das betrifft **jedes Image außerhalb ECR** (`solr:9.9` trägt keinen Registry-Host) und jeden Tag, den die
  Lifecycle Policy gelöscht hat.
- **Von den Alarm-Schaltern des Clusters unberührt** — er publiziert direkt per `sns:Publish`. Steht der
  Cluster auf `dashboard`, ist er die einzige Meldung, die noch zugestellt wird.
- **Beim Einführen schützt er den eigenen Rollout noch nicht:** die EventBridge-Regel entsteht im selben
  Change Set, das `Service` und `Task` anfasst, ohne Abhängigkeit dorthin.

## Container, Deployment und Autoscaling eines Service

- **`NetworkMode: bridge` mit dynamischem Host-Port** (`HostPort: 0`) — daher der Ingress-Bereich
  32768–61000 in der Cluster-Security-Group.
- **`TaskMemory` passt auf die Instanzgröße:** die vier erlaubten Werte (`478`/`956`/`1434`/`1913`) sind
  ganze Bruchteile des belegbaren Speichers einer `t3.small`. Andere Werte hinterlassen einen Rest, der zu
  klein für einen weiteren Task ist. Der Wert ist eine Reservierung — ein zu großer kostet Cluster-Kapazität.
- ⚠️ **`DOPPLER_TOKEN` steht als Klartext-`Environment`-Wert in der Task Definition** und ist über
  `ecs:DescribeTaskDefinition` lesbar — das `NoEcho` am Parameter ist dadurch aufgehoben.
- **Eine Rolle für beides:** `TaskRole` ist `ExecutionRoleArn` *und* `TaskRoleArn` — sie darf ECR ziehen und
  in die eigene Log-Gruppe schreiben, sonst nichts.
- **Rolling Deployment mit `MaximumPercent: 200` / `MinimumHealthyPercent: 50`.** ⚠️ Bei `DesiredCount: 1`
  ergibt das `floor(1 × 0.5) = 0` — ECS darf die einzige Task stoppen, bevor die neue läuft, und die
  braucht `2 × 45 s` bis sie Verkehr bekommt. Rund 90 Sekunden 503 pro Deploy. Offener Punkt in TASKS.md.
- **`DeploymentCircuitBreaker` mit `Rollback: true`** — greift nur bei **Health**-Fehlern; ein altes, aber
  funktionierendes Image passiert ihn.
- **Platzierung:** erst `spread` über die AZs, dann `binpack` nach Memory.
- **Zwei Listener-Regeln auf derselben Priorität:** am HTTP-Listener eine `301` auf HTTPS unter Beibehaltung
  von Host, Pfad und Query; am HTTPS-Listener der Forward auf die eigene Target Group. Die 80→443-Umleitung
  macht also jeder Service selbst, nicht der Cluster.
- **Target Group:** Health Check alle 45 s, Timeout 15 s, gesund nach 2, ungesund nach 4, Matcher `200`,
  Deregistration Delay 120 s, keine Stickiness, `TargetType: instance`.
- **Autoscaling:** Step Scaling, ±1 Task, Cooldown 300 s. `MinCapacity` ist `ServiceDesiredCount`,
  `MaxCapacity` ist `ServiceMaxCapacity`.
- **Der Scale-in-Alarm ist Metrik-Mathematik:** `IF(cpu < Schwelle AND tasks > DesiredCount, 1, 0)` — so
  steht er im Normalbetrieb auf `OK` statt dauerhaft rot.
- ⚠️ **`Stat: Average` dort nicht auf `Sum` ändern.** Die ALB veröffentlicht `HealthyHostCount` pro AZ, aber
  durch Cross-Zone Load Balancing meldet jede AZ die **vollständige** Zahl. Mit `Sum` wäre
  `tasks > DesiredCount` dauerhaft wahr und jeder Service würde permanent auf MinCapacity gedrückt. Nur neu
  bewerten, falls `load_balancing.cross_zone.enabled` auf `false` gesetzt wird.
- **Rolling Deployments verdoppeln kurzzeitig `HealthyHostCount`** — der Scale-in-Alarm kann anschlagen, der
  Versuch ist ein No-op, `EvaluationPeriods: 5` überbrückt das Fenster.
- **CloudWatch Logs Anomaly Detection wird nicht mehr verwendet.** Apache-Access-Zeilen fallen alle auf
  **ein** Pattern zusammen, die Varianz steckt in den maskierten Tokens. Nicht wieder einbauen, ohne vorher
  das Logformat zu ändern.

## alb-logs-bucket

Ein Bucket pro Region, den sich alle Cluster dieser Region teilen — jeder schreibt unter eigenem Prefix.

- **Lifecycle deckt drei Fälle ab:** aktuelle Versionen nach `RetentionDays`, `NoncurrentVersionExpiration`
  nach 1 Tag, Delete-Marker und abgebrochene Multipart-Uploads nach 7 Tagen. Ohne die Noncurrent-Regel
  wüchse der Bucket trotz Versionierung unbegrenzt und höbe die DSGVO-Grenze auf.
- **Die Bucket-Policy ist regionsgebunden** — sie erlaubt dem Service-Principal
  `logdelivery.elasticloadbalancing.amazonaws.com` das Schreiben unter `AWSLogs/<account-id>/*`. Daher ein
  Bucket pro Region.

## guardduty

Detector, Quarantine Security Group (null Egress-Regeln) und Incident-Response-Rolle. `ClusterName` dient
**nur dem Tagging** und schränkt nichts ein; `FindingPublishingFrequency` steht auf `FIFTEEN_MINUTES`
(`SIX_HOURS` ist billiger, für zeitnahe Reaktion untauglich).

**Ein Stack pro Region, nicht pro Cluster.** Läge der Detector im Cluster-Template, schaltete das Löschen
eines Clusters die Threat Detection der ganzen Region ab.

---

# Blatt-Templates

## alb-ecsservice-rule

Zusätzliche Host/Pfad-Regel auf die Target Group eines bestehenden Service — je eine am HTTP- und am
HTTPS-Listener. **Nur für Services außerhalb von `ecsservice`** oder für zusätzliche Hostnamen.

## alb-redirect-rule

Reine Redirect-Regel ohne Target Group: HTTP auf HTTPS, HTTPS auf den Ziel-Hostnamen.

- **`301` nur bei dauerhaften Umleitungen.** Browser cachen ihn hartnäckig; für Vorläufiges `302`.
- ⚠️ **`ListenerRuleRedirectPath` wirft die Query weg.** Für einen Domain-Umzug leer lassen, sonst verlieren
  alle Deep Links ihre Parameter.

## alb-additional-certificate und certificate

ACM-Zertifikate mit DNS-Validierung — das erste als **zusätzliches** Zertifikat am HTTPS-Listener des
Clusters (bestehende bleiben unverändert), das zweite eigenständig ohne Bindung an einen Load Balancer.

- **Bei Root-Domains `AddWildcardSan=true`**, sonst deckt das Zertifikat `example.com`, aber kein
  `www.example.com` ab.

## cloudfront-alb-distribution

CloudFront vor einem ALB: HTTP/2 und HTTP/3, IPv6, SNI-only ab TLSv1.2, eigene Cache Policy (respektiert
`Cache-Control`, schließt Cookies aus dem Cache-Key aus), `AllViewer` Origin Request Policy,
`SecurityHeadersPolicy`, Origin-Verify-Header, optional ein eigenes WAF-WebACL. Keine Imports — der ALB
wird über seinen DNS-Namen als Parameter übergeben.

- **Das ALB-Zertifikat muss `DomainName` ebenfalls abdecken**, weil CloudFront den originalen `Host`-Header
  durchreicht.
- ⚠️ **`OriginVerifyValue` ist nur wirksam, wenn der ALB ihn erzwingt.** Das Template *sendet* den Header;
  die Listener-Regeln müssen Anfragen ohne ihn ablehnen — sonst bleibt der ALB direkt erreichbar und
  CloudFront umgehbar. Diese Durchsetzung fehlt bislang.
- **`EnableWAF=false` spart ~9 $/Monat**, entfernt aber SQLi-, XSS-, Bad-Input-, IP-Reputation- und
  Rate-Limiting-Schutz. AWS Shield Standard bleibt aktiv und kostenlos.

## global-accelerator-alb

Zwei statische Anycast-IPv4 vor einem ALB, TCP-Listener auf 80 und 443, eine Endpoint Group in der
Stack-Region mit Client-IP-Weiterleitung.

- **Für externe DNS-Provider ohne CNAME-Flattening** — die beiden IPs lassen sich direkt als A-Records
  eintragen. Das ist der eigentliche Grund für dieses Template.
- **`EndpointWeight` ist wirkungslos**, solange die Gruppe nur diesen einen ALB enthält.
- **`ClientAffinityEnabled=SOURCE_IP` nur bei echtem Bedarf** — es verschlechtert die Lastverteilung.
- **Kein Deployment in `us-east-1` nötig**, anders als bei CloudFront; verwaltet wird der Dienst intern in
  `us-west-2`.

---

# Allgemeine Hinweise

**Stack-Rolle.** Immer eine dedizierte IAM-Rolle für Erstellung und Update verwenden — siehe
[AWS-Dokumentation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html).

**ECR-Zugriff über Accounts hinweg.** Damit ein ECS-Service in einem anderen Account ECR-Images ziehen kann,
am Repository ergänzen (`$EXT_ACCOUNT_ID` ersetzen):

```json
{
  "Version": "2008-10-17",
  "Statement": [
    {
      "Sid": "EXTERNAL ACCOUNT - Allow ECR Access",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::$EXT_ACCOUNT_ID:root" },
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ]
    }
  ]
}
```
