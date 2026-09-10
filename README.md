# AWS CloudFormation Stacks

Dieses Repository enthält die AWS CloudFormation Stack-Templates, die von LABOR für die Bereitstellung von Infrastruktur und Anwendungen verwendet werden.

Parameter sind nicht hier dokumentiert: jeder Parameter trägt im Template eine `Description` und ist über `AWS::CloudFormation::Interface` gruppiert, die Konsole zeigt beides beim Deployment an. Diese Datei beschreibt pro Template **Zweck, Abhängigkeiten und Betriebswissen** — und zwar unabhängig davon, was gerade deployt ist. Was an den Templates noch aussteht und was die Cluster aktuell fahren, steht in [TASKS.md](TASKS.md); die Änderungshistorie ist die Git-Historie.

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

Pro Region in dieser Reihenfolge — der Name des Cluster-Stacks steht dabei schon vor Schritt 1 fest, weil Schritt 1 und 2 ihn brauchen:

1. **`alb-logs-bucket`** — liefert `BucketName` für den `LogsBucketName`-Parameter des Clusters. Alternativ den Cluster zuerst mit leerem `LogsBucketName` deployen und den Wert später nachziehen.
2. **`ecscluster-vpc-rds-asg/backup-vaults-mirror`** — **vor** dem Cluster, und in der **Zielregion** (`BackupCopyDestinationRegion` des Clusters, Default `eu-north-1`). Der Backup-Plan des Clusters läuft alle 6 h ab `00:30 UTC` und kopiert in fest benannte Vaults; fehlen sie, schlägt die erste Copy-Action fehl. `ClusterName` muss **exakt dem Namen des Cluster-Stacks** entsprechen, dieser Schritt setzt den Namen also voraus.
3. **`ecscluster-vpc-rds-asg`** — der Cluster selbst.
4. **`ecscluster-vpc-rds-asg/guardduty`** — **nach** dem Cluster, nicht davor: die Quarantine-SG importiert `${ClusterStackName}-Vpc`. Einmal pro Region, nicht pro Cluster.
5. **`ecsservice`** — pro Anwendung.
6. Optional: `alb-ecsservice-rule`, `alb-redirect-rule`, `alb-additional-certificate`, `cloudfront-alb-distribution`, `global-accelerator-alb`.

Die Reihenfolge ist nur zwischen 3 und 4 durch einen Import erzwungen. Schritt 1 und 2 lassen sich technisch auch nachziehen — dann fehlen aber bis dahin ALB-Logs bzw. die regionsübergreifenden Backup-Kopien.

**Cross-Stack-Kontrakt.** Die Abhängigkeiten laufen bis auf `LogsBucketName` über CloudFormation-Exports:

| Export | Erzeugt von | Genutzt von |
|---|---|---|
| `${Cluster}-Ecscluster` | Cluster | `ecsservice` |
| `${Cluster}-Vpc` | Cluster | `ecsservice`, `guardduty` |
| `${Cluster}-Efs` | Cluster | `ecsservice` |
| `${Cluster}-ListenerArnHttp` / `-ListenerArnHttps` | Cluster | `ecsservice`, `alb-ecsservice-rule`, `alb-redirect-rule`, `alb-additional-certificate` |
| `${Cluster}-LoadbalancerArn` | Cluster | `ecsservice` (Scale-in-Alarm), `global-accelerator-alb` |
| `${Cluster}-SubnetPrivate1` / `-SubnetPrivate2` | Cluster | derzeit von keinem Template importiert (für weitere RDS/VPN-Konfiguration) |
| `${Cluster}-SgVpcLoadbalancerportsAccess` | Cluster | derzeit von keinem Template importiert (zusätzliche Instanzen mit ALB-Zugriff) |
| `${Cluster}-WebAclArn` | Cluster (ab `1.2.0`) | derzeit von keinem Template importiert (Auswertung der WAF-Metriken) |
| `${Cluster}-Subnet1` / `-Subnet2` | Cluster | derzeit von keinem Template importiert (öffentliche Subnetze) |
| `${Cluster}-DnsFirewallWhitelistId` / `-DnsFirewallRuleGroupId` | Cluster | derzeit von keinem Template importiert (vorgesehen für Whitelist-Automation) |
| `${Cluster}-AlertTopicArn` | Cluster (ab `1.1.0`) | `ecsservice` (`AlarmActions`, `ImageRegressionGuard`); geplant: GuardDuty-Findings-Rule, Quarantäne-Automatik |
| `${LogsBucket}-BucketName` / `-BucketArn` | `alb-logs-bucket` | Cluster — aber **als Parameter `LogsBucketName` von Hand übergeben**, nicht per `Fn::ImportValue` |
| `${Service}-TargetGroupArn` | `ecsservice` | `alb-ecsservice-rule` |
| `${GuardDuty}-DetectorId` / `-DetectorArn` / `-QuarantineSgId` / `-IncidentResponseRoleArn` | `guardduty` | derzeit von keinem Template importiert (vorgesehen für die Quarantäne-Automatik) |
| `${Cert}-CertificateArn` | `certificate`, `alb-additional-certificate` | manuelle Zuweisung |

Ein Stack lässt sich nicht löschen, solange ein anderer seine Exports importiert. Beim Entfernen von Exports zuerst prüfen, ob externe Stacks sie referenzieren. Die Hälfte der Cluster-Exports wird aktuell von keinem Template im Repository importiert — sie sind trotzdem verbindlich, weil außerhalb des Repositories liegende Stacks sie referenzieren können.

Zwei Cluster-Outputs sind **keine** Exports und damit nicht importierbar, sondern nur über `describe-stacks` lesbar: `WafLogGroupName` und `TemplateVersion`.

---

## Templates

### ecscluster-vpc-rds-asg

Die vollständige Infrastruktur für den Betrieb von ECS-Services — ein Stack pro Region und Umgebung. Alle anderen Templates hängen an seinen Exports.

**Template-Version:** `1.5.0` — Output `TemplateVersion`, kein Export, also nur über `describe-stacks` lesbar.

> **Das Template ist zu groß für einen Inline-Deploy.** CloudFormation nimmt per `--template-body` höchstens 51.200 Byte; dieses Template liegt weit darüber. Deploys laufen deshalb über S3 (`--template-url`) oder die Konsole, die den Upload selbst übernimmt.

> **`AscalegroupDesSize` kann jedes Update zu einem Ausfall machen.** Der Parameter setzt die Wunschkapazität der Auto Scaling Group, sein `MaxValue` ist aber `15` — und ECS Managed Scaling verschiebt die tatsächliche Kapazität laufend, unabhängig davon. Liegt sie beim Update über dem Parameterwert, zieht CloudFormation sie herunter; weil `ManagedTerminationProtection` auf `DISABLED` steht, werden die Tasks der überzähligen Instanzen dabei **abgeworfen statt gedraint**. Deshalb gilt: Ist-Kapazität lesen und als Parameter mitgeben, und zwar **unmittelbar vor dem Ausführen** des Change Sets, nicht beim Erzeugen — dazwischen kann Managed Scaling sie bereits verschoben haben. Läuft die Gruppe über `15`, lässt sich die Realität mit diesem Parameter gar nicht ausdrücken; dann ist zuerst der `MaxValue` zu heben, nicht das Update zu erzwingen.
>
> Die Launch-Template-Version ist davon unberührt: die Auto Scaling Group trägt **keine `UpdatePolicy`**, ein neues AMI tauscht also keine laufende Instanz aus. Bestehende Instanzen behalten ihre Version, nur neu gestartete bekommen die neue — eine gemischte Flotte nach einem Update ist der Normalfall, kein Befund.

#### Netzwerk

- DHCP-Options setzen hartcodiert `DomainName: ec2.internal` — das ist die `us-east-1`-Schreibweise, außerhalb heißt die Zone `<region>.compute.internal`. Relevant beim Pflegen der DNS-Firewall-Whitelist.

#### Datenbank — Aurora MySQL

- **TLS erzwungen** (`require_secure_transport = ON`), Storage verschlüsselt, nicht öffentlich erreichbar.
- **Backup:** `BackupRetentionPeriod` hartcodiert auf **1 Tag** — automatische Aurora-Snapshots decken nur 24 h ab, alles darüber kommt aus AWS Backup (siehe unten).
- `slow_query_log = 1`, Schwelle ist `long_query_time` (Engine-Default 10 s). Für einen vollständigen Trace `long_query_time = 0` setzen (dynamisch) — dann `RdsSlowQueryAlarm` vorübergehend anheben.

#### Dateisystem — EFS

- **TLS beim Mount** — jeder Service mountet über die Task Definition mit `TransitEncryption: ENABLED`; Storage verschlüsselt.
- **Backup:** derselbe Plan wie RDS (siehe unten), EFS und RDS hängen als zwei Selections am selben Plan.

#### Backup

- **Zwei Regeln, beide auf EFS *und* RDS:** alle 6 h ab `00:30 UTC` → 35 Tage (`${Stack}-BackupVault`); sonntags `05:00 UTC` → 365 Tage (`${Stack}-BackupLongTermVault`).
- **Mirror-Copy in die Zielregion** für beide Regeln, Ziel-Vaults `${ClusterName}-BackupVault-Mirror` und `${ClusterName}-BackupLongTermVault-Mirror`. Die legt dieser Stack **nicht** an — dafür ist `backup-vaults-mirror`, deployt **vor** dem Cluster.

#### DNS Firewall

- Zwei Regeln: Whitelist `ALLOW` (Prio 100), Catch-all `*` (Prio 200). Der Default des Catch-all ist **`ALERT`**, es wird also protokolliert und trotzdem aufgelöst — Auditmodus.
- **Ab `1.7.0` ist die Durchsetzung ein Parameter, kein Template-Eingriff mehr.** `DnsFirewallCatchAllAction` schaltet zwischen `ALERT` und `BLOCK`, `DnsFirewallBlockResponse` bestimmt die Antwort (`NXDOMAIN` oder `NODATA`, Default `NXDOMAIN`). Zurück geht es genauso — ein Parameter-Update auf `ALERT`.
  - `BlockResponse` wird über `Fn::If` **nur bei `BLOCK` gesetzt**: Route 53 weist die Property an einer `ALERT`-Regel zurück, deshalb fällt sie sonst per `AWS::NoValue` ganz weg.
  - `NXDOMAIN` meldet die Domain als nicht existent, was Clients sofort als sauberen Fehler sehen. `NODATA` meldet den Namen als vorhanden, nur ohne Record des gefragten Typs — manche Clients probieren dann weitere Typen durch. `NXDOMAIN` ist die bessere Voreinstellung, weil ein schneller eindeutiger Fehler leichter zu finden ist als ein Timeout.
- **Vor dem Umschalten auf `BLOCK`:** `DnsFireWallLogsSummary` über mindestens 7 Tage laufen lassen und prüfen, dass keine legitime Domain mehr `ALERT`t. Die typische Lücke sind die Registry-Hostnamen — ein blockierender Catch-all stört den **laufenden** Container nicht, er bricht den Image-Pull beim nächsten Task-Placement. Ein Anwendungstest läuft dadurch grün, während nichts mehr neu starten oder skalieren kann.
- **Die CNAME-Kette wird mitgeprüft — das ist der Fallstrick.** AWS' Default ist, **alle** Glieder einer Weiterleitung zu bewerten. Ein Name auf der Whitelist, dessen Kette die Liste verlässt, löst deshalb trotzdem den Catch-all aus — und der Log-Eintrag trägt den **ursprünglich angefragten Namen**, sieht also so aus, als hätte der Whitelist-Eintrag versagt. Gemessen in Paris am 2026-09-10: `login.microsoftonline.com` ist durch `*.microsoftonline.com` gedeckt und alarmierte durchgehend, weil die Kette über `login.mso.msidentity.com` → `ak.privatelink.msidentity.com` → `www.tm.a.prd.aadg.trafficmanager.net` läuft und `*.msidentity.com` fehlt. Ebenso `graph.microsoft.com`, und `download.docker.com` über `d2h67oheeuigaw.cloudfront.net`.
- **`DnsFirewallRedirectionAction`** (ab `1.7.0`, Default `TRUST_REDIRECTION_DOMAIN`) stellt das auf der ALLOW-Regel um: ist der angefragte Name erlaubt, gilt die Kette als erlaubt. `INSPECT_REDIRECTION_DOMAIN` ist AWS' Default und das bisherige Verhalten.
  - Warum `TRUST`, obwohl `INSPECT` strenger klingt: um `download.docker.com` unter `INSPECT` durchzulassen, müsstest du `*.cloudfront.net` erlauben — ganz CloudFront, jeden Bucket jedes AWS-Kunden — und danach `*.fastly.net`, `*.akamaiedge.net` und wohin die Kette als Nächstes zieht. `TRUST` auf `*.docker.com` ist die **engere** Erlaubnis.
  - Aufgegeben wird damit der Schutz gegen einen Angreifer, der das DNS einer gelisteten Domain kontrolliert. Der realistische Fall — eine übernommene verwaiste Subdomain — landet meist bei einem Cloud-Anbieter unter `*.amazonaws.com`, das diese Liste ohnehin erlaubt; `INSPECT` hätte ihn also auch nicht erwischt.
- **Wildcards decken mehrere Ebenen ab.** `*.example.com` trifft `foo.example.com` ebenso wie `a.b.example.com`; der Stern muss das linkeste Label vollständig ersetzen, `*prod.example.com` ist ungültig. Die Apex-Domain selbst deckt er **nicht** ab — die gehört separat auf die Liste.
- **`ALLOW` erzeugt keinen Logeintrag.** Erlaubte Anfragen sehen im Query-Log genauso aus wie nicht bewertete: kein `firewall_rule_action`, keine `firewall_rule_group_id`. Aus der Abwesenheit eines ALERT lässt sich deshalb nicht schließen, dass eine Anfrage ungeprüft durchlief — sie kann ebenso gut erlaubt worden sein.
- Auswertung: Log-Gruppe `${Stack}-DnsFirewallLogs`, Metriken `AlertedQueries` und `BlockedQueries`, Query `DnsFireWallLogsSummary`.
- **Zwei Alarme, weil zwei verschiedene Fragen.**
  - `${Stack}-dns-firewall-alert-surge` (`DnsFirewallAlarmAction`, Schwelle `100`/5 Min.) fragt *„wird ungewöhnlich viel Unbekanntes aufgelöst"*. Ein **Mengenalarm** — bei gemessenen ~4 ALERTs pro Stunde bewegt ihn eine einzelne neue Domain nie. Wer wissen will, welche Namen neu sind, nimmt die gespeicherte Query.
  - `${Stack}-dns-firewall-blocked` (`DnsFirewallBlockAlarmAction`, Default **`alert`**, Schwelle `0`) fragt *„wurde etwas abgewiesen"*. Existiert nur, wenn `DnsFirewallCatchAllAction` auf `BLOCK` steht — bei `ALERT` wird er gar nicht angelegt, deshalb darf er ohne Nebenwirkung auf `alert` stehen.
- **Warum der zweite Alarm nötig ist:** eine blockierte Auflösung stört keinen laufenden Container, sie bricht das **nächste** Task-Placement. Ohne ihn zeigt sich ein fehlender Whitelist-Eintrag erst beim nächsten Deployment oder Scale-out — und der Mengenalarm bliebe die ganze Zeit still, weil eine Handvoll abgewiesener Anfragen weit unter seiner Schwelle liegt.
- **Ein Neuheitsdetektor fehlt weiterhin.** Weder Alarm merkt, dass eine *neue* Domain im `ALERT`-Modus auftaucht — Metric Filter zählen Treffer, sie verfolgen keine Domain-Kardinalität. Vor dem Umschalten ist das Kriterium ohnehin „die ALERT-Rate geht auf null und bleibt dort".
- ⚠️ **Zwei Metriken, weil die Firewall unter `BLOCK` eine andere Aktion ins Log schreibt.** Bis `1.6.0` zählte nur ein Filter auf `firewall_rule_action = "ALERT"` — der hätte im Moment des Umschaltens aufgehört zu zählen, und Alarm wie gespeicherte Query wären still auf null gefallen. Genau dann, wenn man sie braucht. Seit `1.7.0` gibt es beide Filter, der Alarm summiert sie per `SUM([alerted, blocked])` und überlebt den Wechsel ohne Zutun; die Query zeigt die Aktion als eigene Spalte.
- Der Alarmname trägt weiterhin `alert-surge`, obwohl er beides abdeckt. Umbenennen würde den Alarm ersetzen und seine Zustandshistorie verwerfen — und die ist das einzige Argument dafür, ihn überhaupt auf `alert` zu lassen (Frankfurt: null Wechsel seit 2026-07-09).
- Parameter: `DnsFirewallWhitelistDomains` (Kommaliste, darf nicht leer sein), `DnsFirewallCatchAllAction`, `DnsFirewallBlockResponse`.
- **Was die DNS Firewall nicht kann:** sie sieht nur Anfragen an den VPC-Resolver. Ein Prozess, der einen externen Resolver anspricht oder eine IP direkt anwählt, läuft an ihr vorbei — deshalb ergibt `BLOCK` erst zusammen mit `53 → VPC-CIDR` in den Egress-Regeln ein geschlossenes Bild.

#### Egress der EC2-Instanzen

**Zwei Parameter.** `EgressPolicy` (`open`/`restricted`, Default `open`) und `EgressExtraRules`. `open` ist eine explizite Allow-all-Regel, identisch zu dem, was die Gruppen vorher implizit hatten — das Deployment ändert also nichts. Rückweg ist ein Parameter-Update.

| Regel | Ziel | Woher |
|---|---|---|
| `443/TCP` | `0.0.0.0/0` | fest, nicht abschaltbar |
| `53/UDP` + `53/TCP` | **VPC-CIDR** | fest, nicht abschaltbar |
| bis zu vier weitere TCP-Regeln | je eigene CIDR | `EgressExtraRules` |

`EgressExtraRules` nimmt `port:cidr`-Paare, Default `587:95.217.210.26/32,4318:149.248.216.54/32` — SMTP-Relay und OTLP-Collector, beide in Paris gemessen. `0:0.0.0.0/0` heißt „keine". **Andere Regionen müssen eigene Werte setzen**; Frankfurt ist ungemessen, und dieser Default würde dort den Mailversand auf den falschen Host festnageln.

- **Port und Ziel stehen im selben Eintrag**, nicht in zwei parallelen Listen. Zwei Listen, deren Positionen auseinanderlaufen, öffnen still den falschen Port zum falschen Ziel.
- **Warum Zieladressen überhaupt zählen:** die DNS-Firewall sieht nie eine Verbindung. Sie beantwortet oder verweigert eine Namensauflösung — wer die IP schon kennt, verbindet, ohne je zu fragen. Die CIDR in der Security-Group-Regel ist damit das **einzige** im Template, das begrenzt, wohin Verkehr tatsächlich darf.
- **`53` ist die Klammer zur DNS-Firewall.** Sie zwingt jede Auflösung über den VPC-Resolver. Ohne sie fragt ein Prozess `8.8.8.8` und ein `BLOCK`-Catch-all bedeutet nichts. Kosten: gemessene vier Anfragen von einem Host in 14 Tagen.
- **`443` lässt sich nicht anpinnen**, weil Drittanbieter über Namen erreicht werden und ihre Adressen wechseln. Eine gepinnte Regel bräche still, sobald ein CDN umzieht.
- **Feste Slots statt Liste.** Reines CloudFormation kann aus einer Liste unbekannter Länge keine N Regeln bauen; das bräuchte `Fn::ForEach` aus `AWS::LanguageExtensions`. Der Transform ist hier ausgeschlossen, weil er „Use existing template"-Updates unbrauchbar macht — und genau die sind der Weg, auf dem in diesem Repo jede Promotion läuft. Mehr als vier Zusatzregeln heißt deshalb Template-Änderung.
- **`80/TCP` fehlt bewusst.** In 28 Tagen ACCEPT-Logs von keiner Cluster-Instanz benutzt, nur von der eigenständigen Ubuntu-Box, die nicht am Launch Template hängt. Das OCSP/CRL-Gegenargument trägt kaum: Stapling verlagert den Abruf auf den Server, serverseitige TLS-Bibliotheken prüfen meist gar nicht, und Let's Encrypt hat OCSP eingestellt. Vor allem aber **meldet sich ein fehlender Port von selbst** — nach der Härtung erzeugt legitimer Verkehr keine Ablehnungen mehr, jeder `REJECT` wird zum Signal mit Quelle und Ziel.
- **`123/UDP` fehlt aus einem gemessenen Grund.** `169.254.169.123` ist link-local, wird vom Hypervisor beantwortet und unterliegt keiner Security Group. Auf allen sieben Pariser Instanzen ist das die *gewählte* Chrony-Quelle; die öffentlichen AWS-NTP-Server sind bloße Fallbacks und haben die ~27.000 Flows im Log erzeugt.
- **Warum eine eigene Gruppe `SgEgress`:** SG-Regeln sind **additiv** über alle Gruppen einer Instanz. `SgVpcMysqlAccess`, `SgVpcLoadbalancerports` und `SgVpcEfsAccess` hängen alle drei am Launch Template — eine davon zu beschränken bewirkt nichts. Unter `restricted` tragen die drei nur noch eine Platzhalterregel auf `127.0.0.1/32`. Die ist kein Zierrat: eine **leere** `SecurityGroupEgress`-Liste lässt CloudFormation die Standardregel wieder anlegen, „kein Egress" muss also als Regel geschrieben werden, die nirgendwo hinführt.
- ⚠️ **Reihenfolge — der eine Weg, sich auszusperren.** `SgEgress` erreicht eine Instanz über das Launch Template, und die `Ascalegroup` hat **keine `UpdatePolicy`**: eine Template-Änderung tauscht keine Instanzen aus. Wer vorher die Flotte nicht erneuert hat, hat Instanzen ohne `SgEgress` — und die Neutralisierung der drei bestehenden Gruppen greift auf deren ENIs **sofort**. Ergebnis: kompletter Egress-Verlust auf genau diesen Instanzen. Vorher prüfen:
  ```bash
  aws ec2 describe-instances --filters Name=tag:Name,Values=<stack>-Instance \
    --query 'Reservations[].Instances[].[InstanceId,SecurityGroups[].GroupName]' --output text
  ```
- **Was `restricted` leistet:** jeder andere Port ist zu — keine Reverse Shell, kein ausgehendes SSH, kein Datenbankclient, kein Spam-Relay. Zusammen mit der DNS-Firewall löst kein Name außerhalb der Whitelist auf. Und der REJECT-Log wird zum Signal.
- **Was es nicht leistet**, damit niemand den Schalter für Egress-Kontrolle hält: `443` bleibt zu jeder Adresse offen, und das genügt jedem, der bereits Codeausführung hat. Eine hart eingetragene IP braucht keine Auflösung, die DNS-Firewall sieht sie nie. **DNS-over-HTTPS ist schlimmer:** es läuft auf 443 zu Resolvern, deren Adressen in jedem Client fest eingebaut sind — umgeht also die 53er-Regel *und* die Firewall und sieht dabei wie normales TLS aus. Das zu schließen hieße, die Verbindung zu prüfen statt die Auflösung: AWS Network Firewall über den TLS-SNI, oder ein Forward-Proxy. Beides kostet echtes Geld und ist eine eigene Entscheidung.
- Nicht angewendet auf `SgPublicHttpHttps`, `SgVpcLoadbalancerportsAccess`, `SgVpcMysql`, `SgVpcEfs`: der ALB braucht Egress zu seinen Targets, die anderen initiieren nach außen nichts.
- **Fehlerbild:** eine zu enge Regelmenge bricht keine laufenden Container, sie bricht den nächsten Image-Pull. Nichts startet oder skaliert mehr, während alles gesund aussieht. Task-Placement beobachten, nicht die Website.

#### VPC Flow Logs

- **Ein Flow Log auf VPC-Ebene nach CloudWatch, `TrafficType: REJECT`** — nur abgelehnte Verbindungen. `ALL` erzeugt ein Vielfaches an Volumen und Kosten und liefert für die Portscan-Erkennung nichts dazu.
- **`EnableEgressAnalysis=true` legt einen zweiten Flow Log im ACCEPT-Modus an** (eigene Log-Gruppe und eigene Rolle) — die Grundlage für die Egress-Port-Baseline der SG-Härtung. Temporär gedacht: nach 7–14 Tagen zurück auf `false`, ACCEPT-Logs werden pro GB abgerechnet.
- Auswertung: Metrik `RejectedConnections`, Alarm `${Stack}-vpc-rejected-surge`, Query `VpcFlowLogsRejectedTraffic`, dazu das einzige Alarm-Widget auf dem Dashboard. Der ACCEPT-Log wird nur von `VpcEgressPortsAnalysis` gelesen, nicht alarmiert.
- Parameter: `EnableEgressAnalysis` (`false`).

#### WAF

Ein `REGIONAL` WebACL am ALB (`DefaultAction: Allow`), schützt alle Services dahinter. Nicht zu verwechseln mit dem WebACL in `cloudfront-alb-distribution`.

| Prio | Regel | Action-Parameter | Prüft |
|---|---|---|---|
| 20 | `AWSManagedRulesCommonRuleSet` | `CommonRuleSetAction` | XSS, Path Traversal, fehlerhafte Requests, schlechte User Agents — häufigste False-Positive-Quelle auf TYPO3/Matomo |
| 30 | `AWSManagedRulesKnownBadInputsRuleSet` | `KnownBadInputsAction` | Payloads breit ausgenutzter CVEs (Log4Shell, Java-Deserialisierung) |
| 40 | `AWSManagedRulesSQLiRuleSet` | `SqliRuleSetAction` | SQL-Injection |
| 50 | `AWSManagedRulesWordPressRuleSet` | `WordPressRulesAction` | WordPress-Signaturen |
| 90 | `RateLimitForwardedIp` | `RateLimitAction` | Rate-Limit auf den Client-IP-Header; existiert nur mit `WafClientIpHeader` |
| 91 | `RateLimitSourceIp` | `RateLimitAction` | Rate-Limit auf die Source IP |

- **Fünf `off`/`count`/`block`-Schalter für sechs Regeln** (beide Rate-Regeln teilen `RateLimitAction`), Default überall `count` — **beim ersten Deploy wird nichts blockiert.** Promotion pro Regel: eine Woche `CountedRequests` lesen, dann auf `block`.
- **`RateLimitAction=block` ohne `WafClientIpHeader` lehnt CloudFormation ab** (`Rules`-Sektion `WafRateLimitNeedsClientIpHeader`). Grund: bei proxied Sites aggregieren sonst alle Requests auf Cloudflares Adressen und ein Block sperrt Cloudflare für alle Sites aus. Der Header ist nur vertrauenswürdig, solange der ALB nicht direkt erreichbar ist — sonst fälschbar.
- **Logging:** vollständige Requests nach `aws-waf-logs-${Stack}-waf`, `authorization` und `cookie` redigiert. Retention **14 Tage, festverdrahtet** wie bei allen Log-Gruppen — nicht parametrisierbar.
- **Ein ALB kann nur ein WebACL tragen.** Dieses Template hängt seines per `WafWebAclAssociation` direkt an den Loadbalancer. Wurde je eines manuell angehängt, kollidiert die Association und das Stack-Update scheitert — vorher `aws wafv2 get-web-acl-for-resource --resource-arn <alb-arn>` prüfen.
- Weitere Parameter: `WafRateLimitRequests` (`2000`), `WafClientIpHeader` (leer; zwingend kleingeschrieben).

#### Logs

Sechs CloudWatch-Log-Gruppen plus die ALB Access Logs in S3. **Alle auf 14 Tage Retention festverdrahtet (DSGVO)** — keine ist per Parameter einstellbar, jede Analyse ist damit auf zwei Wochen begrenzt.

**Ansehen:** Konsole → CloudWatch → Logs → Log groups.

| Log-Gruppe | Was drinsteht | Wozu | Parameter |
|---|---|---|---|
| `${Stack}-VpcFlowLogs` | abgelehnte VPC-Verbindungen (**nur `REJECT`**) | Portscans, falsch konfigurierte Services. `ALL` erzeugt ein Vielfaches an Volumen und Kosten und liefert für diesen Zweck nichts dazu | — |
| `${Stack}-VpcAcceptFlowLogs` | erlaubte VPC-Verbindungen (`ACCEPT`) | temporäre Egress-Port-Baseline für die SG-Härtung. **Nach 7–14 Tagen wieder aus** — wird pro GB abgerechnet | `EnableEgressAnalysis` (`false`) legt Log + Gruppe an |
| `${Stack}-DnsFirewallLogs` | alle DNS-Anfragen aus der VPC inkl. Firewall-Aktion | Whitelist-Kandidaten sammeln, unerwartete Ziele erkennen | — |
| `/aws/rds/cluster/<Rdscl>/error` | Aurora Error Log | DB-Fehler | — |
| `/aws/rds/cluster/<Rdscl>/slowquery` | Aurora Slow Query Log (über `long_query_time`) | langsame Statements mit `Query_time`/`Rows_examined` | Schwelle über den DB-Parameter, nicht über den Stack |
| `aws-waf-logs-${Stack}-waf` | vollständige Requests, `authorization`/`cookie` redigiert | nachvollziehen, welche Regel warum getroffen hat | — |
| S3 `<LogsBucket>/<Stack>/` | ALB Access Logs | Statuscodes und URLs — die Nachverfolgung für alle HTTP-Alarme | `LogsBucketName` (leer = aus) |

##### Gespeicherte Queries zu diesen Logs

Für die typischen Fragen liegen fünf Logs-Insights-Queries im Stack — Konsole → CloudWatch → Logs Insights → *Queries*. Jede bringt ihre Log-Gruppe und ein passendes Zeitfenster schon mit:

| Query | Fenster | Zweck |
|---|---|---|
| `VpcEgressPortsAnalysis` | 7 Tage | Ziel-Ports und Volumen ausgehender Verbindungen (braucht `EnableEgressAnalysis=true`) |
| `DnsFireWallLogsSummary` | 14 Tage | ALERT-Domains nach Häufigkeit — die Whitelist-Kandidatenliste |
| `VpcFlowLogsRejectedTraffic` | 1 Stunde | abgelehnte Verbindungen nach Quell-IP und Ziel-Port |
| `RdsErrorLogSummary` | 24 Stunden | `[ERROR]`- und `[Warning]`-Zeilen |
| `RdsSlowQuerySummary` | 24 Stunden | Slow Queries nach `Query_time` sortiert |

##### Vom Logeintrag zum Alarm

Vier **Metric Filter** zählen passende Zeilen und schreiben sie als Metrik fort — erst dadurch wird ein Log alarmierbar: `${Stack}-DnsFirewallLogs` → `AlertedQueries`, `${Stack}-VpcFlowLogs` → `RejectedConnections`, RDS Error Log → `ErrorCount`, RDS Slow Query Log → `SlowQueryCount`. Diese vier Metriken tragen die ersten vier Alarme unten; die sechs WAF-Alarme lesen dagegen direkt die Metriken aus `AWS/WAFV2`.

#### Alarme

Zwölf Alarme, fast alle nach demselben Muster: **Summe über 5 Minuten, eine Auswertungsperiode, `notBreaching` bei fehlenden Daten.** Keine Dauer- oder Trendalarme. Einzige Ausnahme ist `${Stack}-rds-connections`, der `Maximum` statt `Sum` auswertet — Begründung unten.

> `notBreaching` hat eine Kehrseite: schreibt ein Metric Filter nie einen Datenpunkt, steht sein Alarm dauerhaft auf `OK` — ununterscheidbar von „alles in Ordnung". Ein `OK` ist deshalb nur dann eine Aussage, wenn die zugehörige Metrik nachweislich Datenpunkte liefert. Das trifft besonders `SlowQueryCount`: `long_query_time` bleibt beim Engine-Default von 10 s, und solange keine Query so lange läuft, bleibt das Log leer und der Alarm stumm, obwohl beides korrekt konfiguriert ist. Vor dem Heben eines Alarms auf `alert` also erst prüfen, ob seine Metrik überhaupt schreibt.

> `dashboard` legt **kein** CloudWatch-Dashboard an — das Template enthält keine Dashboard-Ressource. Der Modus bedeutet allein `ActionsEnabled: false`: der Alarm liegt wie jeder andere unter CloudWatch → Alarms, wechselt sichtbar den Zustand und schreibt Historie, löst aber keine Aktion aus.

**Jeder hat einen `off`/`dashboard`/`alert`-Schalter, Default überall `dashboard`:**

- `off` — Alarm wird nicht angelegt.
- `dashboard` — Alarm existiert, Zustand und History laufen, aber `ActionsEnabled: false`: **keine Benachrichtigung**. Der Zustand zum Kalibrieren, ohne die Historie wegzuwerfen.
- `alert` — publiziert zusätzlich ins Cluster-Topic.

**Konsequenz: nach einem frischen Deploy benachrichtigt der Cluster-Stack niemanden.** Einzelne Alarme bewusst auf `alert` heben, sobald ihre Schwelle gegen echten Traffic gelesen wurde — sinnvoll zuerst bei `KnownBadInputs` und `SQLi` (leise und aussagekräftig), nicht bei `CommonRuleSet` (Grundrauschen).

| Alarm (Name in der Konsole) | Was er misst | Schwelle | Wozu | Parameter |
|---|---|---|---|---|
| `${Stack}-dns-firewall-alert-surge` | DNS-Anfragen mit Firewall-Aktion `ALERT` | `100` | Sprung = unerwarteter externer Zugriff → `DnsFireWallLogsSummary` | `DnsFirewallAlarmAction` / `DnsFirewallAlarmThreshold` |
| `${Stack}-vpc-rejected-surge` | abgelehnte VPC-Verbindungen | `500` | Portscan oder kaputte Service-Konfiguration → `VpcFlowLogsRejectedTraffic` | `VpcFlowLogsAlarmAction` / `VpcFlowLogsAlarmThreshold` |
| `${Stack}-rds-error` | `[ERROR]`-Zeilen im Aurora Error Log | `0` | feuert bei **jedem** Eintrag — die lauteste Quelle, erst beobachten. Hochsetzen verschluckt Datenbankfehler | `RdsErrorAlarmAction` / `RdsErrorAlarmThreshold` |
| `${Stack}-rds-slow-queries` | Slow-Query-Zeilen | `5` | mehr als fünf langsame Queries/5 Min. Schwelle „langsam" steuert `RdsLongQueryTime` (Default `2` s). Bei `RdsLongQueryTime = 0` vorübergehend anheben | `RdsSlowQueryAlarmAction` / `RdsSlowQueryAlarmThreshold` |
| `${Stack}-elb-5xx` | 5xx **vom Load Balancer selbst** (502/503/504) | `10` | was der Besucher sieht, wenn ein Service nicht mehr antwortet — für die Target-5xx-Alarme der Services unsichtbar | `ElbHttp5xxAlarmAction` / `ElbHttp5xxAlarmThreshold` |
| `${Stack}-rds-connections` | offene Datenbankverbindungen (`Maximum`/5 Min.) | `60` | der einzige Alarm, der Verbindungserschöpfung **kommen** sieht — ist das Budget voll, antworten alle Services gleichzeitig mit 500 | `RdsConnectionsAlarmAction` / `RdsConnectionsAlarmThreshold` |
| `${Stack}-AlarmWafCommonRuleSet` | WAF-Treffer dieser Regel | `300` | mit Abstand die trefferstärkste Regel — eine niedrige Schwelle wäre dauerhaft rot | `CommonRuleSetAlarmAction` / `CommonRuleSetAlarmThreshold` |
| `${Stack}-AlarmWafKnownBadInputs` | WAF-Treffer dieser Regel | `50` | sollte auf legitimem Traffic fast still sein — ein Anstieg ist das interessanteste Signal der fünf | `KnownBadInputsAlarmAction` / `KnownBadInputsAlarmThreshold` |
| `${Stack}-AlarmWafSQLi` | WAF-Treffer dieser Regel | `20` | die leiseste Managed-Gruppe — verträgt eine enge Schwelle | `SqliRuleSetAlarmAction` / `SqliRuleSetAlarmThreshold` |
| `${Stack}-AlarmWafWordPress` | WAF-Treffer dieser Regel | `20` | ähnlich leise wie SQLi | `WordPressRulesAlarmAction` / `WordPressRulesAlarmThreshold` |
| `${Stack}-AlarmWafRateLimitSourceIp` | WAF-Treffer dieser Regel | `10` | schlägt praktisch nie an, solange das Limit nicht gesenkt wird | `RateLimitAlarmAction` / `RateLimitAlarmThreshold` |
| `${Stack}-AlarmWafRateLimitForwardedIp` | WAF-Treffer dieser Regel | `10` | wie oben; existiert nur mit `WafClientIpHeader` | dieselben — beide Rate-Alarme teilen Schalter und Schwelle |

- **Jeder Alarm hat neben dem Schalter auch einen Schwellenparameter** (`<Alarm>AlarmThreshold`, ausgeschrieben in der Tabelle oben), die Defaults stehen oben. Einzige Ausnahme: die beiden Rate-Limit-Alarme teilen sich `RateLimitAlarmThreshold`, wie schon ihre Regel. Kalibrieren endet damit überall in einer Parameteränderung, nicht in einem Template-Eingriff.
- **`RdsErrorAlarmThreshold` ist der einzige, der `0` erlaubt** — und `0` ist dort der eigentliche Zweck: jede `[ERROR]`-Zeile schlägt an. Alle anderen beginnen bei `1`.
- **`RdsLongQueryTime` entscheidet, ob der Slow-Query-Log überhaupt etwas enthält.** Ohne den Parameter galt MySQLs Default von 10 Sekunden — auf diesem Cluster fünf Zeilen in vierzehn Tagen, das Log war eingeschaltet und maß nichts. Der neue Default `2` stammt aus einer Messung vom 08.09.2026: `SelectLatency` im Wochenschnitt 1,09 ms, `InsertLatency` 0,18 ms, aber eine Stunde mit `UpdateLatency` von 426 ms. HTTP-Requests lagen bei p95 0,47 s und p99 1,10 s, was die Query-Dauer nach oben begrenzt. Dynamischer Parameter, wirkt ohne Neustart.
- **`elb-5xx` ist cluster-weit, nicht pro Service.** `HTTPCode_ELB_5XX_Count` trägt **keine** `TargetGroup`-Dimension — deshalb liegt der Alarm hier und nicht in `ecsservice` neben `AlarmHttp5xxTarget`. Er sagt, dass etwas nicht erreichbar ist, nicht *was*: dafür das Alarmfenster gegen `HTTPCode_Target_5XX_Count` und `UnHealthyHostCount` je Target Group legen. Prüfen mit `aws cloudwatch list-metrics --namespace AWS/ApplicationELB --metric-name HTTPCode_ELB_5XX_Count`.
- **Warum `10` und nicht `0`:** Deploys tragen legitim bei. Mit `MinimumHealthyPercent: 50` hat ein Service mit einer Task kurzzeitig kein gesundes Ziel, und der ALB antwortet mit 503. Eine Null-Schwelle wäre bei jedem Deploy rot.
- **`rds-connections` misst `Maximum`, nicht `Sum`.** `DatabaseConnections` ist ein Momentanwert; die Datenpunkte einer Periode zu summieren ergäbe ein Vielfaches der echten Zahl. Die Obergrenze dahinter ist `max_connections` aus `Rdsinstance1ParameterGroup` — auf `db.t3.medium` rund **138–145**, weil `log` in einer RDS-Parameterformel **Basis 2** ist und der Multiplikator `60` ein Drittel über dem Aurora-Default (`45`, also 104–109) liegt. Der Default `60` entspricht damit knapp 45 % der Grenze. Anhaltspunkte aus Frankfurt: nachts 2–5 Verbindungen, beim Vorfall am 08.09.2026 Spitze 96. Den effektiven Wert einmal an der Instanz ablesen statt der Rechnung zu vertrauen.
- **Dieser Alarm ist cluster-weit, nicht pro Service.** Alle Service-Stacks teilen sich ein `max_connections`-Budget. Er sagt deshalb, *dass* es eng wird, nicht *wer* die Verbindungen hält — dafür `DatabaseConnections` pro Minute gegen die Service-Logs legen.
- **Jeder WAF-Alarm folgt dem Modus seiner Regel:** `CountedRequests` solange sie zählt, `BlockedRequests` sobald sie blockt. Dieselbe Schwelle gilt vor und nach der Promotion.
- **Ansehen:** Konsole → CloudWatch → Alarms (auch die `dashboard`-Alarme stehen dort mit Zustand und History). Die Alarme der Service-Stacks liegen in `ecsservice`, benachrichtigen aber über dasselbe Topic.

#### Benachrichtigung und Dashboard

- **Ein SNS-Topic pro Cluster** (`${Stack}-alerts`, Export `-AlertTopicArn`) — für Cluster- *und* Service-Alarme. Empfänger nie pro Service pflegen: ein Wechsel ist ein Cluster-Update statt eines Updates je Service.
- `AlertEmail` leer = Topic ohne Subscription, Alarme publizieren ins Leere. Die `email`-Subscription muss per Link bestätigt werden, während CloudFormation schon `CREATE_COMPLETE` meldet (`aws sns list-subscriptions-by-topic` prüfen).
- **Slack ist nicht angebunden** — es gibt kein `chatbot-slack`-Template im Repository (Stand und Alternativen in [TASKS.md](TASKS.md)). Eine reine `https`-Subscription auf einen Slack-Webhook funktioniert nicht.
- **Dashboard `${Stack}-Overview`** (CloudWatch → Dashboards), 3-Stunden-Fenster, ab `1.7.0` acht Widgets:
  - **Metriken:** ECS-CPU und -Memory je Service (per `SEARCH()`, neue Services erscheinen automatisch), RDS-CPU/-Connections mit der `rds-connections`-Schwelle als Linie, abgelehnte VPC-Verbindungen mit ihrer Schwelle.
  - **Alarmstatus:** alle Cluster-Alarme in einem Widget, nach letztem Zustandswechsel sortiert. Sie stehen dort mit konstruierter ARN statt per `Ref`, weil die meisten an ihrem `*AlarmAction`-Parameter hängen und eine bedingte Referenz den JSON-Body unlesbar machen würde. Folge: ein auf `off` gestellter Alarm existiert nicht und erscheint als „unavailable" statt zu verschwinden.
  - **Drei Logs-Insights-Widgets:** die Domains, die die DNS-Whitelist nicht abdeckt; abgelehnte ausgehende Verbindungen nach Ziel und Port; die langsamsten Queries aus dem Slow-Query-Log.
- ⚠️ **`dashboard` als Alarm-Aktion heißt nicht „erscheint auf dem Dashboard".** Es setzt `ActionsEnabled: false` — der Alarm läuft, wechselt seinen Zustand und führt Historie, meldet sich nur nicht. Das Alarm-Widget oben macht den Namen näherungsweise wahr; vor `1.7.0` hatte er mit dem Dashboard gar nichts zu tun.

#### Löschverhalten

- **Keine einzige Ressource im Template trägt eine `DeletionPolicy`.** Ein `delete-stack` löscht damit **RDS-Cluster und EFS samt Daten**, ohne finalen Snapshot. Die Backup-Vaults überleben, aber der Weg zurück ist ein Restore, kein Rollback. (Offener Punkt in TASKS.md: `Snapshot` für RDS, `Retain` für EFS.)
- **Die ALB Deletion Protection blockiert das Löschen** und muss vorher manuell abgeschaltet werden — der einzige eingebaute Bremsklotz.

---

### ecscluster-vpc-rds-asg/alb-logs-bucket

S3-Bucket für ALB-Zugriffslogs, separat vom Cluster deployt. Ein Bucket pro Region, den sich alle Cluster-Stacks dieser Region teilen — jeder schreibt unter seinem eigenen Prefix.

**Abhängigkeiten:** keine Imports. Exportiert `BucketName` und `BucketArn`; `BucketName` wird als `LogsBucketName` in den Cluster-Stack übergeben. Template-Version `1.0.0`.

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterName` | — | der Bucket heißt `<ClusterName>-alb-logs` |
| `RetentionDays` | `14` | Tage bis zur endgültigen Löschung der Log-Objekte |

- **Separater Stack mit Absicht.** `DeletionPolicy: Retain` und `UpdateReplacePolicy: Retain` — CloudFormation löscht den Bucket nie, auch nicht beim Löschen des Stacks. So lässt sich der Cluster iterieren, ohne den Audit-Trail zu riskieren.
- **Lifecycle deckt alle drei Fälle ab:** `DeleteLogs` (aktuelle Versionen nach `RetentionDays`, dazu `NoncurrentVersionExpiration` nach 1 Tag), `CleanupDeleteMarkers` und `AbortIncompleteMultipartUploads` nach 7 Tagen. Ohne die Noncurrent-Regel würde der Bucket trotz Versionierung unbegrenzt wachsen und die DSGVO-Obergrenze aushebeln.
- **Bucket-Policy ist regionsgebunden** — sie erlaubt dem Service-Principal `logdelivery.elasticloadbalancing.amazonaws.com` (die Form seit August 2022) das Schreiben unter `AWSLogs/<account-id>/*`. Deshalb pro Region ein Bucket.
- **Verschlüsselung ist SSE-S3 (AES256), nicht KMS — und das ist kein Versäumnis.** ALB-Log-Delivery unterstützt kein KMS. Wer den Bucket „härtet" und auf SSE-KMS umstellt, bricht die Lieferung **stillschweigend**: der ALB meldet keinen Fehler, es kommen nur keine Objekte mehr an.
- **ALB-Logging ist kein Selbstläufer:** `access_logs.s3.enabled` kann `true` sein, während die Lieferung an der Bucket-Policy scheitert. Nach dem Aktivieren prüfen, ob unter `<prefix>/AWSLogs/<account>/elasticloadbalancing/<region>/` tatsächlich Objekte auftauchen.

---

### ecscluster-vpc-rds-asg/guardduty

GuardDuty Detector, Quarantine Security Group (null Egress-Regeln) und Incident-Response-IAM-Rolle. Der Detector läuft; Findings-Zustellung und Quarantäne-Automatik sind offen (TASKS.md).

**Abhängigkeiten:** importiert `${ClusterStackName}-Vpc` für die Quarantine-SG — **muss also nach dem Cluster deployt werden.** Exportiert `DetectorId`, `DetectorArn`, `QuarantineSgId`, `IncidentResponseRoleArn`. Template-Version `1.0.0`.

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterStackName` | — | Quelle des VPC-Imports für die Quarantine-SG |
| `ClusterName` | — | **nur Tagging und Wiedererkennung** — schränkt nichts ein, der Detector gilt für die ganze Region |
| `FindingPublishingFrequency` | `FIFTEEN_MINUTES` | `SIX_HOURS` ist billiger, aber für zeitnahe Reaktion untauglich |

- **Ein Stack pro Region, nicht pro Cluster.** GuardDuty erlaubt genau einen Detector pro Account und Region. Läge er im Cluster-Template, würde das Löschen eines Cluster-Stacks die Threat Detection der gesamten Region abschalten. Vor dem Deployment prüfen: `aws guardduty list-detectors` — existiert schon einer, schlägt die Erstellung fehl. Dass `ClusterName` und `ClusterStackName` nach Cluster-Bindung aussehen, ändert daran nichts.
- **`--capabilities CAPABILITY_NAMED_IAM` ist erforderlich** (die Incident-Response-Rolle hat einen expliziten `RoleName`).
- **Nach dem Deployment die Data Sources verifizieren:** `CLOUD_TRAIL`, `DNS_LOGS`, `FLOW_LOGS` müssen `ENABLED` sein. GuardDuty liest diese Streams aus AWS-internen Kopien, nicht aus unseren Log-Gruppen — Detection funktioniert also auch dort, wo unser Flow Log nur `REJECT` erfasst.
- **Findings-Pipeline mit Sample-Findings testen:** `aws guardduty create-sample-findings --detector-id <id> --finding-types Recon:EC2/PortProbeUnprotectedPort`, dann `list-findings` (Propagation dauert 1–2 Minuten) und anschließend `archive-findings`, damit die Testdaten das echte Signal nicht verwässern.
- **Findings benachrichtigen aktuell niemanden** — sie stehen nur in der Konsole. Es gibt keine EventBridge-Regel zum Alert-Topic (offener Punkt in TASKS.md).
- **Runtime Monitoring ist aus.** Der Detector läuft mit ungesetztem `Features`, `RUNTIME_MONITORING` also `DISABLED`. Damit wird nichts erfasst, was *innerhalb* eines Containers passiert: eine dort geschriebene Datei ist für Flow Logs, DNS Logs und CloudTrail unsichtbar, und die Writable Layer verschwindet beim nächsten Deployment. Anders als der Basis-Detector wird Runtime Monitoring **pro vCPU-Stunde** abgerechnet.
- Root-Console-Zugriffe erzeugen wiederkehrend `Policy:IAMUser/RootCredentialUsage`. Eine IAM-Identität für den Account-Inhaber hält das Signal sauber.

---

### ecscluster-vpc-rds-asg/backup-vaults-mirror

Zwei Backup-Vaults in der Zielregion, in die der Cluster seine Recovery Points kopiert: `${ClusterName}-BackupVault-Mirror` und `${ClusterName}-BackupLongTermVault-Mirror`.

**Abhängigkeiten:** keine Imports, keine Exports, **kein `TemplateVersion`-Output** — anders als Cluster, `ecsservice`, `guardduty` und `alb-logs-bucket` lässt sich der Stand dieses Stacks nicht abfragen (offener Punkt in TASKS.md).

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterName` | — | Namenspräfix beider Vaults; **muss der Cluster-Stackname sein** |

- **`ClusterName` ist der Name des Cluster-*Stacks*, nicht ein freier Bezeichner.** Der Cluster baut die Ziel-ARN der Copy-Action aus seinem eigenen `${AWS::StackName}` zusammen (`arn:aws:backup:<Zielregion>:<Account>:backup-vault:<Cluster-Stackname>-BackupVault-Mirror`). Weicht der Name ab, existiert der Vault unter falschem Namen und die Copy-Actions schlagen fehl — die täglichen Backups selbst laufen weiter, nur die Regionskopie fehlt.
- **In der Zielregion und vor dem Cluster deployen** (`BackupCopyDestinationRegion` des Clusters, Default `eu-north-1`). Der 6h-Plan startet um `00:30 UTC`, der Wochenplan sonntags um `05:00 UTC`; ab dem ersten Lauf werden beide Vaults erwartet.
- **Ein leerer `BackupCopyDestinationRegion` am Cluster schaltet die Kopien ganz ab** (Condition `EnableCrossRegionCopy`) — dann wird dieser Stack nicht gebraucht.
- Der Mirror ist für Regionsverlust. Ein Restore daraus in die Quellregion braucht erst eine Rückkopie des Recovery Points.

---

### ecsservice

Ein containerisierter Service auf einem bestehenden Cluster — ein Stack pro Anwendung.

**Abhängigkeiten:** importiert `${ClusterStackName}-Ecscluster`, `-Vpc`, `-Efs`, `-ListenerArnHttp`, `-ListenerArnHttps`, `-LoadbalancerArn` sowie ab `1.2.0` `-AlertTopicArn`. Exportiert `${AWS::StackName}-TargetGroupArn`.
**Template-Version:** `1.4.0` — Output `TemplateVersion`, kein Export.

Deployte Versionen aller Service-Stacks einer Region:

```bash
aws cloudformation describe-stacks --region <region> \
  --query "Stacks[?Outputs[?OutputKey=='TargetGroupArn']].{stack:StackName, version:(Outputs[?OutputKey=='TemplateVersion'].OutputValue)[0]}" \
  --output table
```

Der Filter auf `TargetGroupArn` begrenzt die Liste auf `ecsservice`-Stacks; `None` bedeutet einen Stand vor Einführung der Versionierung.

#### Container und Task Definition

| Parameter | Default | Wirkung |
|---|---|---|
| `InitialDockerImage` | — | Image bei Stack-Erstellung und bei `SkipImageResolver=true` |
| `SkipImageResolver` | `true` | siehe ImageResolver unten |
| `TaskMemory` | `478` | Soft Limit; nur `478`/`956`/`1434`/`1913` erlaubt |
| `VolumeMountPath` | `/var/www/html_data` | Mountpunkt des EFS im Container |
| `ContainerCommand` | `''` | Kommaliste; leer = Image-Default |
| `ProjectNameShort` / `ProjectEnv` / `ProjectToken` | — / `prd` / — | Doppler-Projekt, -Config und -Token |

- **`NetworkMode: bridge` mit dynamischem Host-Port** (`HostPort: 0`) — deshalb der Ingress-Bereich 32768–61000 in der Cluster-Security-Group.
- **`TaskMemory` passt auf die Instanzgröße:** die vier erlaubten Werte sind ganze Bruchteile des belegbaren Speichers einer `t3.small` — `1913` füllt sie ganz, `956` halb (2 Tasks), `478` zu einem Viertel (4 Tasks), `1434` lässt daneben genau noch ein Viertel frei. Andere Werte hinterlassen einen Rest, der zu klein für einen weiteren Task ist. Der Wert ist eine Reservierung: ECS platziert danach, ein zu großer kostet also Cluster-Kapazität.
- **EFS-Volume `data`**, `RootDirectory: /<Stackname>`, `TransitEncryption: ENABLED`. Die Trennung der Services ist damit eine Verzeichniskonvention, kein erzwungener Access Point.
- **Das Image kommt nicht aus dem Parameter**, sondern aus `Fn::GetAtt: [ImageResolver, Value]` — siehe unten.
- **`DOPPLER_TOKEN` steht als Klartext-`Environment`-Wert in der Task Definition** und ist damit über `ecs:DescribeTaskDefinition` lesbar; das `NoEcho` am Parameter ist dadurch aufgehoben. Umzug nach `Secrets` steht in TASKS.md.
- **Eine Rolle für beides:** `TaskRole` wird sowohl als `ExecutionRoleArn` als auch als `TaskRoleArn` gesetzt — sie darf ECR ziehen und in die eigene Log-Gruppe schreiben, sonst nichts.

#### Service und Deployment

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterStackName` | — | Name des Cluster-Stacks, aus dem importiert wird |
| `ServiceDesiredCount` | — | Soll-Tasks (0–4), zugleich `MinCapacity` des Autoscalings |
| `ECSHealthCheckGracePeriod` | `0` | Karenz, bevor ECS einen Task als ungesund tötet |

- **Rolling Deployment mit `MaximumPercent: 200` / `MinimumHealthyPercent: 50`** — während eines Deployments laufen kurzzeitig doppelt so viele Tasks.
- **`DeploymentCircuitBreaker` mit `Rollback: true`** — ECS erkennt scheiternde Tasks und rollt automatisch auf die vorherige Task Definition zurück. Er greift nur bei **Health**-Fehlern: ein altes, aber funktionierendes Image passiert ihn (dafür der ImageRegressionGuard).
- **Platzierung:** erst `spread` über die AZs, dann `binpack` nach Memory.

#### Load-Balancer-Anbindung

| Parameter | Default | Wirkung |
|---|---|---|
| `ListenerRuleHost` | — | Hostname der Listener-Regel |
| `ListenerRulePath` | `*` | Pfadmuster |
| `ListenerRulePriority` | — | muss pro Listener eindeutig sein |
| `ServiceTrafficPort` | `443` | Container-Port, zugleich Health-Check-Port |
| `ServiceTrafficProtocol` | `HTTPS` | `HTTP` oder `HTTPS` |
| `ECSHealthCheckPath` | `/test.php` | Health-Check-Pfad |

- **Zwei Listener-Regeln auf derselben Priorität:** am HTTP-Listener eine `301`-Umleitung auf HTTPS unter Beibehaltung von Host, Pfad und Query; am HTTPS-Listener der Forward auf die eigene Target Group. Die 80→443-Umleitung macht also jeder Service für seinen Host selbst, nicht der Cluster.
- **Target Group:** Health Check alle 45 s, Timeout 15 s, gesund nach 2, ungesund nach 4 Prüfungen, Matcher `200`, Deregistration Delay 120 s, keine Stickiness, `TargetType: instance`.
- **Nur ein Regel-Template pro Service.** `alb-ecsservice-rule` zusätzlich für denselben Service erzeugt doppelte Regeln auf derselben Priorität — ein Listener-Konflikt über zwei Stacks hinweg.

#### Autoscaling

| Parameter | Default | Wirkung |
|---|---|---|
| `ServiceMaxCapacity` | — | obere Grenze (1–10) |
| `ServiceScaleUpCpuThreshold` | `65` | CPU-Schwelle für +1 Task |
| `ServiceScaleDownCpuThreshold` | `15` | CPU-Schwelle für −1 Task |

- **Step Scaling, ±1 Task, Cooldown 300 s.** `MinCapacity` ist `ServiceDesiredCount`, `MaxCapacity` ist `ServiceMaxCapacity`.
- **Der Scale-in-Alarm ist eine Metric-Math-Expression:** `IF(cpu < ServiceScaleDownCpuThreshold AND tasks > ServiceDesiredCount, 1, 0)`. Dadurch steht er im Normalbetrieb auf `OK` statt dauerhaft rot.
- **`Stat: Average` dort nicht auf `Sum` ändern.** Die ALB veröffentlicht `HealthyHostCount` pro AZ, was nahelegt, `Average` liefere den AZ-Mittelwert — falsch: durch Cross-Zone Load Balancing meldet jede AZ die **vollständige** Zahl. Bei 2 Tasks über 2 AZs liefert `Average` also `2.0`, `Sum` dagegen `4.0`; mit `Sum` wäre `tasks > ServiceDesiredCount` dauerhaft wahr und jeder Service würde permanent auf MinCapacity gedrückt. Nur neu bewerten, falls `load_balancing.cross_zone.enabled` an einer Target Group auf `false` gesetzt wird.
- **Rolling Deployments verdoppeln kurzzeitig `HealthyHostCount`**, der Scale-in-Alarm kann dabei kurz anschlagen. Der Versuch ist ein No-op, weil Application Auto Scaling nie unter MinCapacity geht; `EvaluationPeriods: 5` überbrückt das Fenster.
- **`ServiceDesiredCount` ist gleichzeitig `MinCapacity`.** Wird die MinCapacity am Scalable Target per Konsole verändert, entsteht Drift, die den Scale-in unsichtbar blockiert; das nächste Stack-Update setzt sie zurück und löst dabei einen Scale-in aus. Vorher vergleichen: `aws application-autoscaling describe-scalable-targets --service-namespace ecs`.

#### Alarme

Acht Alarme. Die beiden Autoscaling-Alarme steuern die Scaling Policies und melden **absichtlich nicht** ans Cluster-Topic — `AlarmAutoscaleScaleDown` ist bei jedem normalen Scale-in rot. Alle übrigen importieren `${ClusterStackName}-AlertTopicArn`; **der Cluster-Stack muss deshalb zuerst mindestens auf `1.1.0` stehen**, sonst scheitert das Service-Update an der Import-Auflösung.

| Alarm (Name in der Konsole) | Was er misst | Parameter | Default |
|---|---|---|---|
| `${Stack}-AlarmAutoscaleScaleUp` | ECS-CPU, 3×60 s | `ServiceScaleUpCpuThreshold` | `65` % — Scaling-Trigger, nicht abschaltbar |
| `${Stack}-AlarmAutoscaleScaleDown` | Metric Math, 5×60 s | `ServiceScaleDownCpuThreshold` | `15` % — Scaling-Trigger, nicht abschaltbar |
| `${Stack}-AlarmHighCpu` | ECS-CPU, 5 Min. | `ServiceHighCpuThreshold` / `ServiceHighCpuAlarmAction` | `20` %; `dashboard` |
| `${Stack}-AlarmHighMemory` | ECS-Memory, 5 Min. | `ServiceHighMemoryThreshold` / `ServiceHighMemoryAlarmAction` | `80` %; `dashboard` |
| `${Stack}-AlarmLowCpu` | ECS-CPU, 2×5 Min. | `ServiceLowCpuThreshold` / `ServiceLowCpuAlarmAction` | `0`; `off` |
| `${Stack}-AlarmLowMemory` | ECS-Memory, 2×5 Min. | `ServiceLowMemoryThreshold` / `ServiceLowMemoryAlarmAction` | `0`; `off` |
| `${Stack}-AlarmHttp5xxTarget` | `HTTPCode_Target_5XX_Count` | `ServiceHttp5xxTargetThreshold` / `ServiceHttp5xxTargetAlarmAction` | `5`/5 Min.; `dashboard` |
| `${Stack}-AlarmHttp4xxTargetAnomaly` | Anomalieband auf `HTTPCode_Target_4XX_Count` | `ServiceHttp4xxAnomalyAlarmAction`, Breite über `ServiceHttp4xxAnomalyBand` | `dashboard`; Band `3` |

- **Ab `1.6.0` trägt jeder der sechs meldenden Alarme einen eigenen `off`/`dashboard`/`alert`-Schalter**, wie im Cluster-Template. Schwelle und Schalter sind damit getrennt. Bis `1.5.0` war der Threshold beides in einem: `0` hieß „Alarm gar nicht anlegen". Das hatte zwei Folgen, die beide weg sind — `0` bedeutete in den beiden Templates das Gegenteil (im Cluster heißt `RdsErrorAlarmThreshold: 0` „bei jedem Fehler melden"), und ein 5xx-Alarm, der bei *jedem* 5xx melden sollte, ließ sich gar nicht ausdrücken. Die beiden Autoscaling-Alarme haben keinen Schalter: ihre Aktionen sind die Scaling Policies, sie benachrichtigen niemanden.
- **Die vier operativen Alarme sind reine Sichtbarkeit**, keine Scaling-Trigger: HighCpu `20` % (Baseline liegt bei <1–2 %, deshalb ist 20 % schon auffällig, und es ist Absicht, das *vor* dem Scale-out bei `65` % zu wissen), HighMemory `80` % (Frühwarnung vor OOM-Kill), Low* per Default `off`. Bei den Low-Alarmen ist das kein Zufall: ihre Schwelle steht auf `0` und der Vergleich ist `LessThanThreshold`, ein solcher Alarm kann nie auslösen. Wer sie einschaltet, muss zuerst eine echte Schwelle setzen — sonst entsteht Abdeckung, die keine ist.
- **`dashboard` als Default ist gemessen, nicht geraten.** Über 15 Pariser Services haben 43 von 45 Alarmen nie ausgelöst; `AlarmHighCpu` nirgends. Die Ausnahmen sind ein Service mit wiederkehrenden 5xx sowie drei vereinzelte HighMemory-Auslösungen. Ein Default auf `alert` hätte zugleich Stacks zum Melden gebracht, die bisher gar keine Service-Alarme hatten.
- **`AlarmHttp5xxTarget` meldet, dass die Anwendung geantwortet hat — mit 5xx** (PHP Fatal, TYPO3-Exception, fehlgeschlagene DB-Verbindung). Das steht in der Log-Gruppe, „check the logs" ist also der richtige nächste Schritt. Default `5`/5 Min. statt `1`, weil Rolling Deployments und flatternde Health Checks transiente 5xx erzeugen. **Loadbalancer-seitige 5xx** (503 keine gesunden Targets, 502 abgebrochene Antwort, 504 Timeout) werden **nicht** alarmiert — ein `AlarmHttp5xxElb` war in `1.2.0` enthalten und wurde bewusst entfernt.
- **`AlarmHttp4xxTargetAnomaly` ist ein Stolperdraht, keine Diagnose.** Er meldet Abweichungen von der eigenen 4xx-Baseline (Scan-Welle, Bot auf dem Login, ein Deployment das alle Asset-Pfade zerschossen hat), kann aber weder Statuscode noch URL nennen — Nachverfolgung in den ALB-Access-Logs. Nur die **obere** Bandgrenze alarmiert; ein Einbruch der 4xx ist uninteressant. Es gibt **keine Wartezeit**: `HTTPCode_Target_4XX_Count` wird durchgehend veröffentlicht und 15 Monate aufbewahrt, ein neuer Detector trainiert also sofort auf dieser Historie. Auf Services mit wenig Verkehr bleibt er laut, deshalb Default `dashboard` statt `alert`: das Band entsteht und lernt, meldet aber niemandem, bis es bewusst hochgestuft wird. Kosten: ein Anomaly-Alarm wird als drei Alarm-Metriken abgerechnet. Scanner, die den ALB ohne passende Listener-Regel treffen, landen in `HTTPCode_ELB_4XX_Count` auf Cluster-Ebene und sind hier **nicht** erfasst.
- **`BaselineHttp4xxTarget` und `AlarmHttp4xxTarget` sind per `DependsOn` gekoppelt — nicht entfernen.** Ein Anomaly Detector ist seinem Alarm nur implizit zugeordnet, über übereinstimmende Namespace/Metrik/Dimensionen/Statistik, nie über einen `Ref`. Ohne die Kante darf CloudFormation beim Abschalten des Paares oder beim Löschen des Stacks den Detector zuerst entfernen, und `DeleteAnomalyDetector` scheitert, solange ein Alarm die Metrik referenziert — der Stack landet in `DELETE_FAILED`.
- **CloudWatch Logs Anomaly Detection wird nicht mehr verwendet.** `LogAnomalyDetector` und `ServiceLogAnomalyAlarm` waren bis `1.2.0` enthalten (Parameter `EnableLogAnomalyDetection`, Default `true`) und wurden entfernt: Apache-Access-Zeilen fallen alle auf **ein** Pattern zusammen, die gesamte Varianz steckt in den maskierten Tokens. Nicht wieder einbauen, ohne vorher das Logformat zu ändern.

#### Logs

Drei Log-Gruppen, alle mit 14 Tagen Retention, alle fest verdrahtet:

| Log-Gruppe | Inhalt |
|---|---|
| `${Stack}-LogGroup` | stdout/stderr des Containers (`awslogs`, Stream-Prefix `ECSDockerTask`) |
| `/aws/lambda/<Stack>-ImageResolver` | Auflösung des Images bei jedem Stack-Update |
| `/aws/lambda/<Stack>-ImageRegressionGuard` | Entscheidung des Regressions-Wächters bei jedem Rollout |

#### Updates

- **Vor einem Template-Wechsel den Drift reduzieren.** Ein Service-Stack driftet normalerweise nur in der Task Definition. Schlägt ein Update fehl, rollt CloudFormation auf die letzte bekannte Konfiguration zurück — deren Docker-Image kann sehr alt oder gar nicht mehr vorhanden sein. Vorgehen: Drift erkennen, Abweichungen jenseits der Task Definition manuell zurücksetzen, den Stack **ohne** Template-Austausch mit `InitialDockerImage` = aktuell laufendes Image aktualisieren, und erst danach das Template ersetzen.

#### ImageResolver

**Problem:** Deployt wird über die Pipeline, nicht über CloudFormation — das laufende Image ist also immer ein anderes als der Stack-Parameter `InitialDockerImage`. Ohne Gegenmaßnahme würde jedes Stack-Update (Alarmschwelle, Listener-Regel) die Task Definition neu bauen und den Service auf ein womöglich Monate altes, in ECR längst gelöschtes Image zurückwerfen (`CannotPullContainerError`).

**Lösung:** Eine Custom Resource liest das *tatsächlich laufende* Image aus ECS; die Task Definition referenziert `Fn::GetAtt: [ImageResolver, Value]` statt des Parameters.

> **Sie läuft nicht bei jedem Update.** CloudFormation ruft eine Custom Resource nur auf, wenn sich eine **ihrer Properties** ändert — `ServiceToken` bleibt dabei gleich, auch wenn der Lambda-Code darin ausgetauscht wird. Ein reines Template-Update berührt keine Property, also liefert `Fn::GetAtt` den **zwischengespeicherten** Wert des letzten Laufs. Im Change Set erscheint die Ressource dann als `Modify`/`Conditional`, und beim Ausführen passiert nichts. Das ist harmlos, solange der Cache noch stimmt — und genau dort liegt das Restrisiko: ändert ein Update die Task Definition, **ohne** eine Resolver-Property zu berühren, wird sie mit dem gecachten Wert neu gebaut. `ProjectToken` war bis `1.5.0` so ein Parameter; ab `1.6.0` ist er Property, siehe unten.

Ablauf der Lambda (IAM: `ecs:DescribeServices` + `ecs:DescribeTaskDefinition`):

1. `Delete` → sofort `SUCCESS`.
2. `Create` → gibt `InitialDockerImage` zurück; beim Anlegen existiert noch kein Service.
3. `SkipImageResolver=true` → gibt `InitialDockerImage` zurück, ohne ECS zu befragen.
4. **`InitialDockerImage` wurde in diesem Update geändert** → dieser Wert gewinnt. Erkannt über `OldResourceProperties`, das CloudFormation bei Updates mitschickt.
5. Sonst → aktive Task Definition des Service holen, davon das Image des ersten Containers zurückgeben.
6. Jeder Fehler ist `FAILED` — das Update schlägt fehl, statt still ein falsches Image zu setzen.

**Jeder Zweig protokolliert seine Entscheidung** samt gewähltem Image in `/aws/lambda/<Stack>-ImageResolver`. Ohne das war nach einem Update nicht nachvollziehbar, warum ein bestimmtes Image gewählt wurde — die Rekonstruktion des August-Vorfalls brauchte deshalb ECS- und CloudTrail-Historie.

- **`SkipImageResolver`** (Default `true`): `true` für die Stack-Erstellung und solange das erste Deployment nicht stabil läuft, danach `false`. **Bei bestehenden Stacks mit `false` den Wert bei jedem Update explizit mitgeben**, sonst greift der Default und ein veraltetes `InitialDockerImage` wird deployt.
- **Ein Image gezielt setzen geht ohne den Schalter.** Trägst du bei `false` ein neues `InitialDockerImage` ein, wird es verwendet — Schritt 4 oben. Der Schutz greift nur, wenn der Parameter *unverändert* bleibt, und genau das war der Fall, der die Regression im August auslöste. Bis `1.4.0` überschrieb der Resolver auch eine bewusste Eingabe mit dem laufenden Image, sodass ein gezielter Deploy nur über `SkipImageResolver=true` möglich war.
- **Retry nach fehlgeschlagener Erstellung:** existiert der Service nicht mehr, schlägt die Lambda hart fehl; existiert er, ist aber nie gesund geworden, wird das kaputte Image immer wieder reanimiert. Beides löst `SkipImageResolver=true` mit korrektem `InitialDockerImage`.
- **Die frühere Lücke — `ProjectToken`, geschlossen ab `1.6.0`.** Jeder Parameter, der die Task Definition beeinflusst, ist Trigger-Property der Custom Resource. `ProjectToken` war es bis `1.5.0` nicht, weil angenommen wurde, CloudFormation lehne `NoEcho`-Werte an Custom Resources ab. **Diese Annahme ist falsch** — am 2026-09-07 an `lab-dev-ema-s` geprüft, siehe „Wann ein altes Image zurückkommt". Seit `1.6.0` steht der Parameter in den Properties, eine alleinige Rotation weckt den Resolver, und das Image bleibt stehen. Bis `1.5.0` galt dagegen: **Doppler-Token nie allein rotieren**, sondern zusammen mit einem aktuellen `InitialDockerImage`.

**Verworfene Alternativen** — damit sie nicht alle paar Monate neu vorgeschlagen werden:

| Ansatz | Warum nicht |
|---|---|
| `cloudformation deploy` in der Pipeline | Bringt `ROLLBACK_FAILED` als Fehlerbild ins Spiel — schlimmer als ein fehlgeschlagener direkter ECS-Deploy |
| SSM Parameter Store + direkter ECS-Deploy | Der Parameter überlebt das Löschen des Stacks als Waise, und die Pipeline müsste vor der Stack-Erstellung laufen |
| Mutabler ECR-Tag (`latest`) | Verliert die Rückverfolgbarkeit pro Deploy, und ECS zieht ohne Force-Deployment kein neues Image |
| Nur Prozessdisziplin | Nicht durchsetzbar |

Die präventive Lösung wäre, `DOPPLER_TOKEN` über Secrets Manager `valueFrom` zu beziehen — dann liefe das Token gar nicht mehr durch ein Stack-Update und das Problem wäre strukturell weg. Als Option vermerkt, nicht umgesetzt.

#### Wann ein altes Image zurückkommt

Die Frage, für die es den ImageResolver und den ImageRegressionGuard gibt. Die Antwort in einem Satz:

> **Ein altes Image kommt zurück, wenn CloudFormation die Task Definition neu schreibt, ohne dass der Resolver dabei läuft.** Dann setzt `Fn::GetAtt: [ImageResolver, Value]` den zwischengespeicherten Wert seines letzten Laufs ein — und der kann beliebig alt sein.

Der Resolver läuft nur, wenn sich eine **seiner Properties** ändert. Die Task Definition hängt aber an mehr als nur diesen. Wo beides auseinanderfällt, entsteht die Lücke.

**Sieben Parameter beeinflussen die Task Definition. Ab `1.6.0` sind alle sieben Resolver-Properties:**

| Parameter | Resolver-Property? |
|---|---|
| `ContainerCommand`, `ProjectEnv`, `ProjectNameShort`, `ServiceTrafficPort`, `TaskMemory`, `VolumeMountPath` | ja — Änderung startet den Resolver, das laufende Image gewinnt |
| **`ProjectToken`** | **ab `1.6.0` ja**, bis `1.5.0` nein — siehe unten |

**Die fünf Fälle:**

| # | Auslöser | Warum der Resolver schweigt |
|---|---|---|
| 1 | **`ProjectToken` allein rotiert** — **bis `1.5.0`** | der Parameter war keine Property, die Task Definition wurde neu gebaut, der Resolver nicht aufgerufen. Ab `1.6.0` geschlossen |
| 2 | **Template-Änderung, die den `Task`-Block tatsächlich verändert** (Environment, LogConfiguration, Volumes, NetworkMode …) | eine Template-Änderung berührt keine Property |
| 3 | **Ein Update schlägt fehl und rollt zurück** | CloudFormation stellt seinen letzten bekannten Stand wieder her, inklusive Task Definition |
| 4 | **Der Service wird auf die CloudFormation-Revision gezogen** | Folge von 1–3: `Service.TaskDefinition` ist `{Ref: Task}`, zeigt also auf die Revision, die CloudFormation registriert hat |
| 5 | **`SkipImageResolver` bleibt auf `true` stehen** | er läuft, gibt aber bedingungslos `InitialDockerImage` zurück — der Parameter altert, während die Pipeline weiterdeployt |

Fall 2 ist enger, als er klingt: entscheidend ist nicht, dass ein Template-Update stattfindet, sondern dass es die `Task`-Ressource wirklich anfasst. Ändert ein Update nur andere Ressourcen, löst `{Ref: Task}` unverändert auf und CloudFormation schreibt nichts neu — nachgemessen beim `1.5.0`-Rollout in Paris, bei dem alle 15 Stacks Revision *und* Image behielten.

Fall 5 ist der einzige, der nicht aus einer Lücke im Mechanismus entsteht, sondern aus einem vergessenen Schalter — und damit auch der einzige, der sich durch bloßes Nachsehen ausschließen lässt.

Fall 4 ist der, den man am ehesten unterschätzt, weil er unsichtbar vorbereitet wird. Die Pipeline registriert bei jedem Deploy eine neue Revision direkt in ECS; CloudFormation kennt nur seine eigene. Beide Zählungen laufen auseinander — gemessen in Paris am 2026-09-05 stand ein Service auf Revision `77`, während CloudFormation `6` für aktuell hielt, mit einem anderen Image darin. Ein reines Template-Update ändert daran nichts, weil CloudFormation gegen seinen **eigenen** letzten Stand vergleicht und `{Ref: Task}` unverändert auflöst. Sobald aber einer der Fälle 1–3 eine neue Revision erzeugt, zieht der Service mit — und übernimmt das Image, das dort drinsteht.

Wie weit die beiden auseinanderliegen:

```bash
aws ecs describe-services --cluster <cluster>-Ecscluster --services <stack>-Service \
  --query "services[0].taskDefinition" --output text
aws cloudformation describe-stack-resource --stack-name <stack> --logical-resource-id Task \
  --query "StackResourceDetail.PhysicalResourceId" --output text
```

**Verhindert wird davon keiner.** Der Resolver schützt nur, wenn er läuft, und das tut er in genau diesen Situationen nicht.

> **Fall 1 ist ab `1.6.0` geschlossen.** Die frühere Annahme, `NoEcho`-Parameter könnten keine Custom-Resource-Properties sein, ist falsch — am 2026-09-07 an `lab-dev-ema-s` geprüft: CloudFormation nimmt sie an, übergibt den Wert **im Klartext** (nicht maskiert), und eine Rotation ruft den Resolver auf, weil alter und neuer Wert beide sichtbar sind und der Unterschied erkannt wird. Seit `1.6.0` steht `ProjectToken` deshalb in den Properties, und eine alleinige Rotation ist ungefährlich. Neue Sichtbarkeit erkauft das nicht: ein Change Set, das den `ImageResolver` anfasst, meldet `ProjectToken` in `BeforeContext` wie `AfterContext` als `****`. `NoEcho` maskiert Ausgaben, nicht die Übergabe — übrig bleibt allein das Lambda-Event, das nicht persistiert wird und nur dem zugänglich ist, der das Token ohnehin über `ecs:DescribeTaskDefinition` im Klartext lesen kann.
>
> **Zu beachten bei der Secrets-Migration:** wandert `DOPPLER_TOKEN` nach `Secrets`, muss diese Property mit weg. Das erzwingt sich weitgehend selbst, weil `{"Ref": "ProjectToken"}` ungültig wird, sobald die Migration den Parameter entfernt — gefährlich ist nur eine Migration, die ihn behält (offener Punkt in TASKS.md).

Fall 2, 3 und 5 bleiben auch mit `1.6.0` bestehen.

**Erkannt werden alle fünf** — vom ImageRegressionGuard, der am Deployment-Event hängt und nicht am Resolver. Er meldet, sobald das eingehende Image älter ist als das abgelöste. Drei Bedingungen müssen dafür erfüllt sein: der Stack läuft mindestens auf `1.5.0` (davor stimmte die ECR-Region nicht, siehe unten), beide Images liegen in ECR, und beide haben eine auflösbare Push-Zeit.

**Die praktische Regel:** Wer den `Task`-Block im Template ändert oder das Doppler-Token rotiert, gibt im selben Update `InitialDockerImage` mit dem aktuell laufenden Image mit. Ab `1.5.0` gewinnt dieser Wert — das ist der verlässliche Hebel gegen Fall 1 und 2. Bis `1.4.0` wurde er bei `SkipImageResolver=false` stillschweigend verworfen, und ein gezielter Deploy war nur möglich, indem man den Schutz ganz abschaltete.

#### ImageRegressionGuard

`EnableImageRegressionAlarm` (Default `true`, ab `1.4.0`). Trotz des Namens **kein CloudWatch-Alarm**, sondern EventBridge-Regel + Lambda, die direkt ins Cluster-`AlertTopic` publiziert.

1. Die Regel horcht auf `ECS Deployment State Change` / `SERVICE_DEPLOYMENT_IN_PROGRESS`, per `resources` auf genau diesen Service eingegrenzt — feuert also bei jedem Rollout.
2. Die Lambda vergleicht die Deployments `PRIMARY` (eingehend) und `ACTIVE` (abgelöst); fehlt eines oder sind die Images gleich, bricht sie ab.
3. Für beide Images `ecr:DescribeImages` → `imagePushedAt`. **Region und Account kommen aus der Bildreferenz selbst** (`<acct>.dkr.ecr.<region>.amazonaws.com`), nicht aus der Region der Lambda — die Repositories liegen in `eu-central-1`, die Cluster nicht zwingend. Ist das eingehende Image **älter**, geht eine Meldung mit beiden Referenzen und Push-Zeiten ins Topic.

- **Vergleich bewusst „älter als das bisher laufende", nicht „nicht das neueste in ECR"** — das Repo ist über Umgebungen geteilt, ein Staging-Push sähe sonst neuer aus als ein korrektes Produktions-Image.
- Deckt beide Wege ab: das CloudFormation-Update, das die Task Definition zurückdreht (der `ProjectToken`-Fall), und das versehentliche Redeploy eines alten Builds.
- **Detektiv, nicht präventiv** — feuert beim Rollout-*Start*. Ergänzt den `DeploymentCircuitBreaker`, der nur bei Health-Fehlern zurückrollt; ein altes, funktionierendes Image ist gesund.
- **Absichtliche Rollbacks lösen ihn ebenfalls aus** — als Hinweis behandeln, nicht als Page.
- Er schweigt still, wenn eine Push-Zeit fehlt: kein Alarm heißt nicht „geprüft und in Ordnung". Das betrifft **jedes Image außerhalb ECR** — eine Referenz wie `solr:9.9` trägt keinen Registry-Host, wird als Nicht-ECR erkannt und übersprungen. Ebenso ein Tag, den die Lifecycle Policy inzwischen gelöscht hat. Nachsehen in `/aws/lambda/<Stack>-ImageRegressionGuard`.
- **Von den Alarm-Schaltern des Clusters unberührt.** Er publiziert direkt per `sns:Publish` ans `AlertTopic`, nicht über einen CloudWatch-Alarm — `ActionsEnabled: false` gilt nur für Alarme. Steht der Cluster auf `dashboard`, ist der Guard also die einzige Meldung, die noch zugestellt wird.
- **Beim Einführen schützt er den eigenen Rollout noch nicht.** Die EventBridge-Regel entsteht im selben Change Set, das `Service` und `Task` anfasst, und hat keine Abhängigkeit dorthin — ob sie vor dem `SERVICE_DEPLOYMENT_IN_PROGRESS` existiert, ist nicht garantiert. Ab dem nächsten Deployment greift er.

---

### alb-ecsservice-rule

Eine zusätzliche Host/Pfad-Regel auf die Target Group eines bestehenden ECS-Service — je eine am HTTP- und am HTTPS-Listener.

**Abhängigkeiten:** importiert `${ClusterStackName}-ListenerArnHttp`/`-ListenerArnHttps` und `${EcsServiceStackName}-TargetGroupArn`. Keine Exports, kein `TemplateVersion`-Output.

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterStackName` | — | liefert die beiden Listener-ARNs |
| `EcsServiceStackName` | — | liefert die Target Group, auf die geforwardet wird |
| `ListenerRuleHost` | — | Hostname der Regel |
| `ListenerRulePath` | `*` | Pfadmuster |
| `ListenerRulePriority` | — | muss pro Listener eindeutig sein |

- **Nur für Services, die außerhalb von `ecsservice` deployt wurden**, oder für zusätzliche Hostnamen. `ecsservice` legt seine beiden Listener-Regeln selbst an; dieses Template zusätzlich für denselben Service erzeugt doppelte Regeln auf derselben Priorität — ein Listener-Konflikt über zwei Stacks hinweg, den keiner der beiden Stacks allein erkennen kann.
- **`ListenerRulePriority` kollidiert erst beim Deployment.** CloudFormation kann die Belegung der anderen Stacks nicht sehen.

---

### alb-redirect-rule

Reine Redirect-Regel auf dem ALB, ohne Target Group und ohne Service dahinter: HTTP wird auf HTTPS umgeleitet, HTTPS auf den Ziel-Hostnamen.

**Abhängigkeiten:** importiert `${ClusterStackName}-ListenerArnHttp`/`-ListenerArnHttps`. Keine Exports, kein `TemplateVersion`-Output.

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterStackName` | — | liefert die beiden Listener-ARNs |
| `ListenerRuleHost` | — | Hostname, der umgeleitet werden soll |
| `ListenerRulePath` | `*` | Pfadmuster |
| `ListenerRulePriority` | — | muss pro Listener eindeutig sein |
| `ListenerRuleRedirectHost` | — | Ziel-Hostname |
| `ListenerRuleRedirectPath` | `''` | leer = Pfad und Query bleiben erhalten; gesetzt = feste Zieladresse **ohne** Query |
| `ListenerRuleRedirectHttpCode` | `301` | `301` oder `302` |

- **`301` nur bei dauerhaften Umleitungen.** Browser cachen ihn hartnäckig, eine Korrektur erreicht bereits besuchte Clients lange nicht. Für alles Vorläufige `302`.
- **`ListenerRuleRedirectPath` wirft die Query weg.** Für einen reinen Domain-Umzug leer lassen, sonst verlieren alle Deep Links ihre Parameter.
- **`ListenerRulePriority` kollidiert erst beim Deployment**, gemeinsam mit allen anderen Regeln desselben Listeners.

---

### alb-additional-certificate

ACM-Zertifikat mit DNS-Validierung, zugewiesen als **zusätzliches** Zertifikat am HTTPS-Listener des Clusters. Bestehende Zertifikate bleiben unverändert.

**Abhängigkeiten:** importiert `${ClusterStackName}-ListenerArnHttps`. Exportiert `${AWS::StackName}-CertificateArn`. Kein `TemplateVersion`-Output.

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterStackName` | — | liefert den HTTPS-Listener |
| `CertificateCommonName` | — | die Domain, z. B. `www.example.com` |
| `AddWildcardSan` | `false` | ergänzt `*.<CommonName>` als SAN |

- **Der Stack pausiert bei `CREATE_IN_PROGRESS`, bis die DNS-Validierung abgeschlossen ist.** In dieser Zeit manuell: in ACM das Zertifikat mit Status *Pending Validation* öffnen, die CNAME-Einträge kopieren und in der zuständigen DNS-Zone anlegen. Danach läuft CloudFormation von selbst weiter.
- **Bei Root-Domains `AddWildcardSan=true` setzen**, sonst deckt das Zertifikat `example.com`, aber kein `www.example.com` ab.
- **Die Stack-Löschung schlägt beim ersten Versuch oft fehl**, weil das Zertifikat noch als „in Verwendung" am Listener gilt. Einige Minuten warten und erneut löschen.

---

### certificate

Eigenständiges ACM-Zertifikat mit DNS-Validierung, ohne Bindung an einen Load Balancer — für manuelle Verwendung oder andere Stacks.

**Abhängigkeiten:** keine Imports. Exportiert `${AWS::StackName}-CertificateArn`. Kein `TemplateVersion`-Output.

| Parameter | Default | Wirkung |
|---|---|---|
| `CertificateCommonName` | — | die Domain |
| `AddWildcardSan` | `false` | ergänzt `*.<CommonName>` als SAN |

- Gleiche DNS-Validierung wie bei `alb-additional-certificate`: der Stack wartet, bis die CNAME-Einträge gesetzt sind.
- **Für CloudFront muss das Zertifikat in `us-east-1` liegen** — also diesen Stack dort deployen, unabhängig davon, wo der Rest läuft.

---

### cloudfront-alb-distribution

CloudFront-Distribution vor einem ALB: HTTP/2 und HTTP/3, IPv6, SNI-only TLS ab TLSv1.2, eigene Cache Policy (respektiert `Cache-Control` des Origins, schließt Cookies aus dem Cache-Key aus), `AllViewer` Origin Request Policy, `SecurityHeadersPolicy`, Origin-Verify-Header und optional ein eigenes WAF-WebACL.

**Abhängigkeiten:** keine Imports — der ALB wird über seinen DNS-Namen als Parameter übergeben, nicht importiert. Exportiert `DistributionId` und `DistributionDomainName`. Kein `TemplateVersion`-Output.

| Parameter | Default | Wirkung |
|---|---|---|
| `DomainName` | — | FQDN der Distribution, muss zum Zertifikat passen |
| `AcmCertificateArn` | — | **muss in `us-east-1` liegen** |
| `AlbDnsName` | — | DNS-Name des Origin-ALB |
| `OriginVerifyHeader` | `X-Origin-Verify` | Name des Headers, den CloudFront mitschickt |
| `OriginVerifyValue` | — | dessen geheimer Wert |
| `PriceClass` | `PriceClass_100` | nur Nordamerika und Europa; `_200`/`_All` erweitern die Edge-Standorte und die Kosten |
| `EnableWAF` | `true` | legt ein `CLOUDFRONT`-WebACL an (Common, Known Bad Inputs, IP Reputation, Rate Limit 2.000/IP/5 Min.) |

- **Der WAF-Scope `CLOUDFRONT` existiert ausschließlich in `us-east-1`.** Ein Deployment mit `EnableWAF=true` in einer anderen Region schlägt sofort mit `WAFInvalidOperationException` fehl. Offener Punkt in TASKS.md. Für einen ALB gilt das nicht — dessen `REGIONAL`-WebACL entsteht in derselben Region wie der ALB.
- **Auch das ALB-Zertifikat muss `DomainName` abdecken** (SAN oder Wildcard), weil CloudFront den originalen `Host`-Header durchreicht.
- **`OriginVerifyValue` ist nur wirksam, wenn der ALB ihn auch erzwingt.** Das Template *sendet* den Header; die Listener-Regeln am Cluster müssen Anfragen ohne ihn ablehnen — sonst bleibt der ALB direkt aus dem Internet erreichbar und CloudFront ist umgehbar. Diese Durchsetzung fehlt bislang (TASKS.md).
- **`EnableWAF=false` spart die WAF-Fixkosten (~9 $/Monat)**, entfernt aber SQLi-, XSS-, Bad-Input-, IP-Reputation- und Rate-Limiting-Schutz. AWS Shield Standard (L3/L4-DDoS) bleibt immer aktiv und kostenlos.

---

### global-accelerator-alb

Global Accelerator mit zwei statischen Anycast-IPv4-Adressen vor einem ALB, TCP-Listener auf 80 und 443, eine Endpoint Group in der Stack-Region mit Client-IP-Weiterleitung.

**Abhängigkeiten:** importiert `${ClusterStackName}-LoadbalancerArn`. Exportiert `AcceleratorArn`, `AcceleratorDnsName`, `StaticIp1`, `StaticIp2`. Kein `TemplateVersion`-Output.

| Parameter | Default | Wirkung |
|---|---|---|
| `ClusterStackName` | — | liefert den ALB als Endpoint |
| `ClientAffinityEnabled` | `NONE` | `SOURCE_IP` bindet einen Client dauerhaft an denselben Endpoint |
| `EndpointWeight` | `128` | Gewichtung innerhalb der Endpoint Group |

- **Für externe DNS-Provider ohne CNAME-Flattening.** Die beiden statischen IPs lassen sich direkt als A-Records eintragen — der eigentliche Grund für dieses Template.
- **`EndpointWeight` ist hier wirkungslos**, solange die Endpoint Group nur diesen einen ALB enthält: Gewichte verteilen Traffic *zwischen* Endpoints.
- **`ClientAffinityEnabled=SOURCE_IP` nur setzen, wenn die Anwendung Sticky Sessions wirklich braucht** — es verschlechtert die Lastverteilung.
- Anders als CloudFront ist **kein Deployment in `us-east-1` nötig**; der Stack läuft in der Region des ALB. Global Accelerator selbst wird intern in `us-west-2` verwaltet.

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
