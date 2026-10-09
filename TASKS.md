# Offene Aufgaben

Nur konkrete nächste Schritte. Ein Eintrag ist ein Titel plus die eine Sache, die beißt — die Begründung
gehört in die `Description` oder `Metadata.Note` des Parameters, wo sie in dem Moment gelesen wird, in dem
der Wert gesetzt wird, und der Beleg in die Commit-Message.

- Begründungen zu den Templates: [README.md](README.md)
- Alles Ältere: `git log -p TASKS.md`. Die Rekonstruktion des Vorfalls vom 2026-09-08 und die
  Rollout-Protokolle wurden am 2026-09-15 entfernt, die erledigten Einträge am 2026-10-04 — jeweils
  nachdem ihre Erkenntnisse in Templates und README gelandet waren.

---

## Zustand der Cluster

> Beide live gelesen **2026-10-03**. Die einzige Stelle im Repo, die ausgerollte Stacks beschreibt — sie
> veraltet lautlos, also vor dem Vertrauen neu lesen.

| | Paris `labc-eu-w3` (staging) | Frankfurt `labc-eu-c1` (prod) |
|---|---|---|
| Cluster-Template | **`1.7.15`** seit 2026-10-09 (Egressregeln `4318`+`587`, DHCP-Fix, Alarm eingegrenzt) | **`1.7.13`** seit 2026-10-07; `ecsservice 1.7.0` steht bereit |
| `ecsservice` | `1.6.0`, 15/15 | `1.6.0`, 19/19 |
| WAF-Regelaktionen | `KnownBadInputs` `SQLi` `WordPress` `SecretPaths` block, Rest `count` | identisch zu Paris seit 2026-09-29 |
| DNS Firewall | Catch-all `ALERT`, **65** Domains seit 2026-10-06 | Catch-all `ALERT`, **62** Domains seit 2026-10-06 |
| Egress | **`restricted`** seit 2026-10-03, keine Zusatzregeln | **`restricted`** seit 2026-10-06, `587` + `80` auf eine `/32` |
| Alarme auf `alert` | 7: KnownBadInputs, SQLi, WordPress, dns-firewall, vpc-rejected, rds-slow-queries, **egress-blocked** | 9: dieselben plus **rds-error** und **elb-5xx**. Schwellen am 2026-10-03 kalibriert — KnownBadInputs 50 → **500**, WordPress 20 → **50** (fünffaches Scan-Volumen), Rest unverändert |
| Service-Alarme | HighCpu/HighMemory/5xx `alert`, 4xx-Band `dashboard`, Low* `off` | identisch zu Paris |
| `ImageRegressionGuard` | auf allen 15, live | auf allen 19, live |
| `WafClientIpHeader` | leer | leer |
| `EnableEgressAnalysis` | `true` — bewusst an, nach `restricted` zur Kontrolle nötig | `true`, dito |
| Bewusst verschieden | `ElbHttp5xxAlarmAction` und `RdsErrorAlarmAction` auf `dashboard` — 5xx und DB-Fehler sind im Staging erwartbares Rauschen | beide auf `alert`; für elb-5xx am 2026-09-29 gemessen, für rds-error nie begründet |
| Bekannter Drift | `DnsQueryLoggingConfig`, `Rdscl`, `Rdsinstance1` | dieselben vier, dazu die von Hand erhöhte Log-Aufbewahrung |

---

## Zero-Trust-Egress — der laufende Strang

Jeder Schritt ist über einen Parameter rückdrehbar. **Jeden mit einem erzwungenen Deployment testen, nicht
durch Aufrufen einer Seite** — eine blockierte Auflösung oder ein fehlender Port stört keinen laufenden
Container, sondern bricht die nächste Task-Platzierung.

- [ ] **`dwk-zer-app` steht in beiden Regionen auf `desiredCount 0`** (Paris 2026-10-03, Frankfurt
  2026-10-06) und wurde bei keinem der beiden Durchläufe getestet.
  Genau der Service mit der externen MySQL in eu-central-1 aus Doppler, die zu einem abgeschalteten
  Cluster gehört. Wird er hochgefahren, läuft er in die Egress-Sperre und meldet sich über den
  Alarm. **Erst den Doppler-Wert korrigieren.**
- [ ] **Frankfurt nach der Egress-Umstellung beobachten.** Seit 2026-10-06 auf `restricted` mit
  `EgressExtraRules=587:0.0.0.0/0,80:<baseball>/32`, verifiziert über **18 der 19 Services** in
  Dreierblöcken — alle `ok`, keine Fehlschläge, der `EgressBlockedAlarm` schwieg durchgehend.
  Nicht getestet: `dwk-zer-app-p` (`desiredCount 0`).
  ⚠️ **Erwartet wird genau ein Blockierer:** Ping-O-Matic über Port 80, nach jedem WordPress-Publish, also
  etwa alle zwei Tage eine Alarm-Mail. Kein Vorfall — siehe den Punkt zu den Update Services.
  ⚠️ Die `/32` auf die Baseball-Adresse veraltet, sobald Infomaniak sie wechselt. Dann hängt der Abruf im
  Timeout statt im 301, und der Alarm meldet es. Erledigt sich mit dem `spo-por-por-p`-Punkt.
- [ ] **Paris beobachten, dann `BLOCK`.** Whitelist am 2026-10-06 von 59 auf **65** erweitert (verifiziert
  über `list-firewall-domains`), Catch-all weiterhin `ALERT`. Neu: `*.githubusercontent.com`, `ghcr.io`,
  `*.ghcr.io`, `registry.librechat.ai`, `*.iconify.design`, `*.clearurls.xyz` — fünf für LibreChat, eines
  für eine ECS-Instanz. Grundlage: 14 ALERT-Treffer auf 7 Domains in 7 Tagen gegen **274.829** erlaubte
  Anfragen, die Whitelist deckte schon vorher 99,995 % ab.
  **Zwei, drei Tage prüfen**, ob die ALERT-Liste leer bleibt. Erwartet wird als einziger Rest
  `*.bc.googleusercontent.com` — der Bot-Verifikations-Lookup von Solr, bewusst nicht aufgenommen, bis
  sich zeigt, wie oft er auftritt. Erst bei stabil leerer Liste kommt `BLOCK`.
- [ ] **Frankfurt beobachten, dann `BLOCK`.** Whitelist am 2026-10-06 auf **62** erweitert (`*.db-ip.com`). Gemessen über
  7 Tage: **8 ALERT-Treffer gegen 1.507.522 erlaubte Anfragen** — die 61er-Liste sitzt auf 0,0005 % genau.
  Die acht: `download.db-ip.com` (4, GeoIP-Datenbank für Matomo → aufnehmen), zwei **MX-Abfragen**
  (`t-online.de`, `tsg1846bretzenheim.de` aus Kontaktformularen), der Bot-Verifikations-Lookup
  `*.bc.googleusercontent.com` wie in Paris, und ein Lookup auf den Namen **`DEFAULT`**.
  ✅ **Die MX-Treffer belegen, dass `DnsFirewallAllowMxQueries` Bedarf ist, nicht Vorsorge** — in Paris gab
  es keinen einzigen, hier laufen die Kundenseiten mit ihren Formularen.
  ❌ `DEFAULT` nicht aufnehmen: ein nicht ersetzter Platzhalter in einer Konfiguration, dasselbe Muster wie
  `/suche/SEARCH_Q`. Quelle ist `10.1.3.224`.
  ℹ️ `rpc.pingomatic.com` steht auf der Whitelist, während der Egress seit 2026-10-06 Port 80 dorthin
  blockiert — folgenlos, aber der Eintrag kann weg, sobald die Update Services geleert sind.
- [x] **Frankfurt vollständig durchgesehen, 2026-10-09 — sauber.** 14 Tage, 19 Services, alle verworfenen
  Egress-Flows. Externe Ziele: **eine** Zeile, `10.1.3.244 → 66.6.42.254:80` am 08.10. 06:51, 4 Flows —
  der dokumentierte Ping-O-Matic-Aufruf. Private Subnetze (EFS, RDS, Instanz zu Instanz): **null**.
  Kein Mailisk-Problem; die 587-Regel ist dort seit dem 06.10. drin und trägt.
  ✅ **Die Toolchain läuft in Frankfurt nicht.** `EgressExtraRules` enthält dort kein 4318 — liefe sie,
  stünden die Versuche in der Liste. Also **keine 4318-Regel für Frankfurt**, der Platz bleibt frei.
  ⚠️ Vorbehalt: In Paris lief sie zweimal in 14 Tagen. Bei monatlichem Rhythmus hätten wir sie verpasst.
  Sauberer Beleg wäre die DNS-Abfrage auf `fly|doppler|depot` über 7 Tage, die auch ohne Block anschlägt.
  📌 **Methodischer Befund, wichtiger als das Ergebnis:** Die unspezifische Abfrage lieferte 50 Zeilen —
  alle aus der `SgVpcLoadbalancerports`-Klasse (ephemere Ports, Ziele in den öffentlichen Subnetzen
  `10.1.1.x`/`10.1.2.x`), davon der Block vom 06.10. 14:34–15:15 der bekannten defekten Instanz. Das
  Ergebnis war **am Limit abgeschnitten**; ein echtes Problem wäre darin unsichtbar geblieben. In Paris
  kamen sieben saubere Zeilen. Das ist ein neues Argument für die offene Entscheidung zu
  `SgVpcLoadbalancerports`: Die Klasse ist nicht nur eine Mail alle paar Tage, sie macht die Forensik
  unbrauchbar.
  ℹ️ **Auswertung deshalb immer nach Zielklasse trennen:** `dstaddr not like /^10\./` für echten
  Außenverkehr, `dstaddr like /^10\.1\.[34]\./` für die privaten Subnetze. Was auf `10.1.1.x`/`10.1.2.x`
  mit ephemerem Port zeigt, ist Connection-Tracking-Rauschen und gehört herausgefiltert.

- [ ] **Alle Instanzen suchen sich selbst unter `ec2.internal` — rund 4.300 NXDOMAIN pro Tag.**
  Gemessen 2026-10-09 über 2 Tage: alle **15** Instanzen, je ~2.300 Anfragen, also ~580 pro Instanz und Tag.
  Vier Anfragen je Ereignis (A und AAAA, zusätzlich mit doppelt angehängtem Suffix
  `ip-10-1-4-196.ec2.internal.ec2.internal`), Intervall rund fünf Minuten.
  **Die Zone ist falsch:** in `eu-west-3` heißt sie `eu-west-3.compute.internal`; `ec2.internal` existiert
  nur in `us-east-1`. Das steckt im Basis-Image oder der Launch-Template-Konfiguration, nicht in einem
  Service — es betrifft ausnahmslos jede Instanz.
  ✅ **Kein Hindernis für `DnsFirewallCatchAllAction=BLOCK`:** `*.ec2.internal.` und `*.compute.internal.`
  stehen beide auf der Whitelist (geprüft 2026-10-09). Deshalb die 8 ALERT-Treffer in der Frankfurter
  7-Tage-Messung statt Tausender. Ohne diese Einträge würde der blocked-query-Alarm ab dem Umschalten im
  Minutentakt feuern und wäre von der ersten Stunde an unbrauchbar.
  ⚠️ **Der Whitelist-Eintrag verdeckt den Fehler, er behebt ihn nicht.** Die Anfragen laufen weiter ins
  Leere, nur erlaubt statt alarmiert. Sie sind außerdem Rauschen im DNS-Query-Log und machen jede
  Auswertung dort teurer — bei der heutigen Suche nach dem 8.8.8.8-Verursacher haben sie direkt gestört.
  ✅ **Ursache gefunden, und sie liegt in diesem Repo — nicht im Base-Image.**
  `ecscluster-vpc-rds-asg/index.template`, Ressource `Dhcpopts`: `"DomainName": "ec2.internal"`, fest
  verdrahtet. Das ist der Vorgabewert von `us-east-1`, vergeben an VPCs in `eu-west-3` und `eu-central-1`.
  Kette: VPC verteilt per DHCP → `search ec2.internal` in der `resolv.conf`, Hostname
  `ip-<ip>.ec2.internal` → Selbstauflösung ergibt NXDOMAIN → Stub-Resolver hängt die Suchdomäne an und
  probiert `…ec2.internal.ec2.internal` → wieder NXDOMAIN → mal zwei für A und AAAA.
  ➡️ **Fix, eine Zeile, regionsabhängig** — dieselbe Regel, die AWS ohne eigenes Optionsset anwendet:
  `"DomainName": {"Fn::If": ["IsUsEast1", "ec2.internal", {"Fn::Sub": "${AWS::Region}.compute.internal"}]}`
  mit `"IsUsEast1": {"Fn::Equals": [{"Ref":"AWS::Region"}, "us-east-1"]}`.
  ⚠️ **Beim Ausrollen:** DHCP-Optionssets sind unveränderlich, CloudFormation legt ein neues an und hängt
  es ans VPC um — `Dhcpopts` erscheint im Change Set mit `Replacement: True`. Harmlos, es ist eine
  Zuordnung, kein Netzeingriff. Laufende Instanzen behalten ihre `resolv.conf` bis zur Lease-Erneuerung
  oder zum Neustart; vollständig wirkt es erst mit dem nächsten AMI-Rollover. Kaputtgehen kann nichts —
  was heute auf `.ec2.internal` zeigt, löst ohnehin nicht auf.
  ℹ️ Danach `*.ec2.internal.` in **beiden** Regionen von der Whitelist nehmen. Ein Eintrag weniger, der nur
  existiert, um ein selbstgemachtes Problem stumm zu stellen.
  ℹ️ `Dhcpopts` hat bisher keine `Metadata.Note`. Beim Fix eine setzen, die die Regionsabhängigkeit erklärt.

- [ ] **`8.8.8.8:53` wird bei jedem Toolchain-Lauf versucht — nicht freigeben, Ursache abstellen.**
  Gemessen 2026-10-09 über 14 Tage: `10.1.4.233` am 07.10. und `10.1.4.196` am 08.10., je 2 Flows, 2 Pakete,
  rund zwei Minuten nach Beginn des Laufs — auf genau den Instanzen, die auch `4318` versuchen. Systematisch,
  nicht einmalig. (Mein erster Eindruck „einmaliger Konnektivitätstest" war falsch.)
  ❌ **Keine Regel dafür.** `53:8.8.8.8/32` hieße: jeder Container im Cluster löst jeden Namen auf, ohne dass
  die DNS-Firewall es sieht — keine Whitelist, kein Query-Log, kein `firewall_rule_action`. Die Namensebene,
  auf der die 66er-Liste und der geplante `BLOCK`-Umstieg aufbauen, wäre durch Angabe eines anderen Resolvers
  umgehbar. Das ist die einzige der diskutierten Regeln, die eine Kontrolle nicht lockert, sondern aufhebt.
  ⚠️ **Folge, die jetzt relevant wird:** Seit `4318` erlaubt ist, löst der nächste Toolchain-Lauf trotzdem
  Alarm aus — wegen dieser zwei Pakete. Ein Alarm bei jedem Deploy wird nach dem dritten Mal ignoriert, und
  dann steht man wieder da, wo der 02.10. geendet hat.
  ✅ **Untersucht am 2026-10-09, Ursache nicht lokalisierbar — Suche eingestellt.**
  `dnsServers` in der Task-Definition ist **leer**, es ist also keine ECS-Einstellung. Das Container-Log
  schweigt im fraglichen Fenster (der Service schreibt Streams, aber nichts zu diesem Zeitpunkt). Die
  Vermutung, die NXDOMAIN-Selbstauflösungen unter `ec2.internal` lösten einen Resolver-Rückfall aus, ist
  **widerlegt**: die erzeugen alle 15 Instanzen, 8.8.8.8 versuchten nur die zwei Toolchain-Instanzen.
  **Belegt bleibt die Zuordnung:** 15 Instanzen im Cluster, nur `10.1.4.233` und `10.1.4.196` haben je
  8.8.8.8 versucht, beide während eines Laufs. Es kommt aus der Toolchain, nicht aus dem Basis-Image.
  Weiter käme man nur mit einem Mitschnitt auf der Instanz — dafür ist der Befund zu klein: zwei Pakete,
  keine Funktionsstörung. Entscheidung unverändert: **keine Regel.**
  📌 Der wiederkehrende Alarm bei jedem Toolchain-Lauf bleibt damit bestehen und ist ein Argument mehr für
  den Abschnitt zur Deploy-Toolchain: diese Last gehört nicht auf eine Instanz mit fremden Kundenservices.

- [ ] **EFS war am 2026-10-02 sechs Minuten blockiert — der Alarm hat gemeldet, niemand hat hingesehen.**
  Gefunden am 2026-10-09 bei der Durchsicht aller geblockten Egress-Flows in Paris (14 Tage).
  `10.1.3.78` und `10.1.3.226` → `10.1.3.41:2049`, 22:30:39–22:36:50 UTC, 35 Flows, 112 Pakete.
  `10.1.3.41` ist das EFS-Mount-Target `fs-0ae46acff386ad121` (Gruppe `SgVpcEfs`). `dstport 2049` heißt
  echte Client-Verbindungen, kein Connection-Tracking-Effekt — die Egress-Regel der Instanz hat zugemacht.
  **Ursache, aus den Stack-Events rekonstruiert:** Der Abend war eine Bastelsitzung an den Egress-Regeln —
  vier Updates in einer Stunde, eines davon (22:20) `UPDATE_FAILED` auf allen vier SG-Ressourcen mit
  Rollback. Der Block beginnt drei Minuten **nach** Abschluss des 22:27-Updates und endet achtzehn Sekunden
  **vor** Beginn des 22:37-Updates. Das 22:27-Update hat die Gruppen also in einem Zustand hinterlassen, in
  dem `2049` nicht erlaubt war; das 22:37-Update hat es korrigiert.
  ✅ **Entwarnung für den Regelbetrieb:** Es war kein Zeitfenster während eines Updates, sondern eine
  Zwischenkonfiguration beim Durchprobieren. Normale Updates unterbrechen den EFS-Zugriff nicht — beim
  Update am 09.10. um 08:44 lief nichts auf 2049 auf.
  ⚠️ **Der Alarm hat funktioniert — das ist der eigentliche Befund.** `VpcEgressBlockedAlarm` wurde um
  21:48:10 angelegt, also 42 Minuten vorher. Historie: `OK → ALARM` um **22:32:27**, zurück auf `OK` um
  22:38:27. Die Mail ging knapp zwei Minuten nach dem ersten blockierten Paket raus.
  📌 **Lehre:** Alarme während eines Änderungsfensters sind wertlos, weil sie nicht von den Folgen der
  eigenen Änderung zu trennen sind. Die Mail wurde als Rauschen der laufenden Arbeit abgehakt, und dass
  dahinter sechs Minuten ohne gemeinsamen Speicher standen, hat eine Woche lang niemand gesehen.
  Bei längeren Umbauten an den Security Groups gehört entweder eine Nachkontrolle der geblockten Flows
  dazu, oder der Alarm wird bewusst stummgeschaltet und danach gezielt wieder scharf gestellt.
  ℹ️ `10.1.3.78` existiert nicht mehr, seither ersetzt. Für die Erklärung nicht nötig.

- [x] **Paris braucht `587` — belegt am 2026-10-09 durch eine Testmail, erledigt am selben Tag.**
  Frankfurt läuft seit 2026-10-06 mit `587:0.0.0.0/0`, Paris hatte keine SMTP-Regel. Die erste Testmail
  nach der Umstellung hing: `10.1.4.198 → 95.217.210.26:587`, drei Versuche, sieben Pakete — SYN plus
  Retransmits, der Absender lief in den TCP-Timeout. Alarm `OK → ALARM` 09:01:39 UTC, Datenpunkt 2.0.
  `whois`: Hetzner Online GmbH, `CLOUD-HEL1`, Finnland.
  ✅ **Über 14 Tage ist das der einzige Treffer auf 587.** Vor dem 09.10. hat in Paris nichts Mail
  verschickt — es lief also nicht tagelang ins Leere, es wurde nie versucht.
  ➡️ **Entscheidung: `EgressExtraRules = 4318:149.248.192.0/19,587:0.0.0.0/0`**, also wie Frankfurt.
  Gegen eine `/32` auf die Hetzner-Adresse spricht der Betrieb: **alle Staging-Services sollen Mailisk
  nutzen, aber nicht jeder Entwickler hat AWS im Blick.** Wechselt Mailisk die Maschine, sieht der
  Entwickler eine hängende Mail und der Alarm landet bei jemand anderem — das erzeugt Rückfragen statt
  Erkenntnis. Dazu: Gleichstand mit Frankfurt heißt, Paris probt wieder, was Produktion tut.
  ⚠️ **Preis, ausdrücklich in Kauf genommen:** SMTP von jedem Container an jedes Ziel. Der Egress-Alarm
  sieht diesen Kanal nicht mehr, weil er erlaubt ist. Verbleibende Kontrolle ist die DNS-Firewall —
  `mailisk.net` steht auf der Whitelist, ein Ziel per Namen braucht einen Eintrag. Gegen eine hartkodierte
  IP greift auch das nicht. Mit `DnsFirewallCatchAllAction=BLOCK` wird die Schicht deutlich enger.
  ℹ️ **Später verengen, wenn sich die Lage ändert:** sobald Mailisk feste Adressen zusagt, oder wenn der
  Katch-All auf `BLOCK` steht und die Namensebene trägt. Dann gilt dasselbe für Frankfurt.
  ✅ **Ausgerollt und bestätigt am 2026-10-09:** Regel gesetzt, Testmail wiederholt, **Mails kommen an.**
  Damit ist nicht nur die Regel verifiziert, sondern der ganze Pfad — Namensauflösung über die Firewall,
  SMTP-Verbindung, Zustellung. Das ist der Abschluss, nicht die Security-Group-Zeile.
  ⚠️ Danach stehen in Paris **zwei von vier** `EgressExtraRules`-Plätzen, in Frankfurt ebenfalls zwei
  (`587`, `80:<baseball>/32`) — plus `4318`, falls die Toolchain dort überhaupt läuft, wären es drei.

- [ ] **Erster Egress-Treffer in Paris, 2026-10-07 14:13 UTC — `lab-fac-app-s` auf `10.1.4.233`.**
  24 TCP-Versuche in 30 Minuten nach `149.248.216.54:4318`, je 5 Pakete, also SYN plus Retransmits — keine
  Verbindung kam zustande.
  Ziel ist `fly-otel-collector-prod.fly.dev`, der OTLP-Collector von Fly.io — belegt über
  `DnsQueryLoggingConfig`, Auflösung um 14:13:40 UTC, und über `whois` (NetName `FLYIO`).
  ⚠️ **Nicht geprüft:** dass dieser Name tatsächlich auf `149.248.216.54` zeigt. Die Resolver-Logs enthalten
  nur die Frage, nicht die Antwort. Die Zuordnung ist Indizienkette — gleiche Instanz, gleiche Minute,
  Fly-eigene Adresse, passender Port. `dig +short fly-otel-collector-prod.fly.dev` schließt sie.
  ℹ️ **Warum trotz Whitelist geblockt?** Zwei Schichten, die nichts voneinander wissen. Die DNS-Firewall
  entscheidet über *Namen* — `*.fly.dev` steht drauf, die Auflösung lief durch (`NOERROR`). `SgEgress`
  entscheidet über *Ports* und kennt keine Namen — 4318 steht nicht in der `restricted`-Liste, also fiel die
  TCP-Verbindung. Beide haben getan, wofür sie da sind. Über 443 wäre dasselbe lautlos durchgegangen.
  ✅ **Ausgerollt in Paris am 2026-10-09, 08:44 UTC** (`1.7.13` → `1.7.14`, `UPDATE_COMPLETE`). Regel in
  `sg-07aad6ea5f1c9e817` verifiziert: `tcp 4318 → 149.248.192.0/19`. Change Set vorher geprüft — keine
  Ersetzung, keine Löschung, WAF bitgleich. Offen bleiben: derselbe Schritt in **Frankfurt**, der
  Template-Kommentar mit den fünf Punkten unten, und die Bestätigung beim nächsten `lab-fac-app-s`-Deploy,
  dass `labc-eu-w3-egress-blocked` still bleibt.
  ➡️ **Entscheidung revidiert, 2026-10-09: 4318 wird freigegeben, zielbeschränkt.**
  ```
  EgressExtraRules = 4318:149.248.192.0/19
  ```
  **Begründung für den Template-Kommentar, wenn die Regel gesetzt wird** — ohne sie steht dort ein roher
  Hosting-Bereich ohne erkennbaren Grund, und genau das wollen wir nicht:
  1. **Warum überhaupt.** Vom Team geprüft: flyctl hängt `:4318` fest an und schickt Klartext-HTTP, der
     Port ist nicht konfigurierbar. Ohne ihn kippt die Domain-Verifikation beim Deploy. Es ist also nicht
     nur Analytik, auch wenn OTLP selbst nichts verifiziert — siehe den Mechanismus weiter unten.
  2. **Warum eine CIDR und kein Name.** Security Groups kennen keine Namen.
     `fly-otel-collector-prod.fly.dev` ist Anycast, eine `/32` wäre morgen falsch.
     `149.248.192.0/19` ist Flys ARIN-Bereich (`whois`, NetName `FLYIO`, 2026-10-07).
  3. **Warum nicht `0.0.0.0/0`.** Offen ist damit 4318 **nach Fly.io**, nicht 4318 ins Internet. Für eine
     Exfiltration ist die Regel nur brauchbar, wenn der Empfänger ausgerechnet bei Fly mietet; für jedes
     andere Ziel bleibt der Melder scharf. Das ist der eigentliche Gegenwert dieser Formulierung.
  4. **Was sie nicht ist: eine Ausnahme für einen Task.** Bridge-Mode, eine Security Group pro Instanz —
     die Regel gilt clusterweit für alle Services. Per-Task ginge nur über `awsvpc`, siehe unten.
  5. **Wann sie bricht.** Fly hat weitere Bereiche. Zieht der Collector um, kommt der Alarm zurück. Dann
     **erweitern, nicht ersetzen** — und die neue Range wieder über `whois` belegen, nicht raten.
  ⚠️ Kostet einen von vier `EgressExtraRules`-Plätzen, dauerhaft. Bei der nächsten Ausnahme prüfen, ob
  vier noch reichen.
  ⚠️ **Vorher noch zu testen, kostet nichts:** Falls flyctl `:4318` an einen konfigurierbaren *Host*
  anhängt, reicht `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1` — Port bleibt 4318, Ziel ist lokal,
  Connection-Refused kommt sofort. Ist auch der Host fest verdrahtet, erledigt sich das und die Regel kommt.
  ℹ️ **Der Mechanismus, warum ein Telemetrie-Port einen Deploy kippt:** Security Groups verwerfen lautlos,
  sie schicken kein RST — daher 5 Pakete pro Versuch, SYN plus Retransmits. Der Exporter läuft in den
  TCP-Timeout statt sofort zu scheitern, und der Schritt, der auf das Flush wartet, meldet Fehlschlag. Nicht
  reparierbar am Netz: weder Security Groups noch NACLs können Reject, nur Drop.
  ❌ **`OTEL_SDK_DISABLED` hilft nicht** — laut OTel-Doku vom Go-SDK nicht unterstützt, und flyctl ist Go.
  Gelesen werden `OTEL_EXPORTER_OTLP_ENDPOINT` und `OTEL_EXPORTER_OTLP_TIMEOUT`.
  ❌ **Verworfen: `FLY_SEND_METRICS=false`.** War die ursprüngliche Empfehlung und ist hinfällig, nachdem
  der Port als funktional nötig bestätigt ist. Hätte ohnehin nur die Metriken betroffen, nicht den Export.
  ℹ️ **Per-Task ginge nur über `awsvpc`.** Heute: `Task.NetworkMode = bridge`, `Target.TargetType = instance`
  — alle Tasks teilen die Instanz-ENI und deren Security Groups. Mit `awsvpc` bekäme jeder Task eigene ENI,
  eigene IP und **eigene Security Group**, und wäre in den Flow Logs einzeln sichtbar; das Zuordnungsproblem
  aus diesem Vorfall verschwände. Preis: `TargetType` auf `ip` (Target Group wird ersetzt, die Listener-Regel
  in `alb-ecsservice-rule` hängt daran), `NetworkConfiguration` mit Subnetzen und SGs als neue Parameter,
  eine ENI pro Task gegen die Instanztyp-Grenze (ohne `awsvpcTrunking` schnell eng), Service-Ersetzung.
  Generische Template-Fähigkeit, also hier grundsätzlich legitim — aber ein eigenes Vorhaben, nicht wegen 4318.
  ℹ️ **Gilt nicht nur für diesen Service:** flyctl wird auch anderswo benutzt, derselbe Export taucht überall
  auf, wo es läuft. Das spricht zusätzlich gegen eine Einzelausnahme und für die zielbeschränkte Regel.
  ❌ **GuardDuty ist dafür kein Ersatz.** Es fragt „ist dieses Ziel bekannt bösartig?" (Reputationslisten,
  C&C, Tor, DGA), nicht „ist dieses Ziel erlaubt?". Eine saubere IP bei einem seriösen Hoster auf einem
  erlaubten Port erzeugt dort nie ein Finding — genau der Weg, den eine Exfiltration nehmen würde. Die
  Portsperre ist blind für Reputation und meldet trotzdem. Komplementär, nicht überlappend.
  ℹ️ Runtime Monitoring (unterstützt inzwischen ECS) wäre die Schicht, die „welcher Container war es"
  beantwortet — im Bridge-Mode fehlt uns genau das. Eigene Entscheidung, kostet Agent und Geld pro Instanz.
  ✅ **Geklärt:** In 150 DNS-Zeilen dieser Instanz steht kein einziges `firewall_rule_action`, obwohl der
  Paris-Katch-All auf `ALERT` steht — weil `*.fly.dev`, `*.fly.io`, `*.machines.dev`, `*.depot.dev`,
  `*.doppler.com`, `*.supabase.co`, `*.launchdarkly.com` und `registry.npmjs.org` alle auf der Whitelist
  stehen (`rslvr-fdl-73703a754ed5450f`, 66 Einträge, geprüft 2026-10-07). Die Firewall arbeitet korrekt und
  die Toolchain war ihr bereits bekannt. Damit ist die Grundlage für den Umstieg auf `BLOCK` belastbar.
  ✅ **Korrektur zum „nichts kaputtgemacht".** Ursprünglich stand hier, davor habe es sechs Tage lang keinen
  akzeptierten Flow dorthin gegeben. Das trägt nicht: `lab-fac-app-s` läuft nur sporadisch, das letzte
  Deployment vor dem 07.10. liegt Wochen zurück — die Abwesenheit ist durch Untätigkeit erklärt, nicht durch
  die Sperre. Der belastbare Beleg stammt aus dem Lauf selbst: **währenddessen wurde genau eine Zielklasse
  abgewiesen**, die Telemetrie auf 4318. Fly-API, Machines-API, Depot, Doppler, npm und Supabase liefen über
  443 ohne einen einzigen REJECT durch.
  ✅ **„Warum jetzt?" ist beantwortet:** erster Lauf seit Wochen und damit erster Lauf unter `restricted`.
  Keine stille Verhaltensänderung eines Werkzeugs, kein flyctl-Update. Die Telemetrie ging vermutlich immer
  raus, nur war vorher keine Sperre da, die sie gemeldet hätte.
  ⚠️ **Zweiter Fund aus demselben Fenster, anfangs übersehen:** `10.1.4.233 → 8.8.8.8:53/udp`, ein Paket,
  ebenfalls geblockt. Da wollte etwas **am VPC-Resolver vorbei** auflösen. Solcher Verkehr taucht per
  Definition weder im Resolver-Query-Log noch in der DNS-Firewall auf — durchgegangen hätte dieser Prozess
  die gesamte Namenssichtbarkeit und die Whitelist umgangen, ohne Spur. Ein Paket spricht eher für einen
  einmaligen Konnektivitätstest als für System. **Die Egress-Regel hat hier tatsächlich etwas verhindert,
  nicht nur sichtbar gemacht** — das ist der Fall, für den sie gebaut ist.
  ℹ️ **Kein IPv6 im VPC** (`Vpc` hat nur `CidrBlock`, kein Subnetz hat `Ipv6CidrBlock`, vgl. die Note am
  ALB). Die AAAA-Zeilen im DNS-Log sind Normalverhalten jedes Dual-Stack-Clients und bedeuten nichts. Damit
  ist die Flow-Log-Auswertung lückenlos, und GuardDutys fehlende IPv6-Abdeckung bei Flow-Log-Findings trifft
  uns nicht.
  ⚠️ **Folge aus der Sporadik:** Das DNS-Log hält 14 Tage. Bei Deployments im Wochenabstand ist die
  Vorgeschichte beim nächsten Vorfall jedes Mal weg — eine Vergleichsbasis für dieses Werkzeug bekommen wir
  nie. Die oben notierte Domainliste ist deshalb mehr wert als gedacht: sie ist alles, was wir haben.
  ⚠️ **Der nächste Deploy löst wieder Alarm aus**, solange `FLY_SEND_METRICS=false` nicht gesetzt ist — und
  möglicherweise mit neuen Zielen, wenn ein Build etwas anderes zieht. Kein Fehler des Melders, aber wer
  dann draufschaut, muss wissen, dass es Deployments dieses Werkzeugs gibt.
- [ ] **`DnsFirewallCatchAllAction=BLOCK`** — erst nach ein paar Tagen Messung mit den neuen Whitelists, und
  **zusammen mit `DnsFirewallAllowMxQueries=allow`** (ab `1.7.8`), sonst lehnt jedes Kontaktformular
  Adressen bei Anbietern ab, die noch niemand benutzt hat. Paris zuerst. Der blocked-query-Alarm entsteht
  mit dem Umschalten und meldet die erste Abweisung.

---

## Offene Entscheidungen

Teamfragen, keine Aufgaben. Jede blockiert etwas weiter oben.

### 1. Den Origin abriegeln
`SgPublicHttpHttps` steht auf `0.0.0.0/0`, der ALB ist also direkt erreichbar und jeder Client-IP-Header
fälschbar. Drei Fragen, die zusammengehören.

**Welche Seite hängt hinter welcher Front?** Es sind drei Klassen, nicht zwei: CloudFront (schickt bereits
`OriginVerifyHeader`), Cloudflare (`cf-connecting-ip`, kein Geheimheader) und direkt. Die Inventur muss
danach fragen, sonst taugt ihr Ergebnis für keine der Maßnahmen.

**Erzwingen wir den Geheimheader?** Das ist die wirksame Maßnahme und sie ist halb gebaut —
`cloudfront-alb-distribution` sendet ihn, die Listener-Regeln prüfen ihn nicht. Er ist pro Distribution und
nicht erratbar, im Gegensatz zu jeder IP-Liste: Cloudflares *und* CloudFronts Adressbereiche sind von allen
Kunden des Anbieters geteilt. Eine IP-Sperre ist eine Schicht, keine Kontrolle. Cloudflare könnte dasselbe
über eine Transform Rule, die einen Header setzt.
⚠️ Eine IP-Sperre müsste **beide** Fronten abdecken — auf Cloudflares Bereiche eingeschränkt stirbt jede
CloudFront-Seite. Für CloudFront gibt es die AWS-Prefix-Liste `com.amazonaws.global.cloudfront.origin-facing`,
für Cloudflare wäre es eine selbstgepflegte.

**Kann `WafClientIpHeader` überhaupt einen richtigen Wert haben?** Ein Parameter für die ganze WebACL, aber
die vertrauenswürdigen Header unterscheiden sich: `cf-connecting-ip` bei Cloudflare,
`CloudFront-Viewer-Address` bei CloudFront. Der gemeinsame `X-Forwarded-For` ist fälschbar — WAF nimmt die
erste Adresse der Liste, und die kann ein Client voranstellen. Setzt man `cf-connecting-ip`, fallen die
CloudFront-Seiten auf die Quell-IP zurück, also auf CloudFronts Edge-Adressen: derselbe Kollaps wie bei der
NAT-EIP. Das ist eine strukturelle Grenze, kein Konfigurationsfehler.
⚠️ **Der Origin wird direkt angefahren, gemessen 2026-10-01.** Allein auf `/` kamen in sieben Tagen
355 Scanner-Anfragen mit einer **IP-Adresse im `Host`-Header** an, dazu dieselbe Pfadliste auf `/signin`,
`/login`, `/admin` und `/dashboard`. Sie laufen an Cloudflare vorbei, werden von der WAF inspiziert und
kosten, obwohl sie den Origin nie erreichen dürften. Das ist der quantifizierte Beleg für diese
Entscheidung.
⚠️ **Belegt am 2026-09-29, `ado-ada-inf-p`, vier Minuten Ausfall.** 2.101 Anfragen in einer Minute, verteilt
über zwanzig Cloudflare-Knoten — `RateLimitSourceIp` zählte pro Knoten und blieb überall weit unter 2.000.
`cf-connecting-ip` stand in jedem Datensatz und wies zwei Cloud-Adressen mit über tausend Anfragen aus. Der
Header, der es gelöst hätte, lag die ganze Zeit vor. Diese Entscheidung ist nicht mehr theoretisch.

### 2. Ein Fly-Org-Token im dauerhaft laufenden Generator
`lab-fac-app-s` erzeugt statische Seiten und rollt sie über fly.io aus. In 50 Minuten löst der Container
auf: `api.fly.io`, `oidc.fly.io`, `api.machines.dev`, `api.depot.dev` (Remote-Container-Builds),
`api.doppler.com` (Secrets-Manager), `lxdhrgqfmohgzoujfexi.supabase.co`, `clientsdk.launchdarkly.com`,
`registry.npmjs.org` — dazu die Projekt-Apps `heckelsmueller-ai-frontend` und `-ml-frontend`.
**Das Org-Token ist hier kein Versehen, sondern die Anforderung:** eine neue App anlegen geht bei Fly nur
org-weit, ein App-Token kann das nicht. Die Frage ist deshalb nicht, wie man das Token verengt, sondern was
die Organisation enthält, auf die es zeigt.

**Was den Befund entschärft — damit es niemand neu herleitet:**
ℹ️ Die Seiten sind rein statisch, ohne CMS und ohne Datenbank. Damit trägt die Kette
„Deploy → Code-Ausführung → Laufzeit-Secrets auslesen" für diese Apps nicht: es liegt nichts zur Laufzeit da.
ℹ️ Die Doppler-Tokens sind read-only pro Service und Umgebung. Lesbar bleiben die Secrets genau dieses
Services in dieser Umgebung — bei Staging wenig.
➡️ **Verworfen:** eigener Capacity Provider bzw. Auslagern in einen CI-Runner. War die erste Empfehlung und
ist nach beidem oben zu groß für das, was tatsächlich hier liegt. Die geteilte Instanz ist damit normale
Mehrmandantenfähigkeit wie bei den übrigen Services, kein Sonderfall.

**Was bleibt:**
⚠️ **Integrität der ausgelieferten Seiten.** Wer deployen darf, ersetzt den Inhalt einer laufenden
Kundenseite vollständig — bei statisch restlos, das Artefakt *ist* die Seite. Ausgeliefert wird das unter
der Kundendomain mit gültigem Zertifikat. Kein Datenabfluss, sondern Reputation und Haftung.
⚠️ **Der Scope.** Ein Org-Token erreicht jede App der Organisation. Dass diese beiden Seiten statisch sind,
sagt nichts über alles andere, was dort liegt.
⚠️ **Die Laufzeit.** Ohne `-x` setzt Fly das Ablaufdatum auf **20 Jahre** (`fly tokens create`, Doku
`flyctl/integrating`). Ein unbefristetes Token in einem dauerhaft laufenden Container.
⚠️ **Kein Audit-Trail.** In den Fly-Docs findet sich kein org-weites Protokoll „wer hat wann womit
deployt" — Logs und Metriken sind pro App.
⚠️ **Die Egress-Sperre hilft hier nicht.** Alles davon läuft über 443, das unter `restricted` nach
`0.0.0.0/0` offen ist. Geblockt wurde einzig die Telemetrie auf 4318 — das Unwichtigste.

**Zuerst zu klären, eine Zeile:** `fly tokens list --scope org` — welcher Typ, welcher Ablauf.

**Optionen, in der Reihenfolge ihres Hebels:**

**A. Eine eigene Fly-Org für genau diese Klasse.** Flys eigenes dokumentiertes Muster
(`blueprints/staging-prod-isolation`). Das Token bleibt allmächtig, aber nur noch über generierte statische
Seiten, die der Generator jederzeit neu baut. Ein Vorfall kostet dann einen Rebuild statt einer
Untersuchung. Bedingung: dort darf nichts anderes liegen — nichts mit Daten, nichts Internes, nichts, was
nicht aus dem Generator kommt. Kostet nichts, ändert nichts am Werkzeug.
`fly orgs create labor-sites`, bestehende Apps per `fly apps move <app> --org labor-sites` ohne Neuaufbau.
Wenn Staging und Prod ohnehin getrennt sind: zwei Orgs, zwei Tokens — das Staging-Werkzeug in Paris sieht
das Prod-Token nie.

**B. Die zwei Rechte auseinanderziehen.** Eine App *anlegen* ist selten und braucht Org-Scope, auf eine
bestehende Seite *deployen* ist häufig und braucht nur App-Scope. Der laufende Container hält dann nur
App-Tokens der existierenden Seiten (aus Doppler, das er ohnehin liest), das Org-Token liegt außerhalb und
wird nur beim Anlegen einer neuen Seite benutzt.
⚠️ Lohnt sich nur, wenn neue Seiten selten entstehen. Bei täglich einer neuen Seite ist es
Verwaltungsaufwand mit einem Token pro Seite — dann A allein.

**C. Ablaufdatum, aber nur mit Besitzer.** `fly tokens create org -o <org> -x 720h`. Ohne etwas, das neu
ausstellt, erzeugt das in 30 Tagen schlicht einen Ausfall. Da Doppler schon im Einsatz ist, gehört Token
und Erneuerung dorthin. **Ohne Rotationsbesitzer ist das unbefristete Token ehrlicher.**

**D. Deploy-Protokoll auf unserer Seite.** Der Generator weiß, was er ausrollt. Schreibt er jeden Deploy
mit App-Name, Image-Digest und Zeit in seine Log-Gruppe, fällt ein Deploy, der *nicht* von ihm kam, durch
Abwesenheit auf. Ersetzt den fehlenden Fly-Audit-Trail und ist billig. Sinnvoll zusätzlich zu A.

**E. Token nicht dauerhaft in der Umgebungsvariable,** sondern pro Deploy aus Doppler holen.
⚠️ Schwache Maßnahme, der Vollständigkeit halber: ein übernommener Container wartet einfach auf den
nächsten Deploy. Nur zusammen mit B sinnvoll.

**Empfehlung, wenn es eine Sache sein soll: A.**

**Offen und unabhängig davon:** Zwei Dinge aus dem DNS-Log passen nicht zu „rein statisch, ohne Datenbank".
`lxdhrgqfmohgzoujfexi.supabase.co` ist eine Datenbank — entweder gehört sie zum Build-Werkzeug, oder die
Frontends sprechen im Browser mit Supabase, dann liegt ein Anon-Key im Bundle und alles hängt an den
Row-Level-Security-Regeln dort. Ebenso `heckelsmueller-ai-frontend`: entweder gar kein Schlüssel im Client
oder einer im ausgelieferten Bundle und damit öffentlich. Kein Fly-Thema, aber einen Blick wert.
ℹ️ Paris ist Staging. **Läuft dasselbe in Frankfurt?** Query steht aus: DNS-Log `labc-eu-c1-DnsFirewallLogs`,
7 Tage, `query_name` auf `fly.dev|fly.io|doppler|depot.dev|machines.dev`.

### 3. Lebensdauer einer Apache-Anfrage
Der ALB gibt nach 60 s auf, Apache nicht — diese Asymmetrie hat aus einer langsamen Anfrage einen Ausfall
gemacht. `Timeout 60` plus `mod_reqtimeout` in `docker-base-images-v2`. Vorher ist zu bestätigen, dass
keine Verwaltungsaufgabe, kein Import und kein `wp-cron`-Lauf berechtigt länger braucht.

---

## `ecscluster-vpc-rds-asg`

- [ ] **Paris lief auf einem `1.7.13`, das es in Git nicht gibt.** Beim Change-Set-Review am 2026-10-09
  aufgefallen: `TemplateVersion` im Stack war `1.7.13`, der Vorgängercommit von HEAD ist `1.7.12`, HEAD
  selbst `1.7.14`. Der deployte Stand entsprach also keinem Commit — vermutlich aus einer Arbeitskopie
  deployt, in der `token` schon aus `WafSecretPathPatterns` entfernt, aber noch nichts committet war.
  ✅ Inhaltlich folgenlos: das WebACL war bitgleich mit 1.7.14 (sha256 über `Properties`, jq-normalisiert),
  keine Abweichung in Regeln, Prioritäten, Aktionen oder Managed-Rule-Ausnahmen.
  ⚠️ Der Review hat trotzdem einen halben Tag gekostet, weil sich die Differenz nicht lokal ausrechnen
  ließ. **Regel daraus: erst committen, dann deployen** — oder zumindest die Version nicht hochzählen, wenn
  der Stand nicht im Repo liegt. Sonst ist beim nächsten Change Set wieder unklar, wogegen man vergleicht.
  ℹ️ Nützlich für den nächsten Review, kostet nichts:
  `aws cloudformation get-template --query 'TemplateBody.Resources.<X>.Properties' --output json | jq -S -c . | sha256sum`
  gegen denselben Ausdruck lokal. Wichtig: **beide Seiten mit `jq -S -c` normalisieren**, sonst vergleicht
  man Formatierung statt Inhalt.

- [ ] **`ElbHttp5xxAlarmThreshold` von 10 auf 0 — in Paris belegt, für Frankfurt erst messen.**
  Gemessen 2026-10-09 über `HTTPCode_ELB_5XX_Count` mit der **LoadBalancer**-Dimension (nicht
  `TargetGroup` — damit kommt die Abfrage stumm zurück und sieht aus wie „keine Fehler"):
  **drei Ereignisse in sieben Tagen**, je eins am 02.10. 17:00, 08.10. 09:00 und 09.10. 09:00.
  Grundrauschen also 0,43 am Tag gegen eine Schwelle von 10 je 5 Minuten — der Alarm schlägt erst bei
  einem Einbruch an, bei dem ohnehin das Telefon klingelt.
  ➡️ Mit Schwelle 0 meldet jeder einzelne 5xx; das sind nach Messung **drei Mails pro Woche**. Erst damit
  stimmt die Aussage in der Note am `VpcEgressBlockedMetricFilter`, dass Anfragen jenseits des
  Idle-Timeouts hier gemessen gehören — bei Schwelle 10 sieht dieser Alarm die rund zwei täglichen
  `warmCache`-Timeouts nie.
  ⚠️ **Nicht ungeprüft nach Frankfurt übertragen.** Paris ist Staging mit wenig Verkehr; 19
  Produktionsservices haben ein anderes Grundrauschen, und dort laufen die Timeouts überhaupt erst auf.
  Dieselbe Messung vor dem Umstellen — der Parameter ist pro Stack.
  ℹ️ Fährt mit Deploy B mit (`BLOCK`-Umschaltung), zusammen mit Template `1.7.17`.

- [ ] **Note am `VpcEgressBlockedMetricFilter` umschreiben — die Begründung stimmt seit dem 09.10. nicht mehr.**
  Dort steht sinngemäß „die ausgeschlossene Klasse ist harmlos". Nach der Analyse vom selben Tag ist das
  nur für die eine Hälfte richtig. Die Klasse zerfällt in zwei Populationen:
  **A** — ephemerer Quellport, ~40 Byte je Paket: AWS-Tracking abgelaufen, FIN/RST beim Verbindungsabbau.
  Entsteht bei jedem ASG-Instanztausch und bei lange stillen Verbindungen. Tatsächlich folgenlos.
  **B** — Quellport **443**, 1466–1500 Byte je Paket: Docker-NAT-Abbildung weg, das Backend schreibt eine
  späte Antwort in eine Verbindung, die der ALB nach 60 s Timeout geschlossen hat. Trägt volle Nutzlast,
  ist aber **Folge** des Timeouts, nicht dessen Ursache — der Nutzer hat sein 504 längst bekommen.
  ➡️ Die Ausnahme bleibt richtig, aber die Begründung muss lauten: *nicht weil es harmlos ist, sondern weil
  es Symptom eines Problems ist, das an seiner eigenen Stelle gemessen gehört* — Klasse A bei der
  Instanzgesundheit, Klasse B über `HTTPCode_ELB_5XX_Count` und die Anfragedauer.
  Reine Textänderung, wäre `1.7.16`. Zusammen mit dem nächsten inhaltlichen Deploy mitnehmen, nicht allein.

- [ ] **Nachkontrolle in ein paar Tagen: hört die `ec2.internal`-Flut wirklich auf?**
  `1.7.15` ist am 2026-10-09 in Paris ausgerollt (`UPDATE_COMPLETE`), das VPC hängt jetzt an
  `dopt-0a5abe76f4d1c17d7` mit `domain-name = eu-west-3.compute.internal` — über das VPC geprüft, nicht
  über den Tag, weil die Zuordnung mit `Replacement: True` ersetzt wurde und ein Cleanup sie theoretisch
  auf `default` hätte zurücksetzen können. Hat er nicht.
  ⚠️ **Laufende Instanzen behalten ihre `resolv.conf`** bis zur Lease-Erneuerung oder zum Ersatz. Der
  Effekt tritt erst mit dem nächsten AMI-Rollover vollständig ein.
  ➡️ Prüfen mit derselben Abfrage wie am 09.10.: DNS-Log, `query_name like /ec2\.internal/`, gruppiert nach
  `srcaddr`. Tauchen danach nur noch alte Instanzen auf und neue nicht mehr, hat der Fix gegriffen.
  **Verschwindet es gar nicht, steckt der falsche Suffix zusätzlich im Basis-Image** — dann ist es doch das
  andere Repo und nicht nur die DHCP-Option.

- [x] **Gelöst in `1.7.15`: Die ALB-Antwortklasse bekommt keinen Alarm mehr.** Entschieden und gebaut am
  2026-10-09, nachdem die Frankfurter Nacht gezeigt hat, dass keine Ratenschwelle funktioniert.
  **Messung über vier Tage (Frankfurt, seit `restricted` am 06.10.):** nur 17 Stunden mit Treffern
  überhaupt. Grundrauschen 2–6 Flows pro Stunde, gleichmäßig über den Tag verstreut — **keine nächtliche
  Häufung**, mein Verdacht dazu war falsch. Dazu zwei Ballungen um eine Größenordnung darüber:
  `06.10. 14:00–15:00` mit 180 Flows und `09.10. 01:00–02:00` mit 153.
  **Die beiden Ballungen sind nach Rate praktisch identisch und nach Ursache völlig verschieden:**
  06.10. eine einzelne Instanz bei **100 % CPU** — die sterbende. 09.10. **zwei** Instanzen in
  verschiedenen AZs (`10.1.3.153`, `10.1.4.24`), CPU 3–8 %, und in der Scaling-Historie steht
  `01:35:53 Terminating / 01:35:55 Launching`; der Ausbruch um 01:37 folgt zwei Minuten später, der um
  00:42 auf den Start um 00:01. Kein CloudFormation-Update. **Normaler ASG-Instanztausch — sechs
  Alarmmails in zwei Stunden, in der Produktion.**
  ➡️ **Was sie trennt, ist der Zustand der Instanz, und den misst dieser Alarm nicht.** Deshalb keine
  zweite Schwelle, sondern: Metric Filter schließt `dstaddr` in `10.1.1.*` und `10.1.2.*` aus, die
  gespeicherte Abfrage ebenso, Alarmbeschreibung nachgezogen, Begründung als Note am Metric Filter.
  Die Flow Logs behalten die Klasse vollständig — nur die Metrik ignoriert sie.
  ⚠️ **Die Lücke, die dadurch entsteht, gehört woandershin:** Die sterbende Instanz muss über CPU und
  ECS-Agent-Status gemeldet werden, nicht über ein übergeschwapptes Egress-Symptom. Siehe den offenen
  Punkt zur Speicherüberwachung — das ist dieselbe Baustelle.
  ℹ️ Bewusst in Kauf genommen: Echter blockierter Verkehr **in** die öffentlichen Subnetze würde nicht mehr
  alarmieren. In vier Tagen ging dorthin ausschließlich diese eine Klasse; dort stehen nur ALB und NAT.

- [ ] **`SgVpcLoadbalancerports` blockt Antwortverkehr an den ALB, wenn das Connection Tracking ausläuft.**
  Sicherheitsgruppen sind zustandsbehaftet, Antworten auf eingehende Verbindungen brauchen keine
  Egress-Regel — deshalb steht die Gruppe unter `restricted` auf `127.0.0.1/32`. Fällt ein Eintrag aus der
  Tracking-Tabelle, weil eine Verbindung lange still war, gilt das nächste Paket (meist FIN oder RST) als
  neue ausgehende Verbindung und fliegt raus.
  **Gemessen 2026-10-06, und das Bild ist zweigeteilt:** sechs Pakete um 12:50 von zwei gesunden Instanzen
  — das ist der seltene Normalfall. Dagegen über 170 Pakete zwischen 14:30 und 15:05, **ausschließlich von
  der defekten Instanz** `i-0d418eda09f69e79f`, die seit 13:45 bei 100 % CPU hing: dort war das Tracking
  schlicht überfordert. Sechs Alarme in dreißig Minuten.
  ⚠️ **Korrigiert am 2026-10-09:** Hier stand, der Alarm habe genau das geleistet, wofür er gebaut wurde.
  Das ist zu wohlwollend. Er hat die defekte Instanz **zufällig** gefunden, weil deren Symptom in seinen
  Zuständigkeitsbereich überschwappte. Darauf ist kein Verlass — dieselbe Überlastung kann beim nächsten
  Mal drei Flows erzeugen und nichts melden.
  Zu entscheiden bleibt der Normalfall: Sechs Pakete in drei Stunden sind folgenlos, aber jeder davon
  erzeugt bei Schwelle null eine Mail. Entweder eine Egress-Regel zum ALB-Subnetz ergänzen, oder die
  Seltenheit akzeptieren — ein paar Tage Beobachtung ohne defekte Instanz zeigen, wie oft es wirklich ist.
  **Aus der Alarm-Historie gezählt, nicht geschätzt (Frankfurt, 05.–07.10.):** zehn Übergänge nach `ALARM`,
  **alle am 06.10., keiner am 07.10.** Davon **acht** im Fenster 14:35–15:16 — das ist die defekte Instanz.
  Außerhalb bleiben **zwei**: 12:53 und 22:09, beide der Normalfall (bei 22:08 nachgesehen: zwei Pakete von
  einer gesunden Instanz an einen ephemeren Port des ALB, TCP 7848).
  ⚠️ **Zweites Argument, dazugekommen am 2026-10-09: die Klasse macht die Egress-Forensik unbrauchbar.**
  Die 14-Tage-Durchsicht aller verworfenen Flows in Frankfurt lieferte **50 Zeilen — das Abfragelimit —
  und alle 50 stammten aus dieser Klasse.** Ein echtes Problem hätte darin nicht sichtbar sein können.
  Ursache ist **Kardinalität, nicht Menge**: Jeder abgelaufene Tracking-Eintrag erzeugt einen Flow zu einem
  anderen ephemeren Zielport, also eine eigene Zeile pro Portnummer. Die gemessenen Alarmzahlen bleiben
  davon unberührt — es sind weiter zwei Mails außerhalb der Defektfenster.
  **Die Asymmetrie ist der Punkt:** Paris (Staging) lieferte dieselbe Abfrage mit sieben sauberen Zeilen
  und darin fünf Befunde, vier davon vorher ungemeldet. Frankfurt (Produktion) hätte denselben Fund
  verdeckt. Ausgerechnet dort, wo ein unentdeckter Fehler Kunden trifft, ist das Werkzeug stumpf.
  ➡️ **Damit kostet „Seltenheit akzeptieren" nicht mehr nur gelegentlich eine Mail**, sondern dauerhaft die
  Brauchbarkeit der Egress-Forensik in der Produktion. Erzwungen ist die Regel trotzdem nicht: Die
  Auswertung nach Zielklasse zu trennen behebt es ohne Infrastruktureingriff (siehe die Methodennotiz beim
  Frankfurt-Eintrag). Die Wahl steht zwischen dauerhafter Abfragedisziplin und einer einzeiligen Regel.
  ❌ **Nicht die Alarmschwelle anheben.** Das behebt die Mails und lässt das Logproblem unberührt — man
  verlöre die Erkennung und behielte das Rauschen.
  📌 **Methodisch:** Die Häufigkeit gehört aus der Alarm-Historie gezählt, nicht aus einem Logfenster
  hochgerechnet — ich hatte aus einem einzelnen 40-Minuten-Ausschnitt auf 32 Stunden geschlossen, was der
  Nutzer zu Recht zurückgewiesen hat. `describe-alarm-history` mit Filter auf `to ALARM` liefert die
  Übergänge direkt und macht Ballungen sofort sichtbar.
  **Paris über vier Tage: null.** Gegengeprüft, weil die Stille verdächtig war — es hätte auch der stille
  Metric Filter vom 29.09. sein können. Ist es nicht: die Flow-Log-Formate beider Regionen sind
  zeichengleich (17 Felder, endend auf `pkt-srcaddr pkt-dstaddr flow-direction`), und der Filter hat am
  02.10. nachweislich **35** Egress-Rejects gezählt. Seitdem keinen einzigen. In denselben vier Tagen
  stehen **210.624** REJECT-Einträge in Paris — ausnahmslos `ingress`, also Scanner an geschlossenen
  Ports. Genau dafür filtert der Alarm auf `flow_direction=egress`.
  ⚠️ **Entscheidung vertagt — die Rate in Frankfurt ist höher als zunächst angenommen.** Nach zwei
  Datenpunkten hatte ich empfohlen, die Egress-Regel wegzulassen; ein dritter Alarm am **07.10. 02:05 UTC**
  kippt das. Die drei Ereignisse außerhalb des Instanzausfalls liegen bei **12:53, 22:09 und 02:05** —
  drei in gut dreizehn Stunden, Abstände von vier bis neun Stunden, also rund **drei Mails pro Tag**.
  Das ist kein „Einzelstück" mehr.
  **Alle drei sind dieselbe Klasse**, nachgesehen: 06.10. 22:08 `10.1.3.124 → 10.1.1.247:7848` (2 Pakete),
  07.10. 02:04 `10.1.4.217 → 10.1.2.247:23946` (3 Pakete) — zwei verschiedene Instanzen, beide ALB-Knoten
  (je einer pro Subnetz), jeweils ein **ephemerer** Zielport. Kein Dienst, der irgendwohin will.
  ➡️ **Vorschlag `1.7.14`: die Ursache beheben, nicht die Meldung dämpfen.** In `SgVpcLoadbalancerports`
  unter `restricted` eine Egress-Regel `tcp 1024-65535` mit
  `DestinationSecurityGroupId: SgVpcLoadbalancerportsAccess` — Ziel ist die **Gruppe des Load Balancers**,
  nicht ein Netzbereich. Danach heißt Schwelle null wieder: jede Meldung ist ein echter Fund.
  ⚠️ **Nicht `Vpc.CidrBlock` nehmen** — das war mein erster Vorschlag und er war zu weit. `tcp 1024-65535`
  auf den VPC-Bereich erlaubt jeder Instanz, die **dynamischen Container-Ports der anderen Instanzen**
  (32768–61000) direkt anzusprechen, dazu Aurora auf 3306, EFS auf 2049 und die LibreChat-Instanz — eine
  Tür für seitliche Bewegung, geöffnet um drei Pakete pro Tag loszuwerden. Die Gruppenform öffnet dagegen
  nur zum ALB, und der lauscht auf 80 und 443, beide **unter** 1024 und damit außerhalb der Regel: durch
  gelassen werden ausschließlich Pakete an die ephemeren Ports des ALB, also genau die späten FIN/RST.
  Der breite Portbereich ist nötig, die beobachteten Ports waren 7848 und 23946 — der ALB wählt frei.
  📌 Merksatz: Ziel einer Egress-Regel ist eine **Sicherheitsgruppe**, wo es eine gibt. Ein CIDR trifft
  alles, was zufällig in diesem Bereich liegt, eine Gruppe nur das, was sie trägt.
  ❌ **Schwelle anheben wäre der falsche Weg.** Drei Pakete im Normalfall gegen 170 bei der defekten
  Instanz ließen sich zwar bequem trennen — aber ein echter blockierter Dienst erzeugt genauso wenig
  Pakete, ein Verbindungsversuch sind drei SYN-Wiederholungen. Eine Schwelle, die den Normalfall schluckt,
  schluckt auch den Ernstfall.
  📌 Und: eine Aussage über „heute" um 02:00 UTC ist keine Aussage. Beobachtungsfenster immer in Stunden
  benennen, nicht in Kalendertagen.
  📌 **Zeitzonenfalle:** Die Notiz „EFS-Bruch am 03.10." und der Logeintrag „02.10. 22:38" schienen sich zu
  widersprechen — **22:38 UTC ist 00:38 MESZ am Folgetag**. Unsere Notizen stehen in Lokalzeit, alle Logs
  und Alarm-Zeitstempel in UTC. Bei Vorfällen nahe Mitternacht zuerst die Zeitzone prüfen, bevor man die
  Aufzeichnung für falsch hält.
- [ ] **Speicherüberwachung fehlt — der Instanzausfall vom 2026-10-06 blieb unerklärbar.**
  `i-0d418eda09f69e79f` (`10.1.4.165`) wurde um **13:45:12** unerreichbar: SSM-Agent weg, ECS-Agent weg,
  Container antwortet nicht mehr. 14 × `504` am ALB zwischen 13:48 und 13:50 (`target_processing_time -1`,
  also gar keine Antwort), dann ersetzte ECS den Task mit `Task failed ELB health checks`. Die Instanz lief
  danach **ohne einen einzigen Task** weiter bei 99 % CPU und **~85.000 Lese-Ops/min bei dauerhaft voller
  I/O-Queue**, bis sie terminiert wurde. Der zweite Container des Service lief die ganze Zeit normal.
  **Ausgeschlossen:** die Egress-Umstellung desselben Tages (kein REJECT im Zeitraum), EFS (Durchsatz
  unberührt, Burst-Guthaben konstant), CPU-Drosselung (`unlimited`, Guthaben voll), Kernel-Fehler
  (Konsolen-Log endet 3 h vorher, kein OOM-Kill), GuardDuty (keine Findings), EBS-Burst (gp3).
  **Wahrscheinlich Page-Cache-Thrashing:** `t3.small` hat knapp 2 GB RAM und **keinerlei Swap** — im
  Boot-Log steht `zram0: system has too much memory (1913MB), limit is 800MB, ignoring`. Geht der Speicher
  aus, verwirft der Kernel den Page Cache und liest Programmcode unmittelbar wieder von der Platte: volle
  I/O-Queue, hohe CPU, **kein** OOM-Kill, und jeder Syscall kostet Page Faults. Das erklärt als einziges,
  warum SSM-Agent, ECS-Agent und Anwendung gleichzeitig verstummen.
  ⚠️ **Nicht beweisbar, weil EC2 keine Speichermetriken liefert.** Das ist die eigentliche Lücke: RAM ist
  der einzige Engpass, den wir nicht sehen. Ohne CloudWatch-Agent oder Container Insights steht man beim
  nächsten Mal vor denselben Daten. Erst Speicherüberwachung, dann entscheiden, ob Swap oder eine größere
  Instanzklasse.
  Auf zwei anderen Instanzen ist der Host-OOM belegt (2026-09-29/30, siehe `ecsservice` → „`TaskMemory`
  ist nur eine Reservierung“). Am 2026-10-05 lief auf `i-0d418eda09f69e79f` u. a. `tro-cur-web-p` mit
  418 MiB, bei 733 MiB verfügbar. Ob der Task am 06.10. noch dort lief, ist nicht geprüft. Bis ein Agent
  läuft, liefert eine Momentaufnahme per SSM die Daten: `free -m`, `docker stats --no-stream`,
  `journalctl -k | grep -i oom`.
  ⚠️ **Es fehlt außerdem ein Signal auf „ECS-Agent weg".** ECS liefert dafür keine Metrik, nur
  `agentConnected` in `describe-container-instances` — ein Alarm darauf bräuchte eine kleine Lambda. Heute
  hat zufällig der `EgressBlockedAlarm` die Rolle übernommen, weil das Connection Tracking der hängenden
  Instanz überlief. Darauf sollte man sich nicht verlassen.
  ⚠️ **Die ASG kann so eine Instanz nicht terminieren** — Managed Draining wartet auf den toten Agenten,
  der Aufruf meldet keinen Fehler und tut nichts. Direkt `ec2 terminate-instances` nehmen; Einzelheiten im
  README unter „Eine Instanz hängt".
- [x] **`1.7.13` ausgerollt 2026-10-07, beide Regionen (Paris zuerst): `SecretPaths` blockte legitime Dateien.** Gemeldet 2026-10-07 von `gwa.de` —
  jede Datei, deren Name mit `token`, `secret`, `credential`, `creds`, `passwd`, `apikey` oder `api_key`
  **begann**, bekam 403. Darunter WordPress' `token-list.min.js`, wodurch der Gutenberg-Editor einen Fehler
  warf. Gemessen über 14 Tage: 127 Treffer in Frankfurt, 6 in Paris. Ursache war `[a-z0-9._-]*` zwischen
  Schlüsselwort und Endung — es fraß Bindestriche und damit jedes Präfix.
  **Zwei Änderungen:** Trenner nur noch Punkt oder Unterstrich (ein Bindestrich unterscheidet
  Build-Artefakte von Konfigurationsdateien), und **`token`/`tokens` ganz aus der Liste** — entschieden
  2026-10-07: die Regel ist eine zusätzliche Schicht, keine Kontrolle, und solche Dateien gehören ohnehin
  nicht ins Webroot. Pluralformen mussten dafür ergänzt werden, sonst rutscht `secrets.json` durch.
  Geprüft gegen 13 Scanner- und 12 legitime Pfade aus den Logs: keine Lücke, kein Fehltreffer.
  **Vollständig nachgemessen 2026-10-07 in beiden Regionen**, nicht als Auszug. Frankfurt: alle 38
  `.js`-Pfade, alle 306 `.json`-Pfade, alle 362 `.php`/`.xml`/`.txt`-Pfade. Paris: alle 436
  browserrelevanten Pfade (`js json map xml txt php csv md`) von 5.950 insgesamt. **Kein einziger
  Fehltreffer außer der gemeldeten Klasse** — in Frankfurt hängen 195 der 306 `.json`-Pfade allein am
  Punkt-Muster, der Rest sind Scanner-Klassiker. Frei werden 117 Treffer plus die 137 aus dem `.js`-Satz,
  sämtlich `token*`.
  **Zwei Nachbesserungen:** `apikeys` und `secretkey` waren beim Straffen durchgerutscht (die alte
  Catch-all-Form hatte das Plural-s und das zusammengeschriebene `key` mitgefressen), beide als eigene
  Schlüsselwörter ergänzt.
  ⚠️ **Korrektur einer Fehleinschätzung von eben:** Ich hatte Muster 3 (`wp-config|appsettings|database|…`)
  „aus Symmetrie" ebenfalls gestrafft und das mit „kostet null Pfade" begründet — gemessen war das aber
  **nur an `.json`**. Gegen `.php` und `.txt` kostet es **467 Treffer in 14 Tagen**: `wp-config-sample.php`
  (171), `wp-configs.php` (162), `wp-config-backup.php` (24), `database2.php` (27), `secretkey.txt` (20).
  Das sind Rateversuche auf Sicherungskopien von Konfigurationsdateien — genau wofür die Regel da ist, und
  bei keinem davon gibt es einen gemessenen Fehltreffer. **Muster 3 bleibt beim Catch-all.**
  📌 Die Lehre: Eine Verschärfung an einer Endung messen und auf alle übertragen, ist derselbe Fehler wie
  nach Häufigkeit zu sortieren. Jede Musteränderung gegen **alle** betroffenen Endungen prüfen.
  ✅ **Freigabeliste endgültig und endungsunabhängig, Frankfurt** (2026-10-07): 288 Treffer auf 54 Pfaden,
  42 Dateinamen. Abgefragt wurde die Differenz selbst — trifft die alte Form von Muster 2, trifft die neue
  nicht — statt einzelner Endungen; Ausgabe auf den letzten Pfadabschnitt aggregiert, weil die volle Liste
  für die CloudShell zu lang war. Davon bleiben **17 Treffer geblockt** (14 über Muster 1 wegen der
  Endung: `token.sql .bak .old .save .swp .key .pem`; 3 über Muster 0, weil sie in einem Punkt-Verzeichnis
  liegen). **271 werden frei**, und zwar hälftig: **132 echte ausgelieferte Dateien** — neben
  `token-list.min.js` (129) auch `token-list.css`, `token-list.js` und `tokenlist.min.js`, also dieselbe
  Klasse, die wir ohne diese Abfrage übersehen hätten — gegen **rund 137 Treffer Scannerverkehr**, der
  erkennbar von **einer** Quelle stammt: `token.<endung>` mit je exakt 2 Treffern über dreißig Endungen.
  Zehn Scanner-Treffer pro Tag auf Dateien, die es bei uns nicht gibt, gegen vier kaputte Assets pro Tag.
  ✅ **Gesucht wurde auch nach *unbekannten* Fehltreffern, nicht nur nach der gemeldeten Klasse**
  (Frankfurt, 2026-10-07). Ergebnis: **keine weiteren**. Methode und zwei Irrwege dahin:
  ❌ *Nach Zahl der Quelladressen sortieren* — die Annahme war, ein kaputtes Asset werde von vielen
  Besuchern angefragt, ein Scanner komme aus wenigen Quellen. **Falsch, und zwar umgekehrt:** hinter
  Cloudflare erreichen echte Besucher den Origin über eine Handvoll Edge-Adressen, während die Scanner
  verteilt über Botnetze **direkt** kommen. `/.git/config` führte die Liste mit 704 Quellen an, der
  bekannte Fehltreffer stand nicht unter den ersten sechzig.
  ✅ *Nach dem `Referer` filtern* — ein nachgeladenes Asset trägt einen Referer auf eine **Unterseite
  desselben Hosts**, ein Scanner nicht. Allein reicht das nicht, Scanner senden durchaus einen Referer;
  erst drei Bedingungen zusammen trennen sauber: Referer enthält den angefragten Host **und** hat einen
  nichtleeren Pfad, Endung ist eine, die ein Browser oder ein Download anfragt, letztes Pfadsegment ist
  kein Dotfile. Damit schrumpfen 12.628 Pfade auf **20**, und der bekannte Fehltreffer steht mit 124
  Treffern von 34 Seiten auf Platz 1 — zehnmal so viel wie alles andere.
  Die übrigen 19 sind eine einzige Kampagne, erkennbar an den gleichförmigen Zahlen (16, 16, 14, 14,
  sechsmal 7) und daran, dass alle Pfade im **Wurzelverzeichnis** liegen.
  **Paris mit demselben Filter: 5 Kandidaten**, davon derselbe eine echte Fehltreffer (6 Treffer), der Rest
  je ein Scanner-Treffer. **Beide Regionen sind damit geprüft, es gibt keinen zweiten Fehltreffer.**
  📌 **Scanner-Signatur, neu gelernt:** Bei den drei Zweifelsfällen (`/credentials.js`,
  `/.vite/manifest.json`, `/dist/.vite/manifest.json`) ist der **Referer identisch mit der angefragten
  Adresse** — `/credentials.js` mit Referer `https://<host>/credentials.js`. Das macht kein Browser: ein
  Referer verweist auf die *einbindende Seite*, nie auf die Ressource selbst. Dazu Portvarianten `:8080`
  und `:8443` auf denselben Pfaden und vereinzelt `https://www.google.com/` als Referer. **Als viertes
  Kriterium in die Prüfung aufnehmen: Referer ≠ angefragte Adresse.**
  ⚠️ **Blinder Fleck:** Seiten mit strenger `Referrer-Policy` senden bei Unterressourcen keinen Pfad mit.
  Ein Fehltreffer kann durchrutschen. Das Verfahren ist gezielt, nicht vollständig.
  ✅ **Ausgerollt 2026-10-07**, Paris zuerst, danach Frankfurt. Keine Parameteränderung — die Parameter per
  `UsePreviousValue` übernommen (Paris 58). **In beiden Regionen gegen die ausgelieferte Regel geprüft**,
  nicht gegen das Template: Stack `UPDATE_COMPLETE`, Output `TemplateVersion` `1.7.13`, und per
  `get-regex-pattern-set` gegengelesen — Muster 2 trägt `secrets|secretkey|…|apikeys|api_keys` und kein
  `token` mehr, **Muster 3 unverändert** mit `[a-z0-9._-]*`. Die zweite Prüfung ist die wichtigere: wäre
  dort versehentlich die zwischenzeitlich gestraffte Form gelandet, wären `wp-config-sample.php` und
  `wp-config-backup.php` mit freigegeben worden — die 467 Treffer, die wir bewusst behalten.
  ⚠️ **Das Change Set zeigte acht Ressourcen, nicht eine** — siehe README unter „Die Fallen". Vier sind die
  WAF-Kette, vier kommen vom AMI. Beides erwartbar, aber es heißt: **eine Einzeilenänderung an diesem
  Stack ist nie ein Einzeilen-Deploy.** Change Set immer ansehen.
  📌 **`1.7.13` kann nur freigeben, nie zusätzlich blocken** — strukturell, weil jedes neue Schlüsselwort
  ein altes als Anfang hat (`secret` ⊂ `secrets`) und der neue Trenner eine Teilmenge des alten ist; gegen
  400.000 erzeugte Pfadvarianten ohne Gegenfall geprüft. Daraus folgt: das Update kann keine ausgelieferte
  Datei brechen, das Risiko liegt allein im aufgegebenen Schutz. Deshalb musste nicht jeder der 12.628
  geblockten Pfade angesehen werden, sondern nur die, die Muster 2 je getroffen hat.
  📌 **Paris hat ein anderes Scanner-Profil als Frankfurt** — 13.706 Treffer auf 5.950 Pfaden gegen
  81.877 auf 12.628. In Frankfurt dominiert die Konfigurationsjagd (`.json`, `.php`), in Paris die Suche
  nach **vergessenen Sicherungskopien**: `bak` 2.025, `old` 1.711, `save` 1.646, `swp` 1.634, dazu `tmp`,
  `orig`, `backup`, `original`, `local`, `dev`, `staging` — zusammen rund 10.000 der 13.706. `swp` ist die
  Vim-Auslagerungsdatei: gesucht wird, was ein abgestürzter Editor liegen gelassen hat. Browserrelevant
  sind in Paris nur 436 Pfade mit 1.376 Treffern.
  Von den freigegebenen `token*`-Pfaden sind zwei echte Dateien im Webroot (Test-Fixtures im `vendor/`
  eines WordPress-Plugins) — das gehört in der Server-Konfiguration gesperrt, nicht in der WAF.
  📌 **Scanner suchen inzwischen nach KI-Werkzeug-Zugangsdaten:** 17 Pfade, 196 Treffer in 14 Tagen —
  `/.claude/settings.json` (124), `/.anthropic/config.json` (45), dazu `.mcp.json`, `.windsurf/mcp.json`,
  `.openai/`, `.gemini-cli/`, `.langchain/`, `.vertexai/`. Das Punkt-Muster fängt sie alle.
  📌 Die `.well-known`-Ausnahme greift per `STARTS_WITH` nur am Apex. Zehn Treffer waren Nicht-Apex-Formen
  (`//.well-known/`, `/api/.well-known/jwks.json`); RFC 8615 kennt nur den Apex, bleibt also so.
  ⚠️ **Warum die Fehltreffer-Prüfung vom 2026-10-01 das übersah:** Sie sortierte nach Häufigkeit. Assets
  liegen hinter Cloudflares Cache und erreichen den Origin kaum — ein kaputtes Bundle erzeugt eine Handvoll
  Treffer pro Woche und landet weit unten. **Bei dieser Fehlerklasse nach Dateiendung sortieren.**
  ⚠️ **Zweiter Fehltreffer, bewusst nicht behoben:** Muster 0 (`(^|/)\.[a-z0-9_-]+`) blockt `/.map/*.js.map`
  — Source Maps einer Laravel-Anwendung, in Frankfurt Dutzende Dateien à 6 Treffer. Dasselbe Muster fängt
  `/.git/`, `/.aws/` und `/.ssh/`; Source Maps gehören nicht öffentlich ins Webroot, und der Ausfall trifft
  nur Entwickler mit offenen DevTools. Sauberer wäre, sie gar nicht erst auszuliefern.
  ⚠️ Ich hatte diese Dateien am 2026-10-01 zunächst richtig als echte Build-Artefakte erkannt und zwei
  Nachrichten später als Scanner eingestuft. Beim nächsten Mal die erste Einschätzung belegen, nicht
  verwerfen.
- [ ] **`.well-known`-Ausnahme auf die Standardnamen verengen.** Muster 0 blockt jedes Punkt-Segment,
  deshalb hängt an `SecretPaths` ein `NotStatement` mit `STARTS_WITH /.well-known/` — sonst scheitert die
  ACME-Validierung. Die Ausnahme ist aber pauschal: **alles** unter `.well-known` ist von der Regel
  befreit. Angreifer kennen das — in Frankfurt gemessen (14 Tage): `…/.well-known/gecko-litespeed.php`,
  `…/.well-known/content.php`, `…/.well-known/pki-validation/index.php`, dazu `.well-knownold/cookie.php`
  und `.well-known.php`. Die Versuche wurden nur deshalb geblockt, weil sie mit Projektpräfix oder
  Doppelslash kamen und die Ausnahme am Apex greift; `/.well-known/shell.php` ginge durch. Das Verzeichnis
  ist attraktiv, weil es öffentlich lesbar ist, vom ACME-Client **beschreibbar** und praktisch überall
  freigestellt. **Vorschlag:** Ausnahme von „alles darunter" auf die benötigten Namen umstellen —
  `acme-challenge/`, `security.txt`, `assetlinks.json`, `apple-app-site-association`,
  `openid-configuration`, `jwks.json`, `change-password`, `gpc.json`, `mta-sts.txt`. Umsetzung als zweites
  RegexPatternSet im `NotStatement` statt der `ByteMatchStatement`; der WAF-Dialekt kennt keine Lookaheads,
  die Ausnahme kann also nicht ins Muster selbst. Vorher messen, ob wir unter `.well-known` legitime Pfade
  ausliefern, die nicht auf der Liste stehen.
- [ ] **Cloudflare lässt sich umgehen — der ALB nimmt Anfragen von überall an.** Gefunden 2026-10-07
  beim Nachgehen eines Scanners. Die meisten Anfragen auf unsere Hosts kommen mit Cloudflare-Quelladressen,
  fünf Adressen außerhalb dieser Bereiche haben aber `curatime.org`, `tron-mainz.de` und
  `atlas-phdprogram.com` mit korrektem Host-Header **direkt** erreicht. Wer die Adresse des Load Balancers
  kennt, umgeht damit alles, was Cloudflare vorgelagert leistet — Ratenbegrenzung, Bot-Erkennung,
  IP-Reputation. Bestätigt wird das durch die Host-Verteilung: 37 % aller `SecretPaths`-Blocks in
  Frankfurt tragen gar keinen Vhost, sondern die ALB-DNS-Adresse, den Global-Accelerator-Endpunkt oder
  eine rohe IP. **Zu klären:** Soll Cloudflare Teil der Schutzschicht sein? Falls ja, gehört eine
  WAF-Regel davor, die Anfragen ohne Cloudflare-Herkunft ablehnt (Cloudflare veröffentlicht seine
  IP-Bereiche, dazu `IPSet` plus `NotStatement`). Falls nein, ist das kein Befund, sondern eine
  Feststellung — dann darf sich aber niemand auf Cloudflare als Schutz verlassen.
- [ ] **Schwachstellenscanner sammelte zehn Tage lang ungehindert Plugin-Versionen.** User-Agent
  `CMS-Security-Auditor/1.0 (+authorized self-check; contact: local-admin)` — die Kontaktangabe ist keine
  erreichbare Adresse, das Werkzeug ist uns nicht bekannt. 133 Anfragen zwischen 2026-09-23 und
  2026-10-03 auf sechs Hosts, davon **sechs geblockt** (alle `/xmlrpc.php`, WordPress-Regelsatz), der Rest
  durchgelassen. Ablauf in vier Stufen: `wp-includes/version.php` für die Kernversion, dann die
  `readme.txt` von sechs Plugins für deren Versionen, dann fünfzehn Varianten von Anmeldepfaden,
  schließlich `/wp-json/` und ein **POST** auf `/wp-json/batch/v1`. Die abgefragten Plugins sind nicht
  zufällig gewählt: darunter zwei mit bekannten, massenhaft ausgenutzten Lücken ohne Anmeldung. So
  bestätigt ein Exploit-Kit vor dem Zuschlagen die Version. Zeitlich in Schüben von 4–8 Sekunden, eine
  Quelle über 6,5 Stunden — automatisiert.
  **Gegen die ALB-Logs geprüft (Athena, `default.alb_access_logs`, nach `day` partitioniert):** Die
  Erkundung ist weitgehend ins Leere gelaufen — **alle** sechs `readme.txt` und `wp-includes/version.php`
  kamen mit 404 zurück (und zwar mit der WordPress-eigenen 404-Seite, die Anfrage lief also bis zur
  Anwendung durch und die Datei war schlicht nicht da). `xmlrpc.php` 403 oder 404, `POST wp-json/batch/v1`
  403 von der Anwendung. Weder Kern- noch Plugin-Versionen sind abgeflossen.
  ⚠️ **Eine Sache hat funktioniert, und es ist die aussagekräftigste:** `/wp-json/` beziehungsweise
  `?rest_route=/` lieferte **sechsmal 200 mit je 407 kB**, zusammen gut 2,5 MB. Das ist der vollständige
  Index der REST-Schnittstelle: jedes Plugin, das eine Route registriert, steht darin namentlich. Das ist
  die Bestandsliste, nach der das `readme.txt`-Raten gesucht hat — nur vollständig und zuverlässig.
  Dazu zwei kleinere Funde: auf einem Host antwortete `wp-login.php` mit 200, auf einem anderen fand der
  Scanner nach fünfzehn Rateversuchen einen Anmeldepunkt mit 200.
  **Zu tun, projektseitig, nicht in der WAF:** nicht benötigte REST-Namensräume abmelden und
  `wp/v2/users` für Unangemeldete schließen — das ist der Pfad, über den aus dem Routenbaum eine
  Benutzerliste wird, und der nächste Schritt gewesen wäre. `readme.txt` unter `wp-content/plugins/`
  gehört ebenfalls gesperrt, auch wenn es hier zufällig nichts gab.
  📌 Methodisch: WAF-Logs beantworten „was wurde angefragt", ALB-Logs „was kam zurück". Für die Frage, ob
  etwas abgeflossen ist, braucht es **beide** — `elb_status_code`, `target_status_code` und `sent_bytes`
  stehen nur in den ALB-Logs. Ein `-` in `target_status_code` heißt, die WAF hat abgewiesen, bevor die
  Anwendung gefragt wurde.
- [ ] **Alarme von `dashboard` auf `alert` heben** — je Alarm, anhand des gemessenen Volumens, nicht als eine
  Entscheidung für alle.
- [ ] **Aurora auf `db.t4g.medium`** — entschieden 2026-09-29. Gleiche 4 GiB und gleiche ~145 Verbindungen
  wie `db.t3.medium`, aber **8,03 USD/Monat billiger** und mit Performance Insights, das `db.t3.medium` bei
  Aurora nicht unterstützt (gegen das Konto geprüft, nicht aus der Doku). `t4g` ist die neuere Generation
  auf Graviton, kein kleinerer Typ; der ARM-Vorbehalt greift nicht, weil auf einer Datenbankinstanz kein
  Code von uns läuft. Das Verbindungsbudget löst der Wechsel **nicht** — dafür bräuchte es die r-Klasse.
  ⚠️ `RdsInstanceType` hat `AllowedValues: ["db.t3.medium"]`, also erst eine Template-Änderung. Und mit
  einem einzigen Writer ohne Reader ist der Klassenwechsel ein **Neustart der einzigen Instanz**, kein
  Failover — alle ~20 Services verlieren die Datenbank gleichzeitig. Weg drumherum: Reader auf der
  Zielklasse anlegen, Sync abwarten, **failover** (~30 s), alten Writer umstellen, Reader wieder entfernen.
  Alles, was einen Neustart will, in dasselbe Fenster. Paris zuerst.
- [ ] **Den `EngineVersion`-Widerspruch auflösen.** Das Template nagelt eine Version fest *und* setzt
  `AutoMinorVersionUpgrade: true`. RDS zieht davon, und das nächste Update, das irgendeine RDS-Eigenschaft
  anfasst, scheitert.
- [ ] **Den Origin-Verify-Header auf den Listener-Regeln erzwingen.** `cloudfront-alb-distribution` sendet
  ihn bereits, nur geprüft wird er nirgends.
- [ ] **Anmeldeendpunkte schützen.** Ein POST mit falschem Passwort ist wohlgeformt, also greift keine
  Signaturgruppe, und 2.000 pro IP in fünf Minuten erlauben immer noch 300 Versuche je Minute. Ein
  Metric Filter auf fehlgeschlagene Anmeldungen je Service-Log-Gruppe zählt, was kein Rate Limit misst.
  Belegt bei GWA: 50–140 Versuche/h über Tage, verteilt, dazu
  `xmlrpc.php` als Verstärker. Cloudflare-Regeln 22.09. (Challenge + Block) brachten es binnen 16 h auf
  null, bei einer durchgelassenen echten Anmeldung — wirksam, aber nur solange die Domain proxied ist.
- [ ] **AMI-Auflösung zur Startzeit und geplanter Instanz-Refresh.** Nichts ersetzt eine laufende Instanz,
  die Hosts driften also unbegrenzt. `dnf-automatic` läuft mit `upgrade_type = security` und
  `apply_updates = yes`, aber `reboot` ist ungesetzt und damit `never` — Kernel- und glibc-Patches werden
  **installiert und nie aktiv**. Die ASG hat keine `UpdatePolicy`, keinen Refresh, und ein neues AMI
  erreicht nur neu gestartete Instanzen. Der Blocker für einen geplanten Refresh: `{{resolve:ssm:…}}` ist
  eine *CloudFormation*-Referenz und backt ein festes AMI in die Launch Template, ein Refresh würde also
  dasselbe Image neu starten. Es muss `{"Fn::Sub": "resolve:ssm:${AmiSsmParameter}"}` werden.
  Belegt am 2026-09-27: das `1.7.6`-Update erzeugte eine neue Launch-Template-Version mit frischem
  ECS-AMI — ausgerollt wird sie von niemandem.
  **Zielbild, in dieser Reihenfolge:**
  1. `resolve:ssm:` statt `{{resolve:ssm:}}`, zeigend auf einen **eigenen** Parameter `/labor/ecs-ami/current`
     — gleicher Name je Region, unterschiedlicher Inhalt. Nebeneffekt: die Launch-Template-Kaskade bei
     jedem Stack-Update entfällt.
  2. Lambda, täglich: `get-parameter-history` auf den AWS-Parameter liefert je Version die
     `LastModifiedDate`. Paris bekommt die neueste Empfehlung, Frankfurt die neueste, die ≥7 Tage alt ist
     **und die Paris nachweislich fährt** — sonst ist der Vorlauf wertlos, wenn Paris den Refresh
     nicht geschafft hat. Ändert sich nichts, passiert nichts.
  ✅ `ManagedDraining` ist `ENABLED` (geprüft 2026-09-28) — ein Refresh drainiert die Tasks, statt sie
  mitzureißen. `ManagedTerminationProtection: DISABLED` betrifft nur das Scale-in, nicht den Refresh.
  ⚠️ ASG steht auf `HealthCheckType: EC2`, nicht `ELB`. Eine Instanz gilt als gesund, sobald EC2 sie
  hochgefahren hat — vor ECS-Platzierung und Target-Group-Health. Refresh braucht `InstanceWarmup` und
  `MinHealthyPercentage` ~90, sonst rollt er schneller als die Tasks nachkommen.
  ⚠️ Ein Refresh aktualisiert **keine** Container-Images — Tasks bleiben im bestehenden Deployment mit
  festem Digest; es braucht `update-service --force-new-deployment` dazu.
- [ ] **OTLP-Endpunkt auf 443 legen.** `4318` ist die schwächste der Egress-Regeln — ein `/32` auf einen
  fremden SaaS-Host (`fly-otel-collector-prod.fly.dev`), dessen Adresse niemand zusichert. Zieht er um,
  bricht die Telemetrie still. Auf 443 entfällt die Regel ganz.
- [ ] **Loses Ende: VPC-interner `4318`-Verkehr.** `10.1.4.186 → 10.1.1.76`, `10.1.3.59 → 10.1.2.21`,
  `10.1.4.228 → 10.1.2.51`. Nie verfolgt, wer dort was an wen sendet.
- [ ] **Gateway-VPC-Endpoint für S3.** Die Ersparnis ist klein; der Punkt ist, dass Egress-Regeln danach
  auf die verwaltete S3-Prefix-Liste zeigen können statt auf `443 → 0.0.0.0/0`.
- [ ] **`443` mit Interface-VPC-Endpoints verengen** — ECR, SSM, Logs, ECS, Secrets Manager. ~100–130
  USD/Monat über zwei AZs. Vorher den AWS-Anteil an `443` messen; die Egress-Analyse beantwortet das.
- [ ] **Prüfskript für Regelbeschreibungen in den Ablauf nehmen** — Zeichensatz und Länge, für jede
  `SecurityGroupEgress`/`Ingress`-Description in allen Templates. cfn-lint fängt beides nicht, und der
  Fehler zeigt sich erst beim Deployment des betroffenen `Fn::If`-Zweigs.
- [ ] **Die 110 überflüssigen `DependsOn`-Einträge entfernen** (`cfn-lint` `W3005`: 88 + 13 + 9). Eigener
  Commit, keine andere Änderung. **Jeden einzeln prüfen** — eine Reihenfolge, die aus einem Grund außerhalb
  des Eigenschaftsgraphen existiert, muss bleiben.
- [ ] **`RdsMasterPassword` als `NoEcho`-Parameter** (`W1011`) — `{{resolve:secretsmanager:…}}` hält es aus
  dem Parametersatz des Stacks heraus. Kleiner als IAM-Datenbankauthentifizierung und davon unabhängig.
- [ ] **Zwei `cfn-lint`-Funde in `ecscluster-ext-additional-cluster`:** `W2506` (`ImageId` als einfacher
  `String`) und `W3697` (ein Ressourcentyp im Wartungsmodus).
- [ ] **Fehlende Metrik-Widgets, ganz ohne Lambda:** gezählte WAF-Anfragen je Regelgruppe, ALB
  `HTTPCode_ELB_5XX_Count` neben `HTTPCode_Target_5XX_Count`, laufende gegen gewünschte Tasks je Service.
- [ ] **EFS-Lebenszyklusregel** — alles bleibt unbegrenzt in Standard.
- [ ] **`BackupRole` hat keinen Wiederherstellungspfad.** Die Sicherung läuft, die Wiederherstellung ist
  nirgends ausgedrückt — entscheiden, welche es sein soll.
- [ ] **DNS-Firewall: die Allow-Regel in eine vertraute und eine geprüfte Liste teilen.** Eine Regelgruppe
  kann mehrere Regeln tragen, jede mit eigener Liste und eigener Redirection-Einstellung. Auslöser wäre ein
  konkreter Eintrag, dessen Kette jemand nicht vertrauen will — derzeit qualifiziert sich keiner.

## `ecsservice`

- [ ] **Beim `ecsservice`-Rollout auf `1.7.0`:** jeden `*AlarmAction` **explizit mitgeben**. Parameter, die
  in einer Version neu sind, haben keinen vorherigen Wert — es greift der Template-Default, und der
  schaltet Alarme stumm, die bisher gemeldet haben.
- [ ] **Vor dem Rollout die Images prüfen** — nicht nur ob sie existieren: den aufgelösten `imageDigest`
  jedes laufenden Tasks gegen den Digest halten, auf den sein Tag **heute** zeigt. Ein Deployment hält den
  Digest, den es beim Anlegen aufgelöst hat; ein seither verschobener Tag zeigt auf ein Image, das
  unsichtbar bleibt, solange der Task läuft, und den nächsten Start mit `CannotPullContainerError` bricht.
- [ ] **`ServiceHighMemoryAlarm` prüft `Average` und meldet einen einzelnen überlaufenden Task nicht.**
  Bei drei Tasks müsste der kranke 171 % erreichen; dazu `TreatMissingData: notBreaching`. Zweiter Alarm
  auf `Maximum`, Schwelle **120** — gemessen bleiben 17 der 19 Services unter 111.
- [ ] **`TaskMemory` ist nur eine Reservierung — Tasks überbuchen den Host, und der Host-OOM-Killer trifft
  die Nachbarn.** `MemoryReservation` ohne hartes `Memory`: ECS platziert Tasks nach diesem Wert, der
  Container wächst aber ungebremst darüber hinaus. `MemoryUtilization` rechnet gegen die Reservierung,
  daher die Werte über 100 %.
  **Belegt 2026-10-05 in Frankfurt:** `global_oom` auf `i-0673644cbbe519ff2` (2026-09-29 23:07 UTC) und auf
  `i-0caa4daf4967b7208` (2026-09-30 16:37 UTC). Getötet wurden `apache2`-Worker mit je ~45 MB eigenem und
  ~55 MB geteiltem Speicher. Beide Male endeten zur selben Sekunde hängende Anfragen von `tro-cur-web-p`,
  einmal ein `warmCache` nach 36 Minuten. Am 2026-09-30 endeten außerdem 17 Scanner-Anfragen und
  `/sitemap.xml` in derselben Millisekunde nach 70 Minuten. So sieht eine Instanz aus, die schon vor dem
  Kill stand, wie am 2026-10-06 (siehe „Speicherüberwachung fehlt“).
  Die tro-Tasks belegten 260–420 MiB gegen 478 reservierte, einzelne Tasks bis ~860 MiB. Am 2026-10-05 um
  04:28 sind bei `tro-cur-web-p` zwei Tasks auf derselben Instanz gleichzeitig an den Health Checks
  gescheitert.
  **Seit 2026-10-05 ~10:10 UTC in Frankfurt:** `tro-{tro,cur,atl}-web-p` auf `TaskMemory=956`,
  `ServiceDesiredCount` von 3 auf 2. Die Reservierung je Service steigt damit von 1.434 auf 1.912 MiB. Der
  Verbrauch in MiB hat sich nicht verändert, der Alarm greift jetzt erst bei 765 MiB. Je zwei tro-Tasks
  füllen eine Instanz damit vollständig. Die Nächte danach sind noch nicht ausgewertet. Mit 2 statt 3 Tasks
  kann die Nachtspitze je Task höher liegen als die bisherigen ~630 MiB.
  **Offen:** ein hartes `Memory`-Limit als Parameter. Dann trifft der OOM-Killer den verursachenden
  Container statt eines Nachbarn, um den Preis eines Neustarts dieses Tasks.
- [ ] **`tro-atl-web-p` liefert Videos über Apache aus.** Gemessen 2026-10-06: einzelne Range-Requests
  mit **47 MB**, dazu Bilder mit 400–600 KB, alles über HTTPS — jedes Byte verschlüsselt Apache selbst.
  Dazu bei **jedem** Seitenaufruf `Static cache loaded … your server rewrite rules have not been set up
  correctly`: Statamics statischer Cache wird über PHP ausgeliefert statt direkt vom Webserver, das volle
  Framework läuft also auch für gecachte Seiten. Gehört auf S3 hinter CloudFront.
  Nicht die Ursache des Ausfalls vom selben Tag — die Videos wurden zügig bedient —, aber dauerhafte Last
  auf einer Instanz mit 2 GB RAM.
- [ ] **`spo-por-por-p` holt beim Rendern eine tote Domain.** `GametableCell` zieht über
  `Sportleagues.tableurl` fremdes HTML und parst es mit simple_html_dom — synchron, ohne Cache, ohne
  erkennbaren Timeout, **eine DNS-Abfrage und ein HTTP-Aufruf pro Seitenaufruf**. Das Ziel
  `www.baseball-bundesliga.de` antwortet seit Langem nur mit `301 → https://www.baseball.de`. Gemessen
  2026-10-05: 144 Verbindungen in 7 Tagen von drei Instanzen, ~420 Byte je Aufruf. Daher die Dauerwarnung
  `Attempt to read property "outertext" on null`. **Ursache des Ausfalls vom 2026-09-26:** ~50
  gleichzeitige Anfragen auf `/` standen 10–17 s bei 2 % CPU, alle wartend auf denselben Fremdabruf.
  Zu tun: URL auf `baseball.de` ziehen, Parsing anpassen, Timeout und Cache setzen. Anwendungsseite.
  🔴 **Verschlimmert den Egress-Umstieg.** Security Groups verwerfen Pakete stillschweigend — kein RST.
  Ein geblocktes SYN heißt für den Client nicht „abgelehnt", sondern „keine Antwort", und er wartet bis
  zum Connect-Timeout. Aus einem schnellen 301 würde ein hängender PHP-Prozess: derselbe Mechanismus wie
  am 26.09., nur mit längerer Wartezeit. Deshalb bekommt Frankfurt zunächst eine `/32`-Regel auf Port 80,
  die den heutigen Zustand exakt hält. **Sie fällt weg, sobald dieser Punkt erledigt ist** — solange sie
  steht, belegt eine tote Domain einen der vier `EgressExtraRules`-Plätze.
- [ ] **`EvaluationPeriods` ist bei allen Service-Alarmen fest auf `1`.** Ein einzelner Ausschlag meldet
  also sofort — bei `gwa-gut-sol-s` feuerte früher jeder Solr-Neustart, 29 % Minutenmittel gegen eine
  Schwelle von 20. Tritt aktuell nicht mehr auf, der Mangel bleibt. Per Stack behelfsmäßig über
  `ServiceHighCpuThreshold`, sauber wäre `EvaluationPeriods: 2` als Parameter.
- [ ] **Den `ImageResolver` härten.** Bei einem Update nach fehlgeschlagenem Create existiert der Service
  nicht mehr und die Lambda scheitert hart. Existiert er, wurde aber nie gesund, wird das kaputte Image bei
  jedem Update wiederbelebt.
- [ ] **Einen echten Default für die Breite des 4xx-Anomaliebands setzen.** Derzeit geraten; die Metrik
  aufzeichnen und daraus wählen.
- [ ] **Anomalieerkennung auf dem Netzwerk** — `NetworkIn`/`NetworkOut`-Alarme mit eigenen Parametern.

## `ecscluster-vpc-rds-asg/guardduty`

- [ ] **Quarantäne-Pfad prüfen, dann `quarantine` scharf schalten.** Beispiel-Findings testen ihn **nicht**
  — sie tragen die Platzhalter-ID `i-99999999`, `modify_instance_attribute` läuft nie, das IAM-Recht ist
  also ungeprüft. Dafür die Lambda direkt mit einem selbstgebauten Ereignis aufrufen (`severity: 8`,
  `resourceType: Instance`, echte ID) gegen eine **entbehrliche Instanz in Paris**. Vorher die vier
  Security Groups sichern, danach zurücksetzen und die Marker `Quarantined`/`QuarantinedAt` entfernen.
  Die Instanz kommt nicht von allein zurück: der ECS-Agent ist abgerissen und registriert sich erst neu,
  wenn er wieder verbinden kann.
  Danach ein paar Wochen in `notify` mitlesen, was GuardDuty in diesen Konten überhaupt meldet — dann
  Paris auf `quarantine`, Frankfurt später.
- [ ] **Interface-Endpoint für SSM** (steht schon bei den VPC-Endpoints) macht die Quarantäne erst
  untersuchbar. Heute kappt sie auch den SSM-Agenten mit, Forensik geht dann nur über einen EBS-Snapshot.
- [ ] **`EBS_MALWARE_PROTECTION` über das Template,** nicht über die Konsole. Nur EBS; EFS ist nie erfasst.
- [ ] **Runtime Monitoring bewerten** (`RUNTIME_MONITORING` steht auf `DISABLED`) — das Einzige, das
  aufzeichnet, was innerhalb eines Containers passiert.

## Übrige Templates

- [ ] **`chatbot-slack` existiert nicht.** Die Slack-Zustellung ist nicht umgesetzt, und ein
  `https`-Abonnement auf einen Slack-Webhook funktioniert nicht.
- [ ] **`efs-access` existiert nicht** — entworfen, nie geschrieben. Ein Wegwerf-Stack, um Daten vom EFS zu
  holen.

## Außerhalb der Templates

- [ ] **Pipeline darf einen vorhandenen Image-Tag nicht mit anderem Inhalt überschreiben.** Ursache der
  Curatime/Atlas-Ausfälle: `build-docker-and-push-ecr.sh` Z. 50–52 pusht ohne Prüfung und verschiebt
  `latest` mit; zwei Builds sind nie digestgleich. Vier Pipelines in `app`, zwei im Email Generator.
- [ ] **tro-Seiten: Sitemap und Cache-Warmer rufen die kaputten `localede`-URLs selbst auf** — kein
  Crawler, wie dieser Eintrag bis 2026-10-05 annahm. Gemessen 2026-10-05 in Frankfurt über die
  Service-Log-Gruppen. Das Access-Log hat das Feld `%D` (µs) vor der Anfragezeile, aber weder Client-IP noch
  Host noch User-Agent.
  - **`tro-tro-web-p`:** Die Sitemap führt **alle 289** deutschen Publikationen unter
    `/de/localede/veroffentlichungen/…`. Bis 2026-09-29 liefen diese Aufrufe in ein 30-s-Timeout (`503`,
    ~700 je 3 h, ~510 Worker-Minuten je 3 h). Das war der 98-%-Anteil an den Target-5xx des Clusters.
    Seit dem Deploy am 2026-09-30 antworten sie mit **`200` in ~2,7 s**. Der Hänger ist also weg, aber der
    Cache wird für die falschen Adressen gefüllt, und jede Publikation existiert doppelt.
  - **Jede Nacht um 22:00 UTC** leert `/_jobs/invalidateDaily` den Cache. Danach baut ein einzelner
    `/_jobs/warmCache` 9 Minuten lang alles neu auf. Folgeaufrufe bekommen `409`, die Sperre greift. Am
    2026-10-04 stieg dabei der höchste Task von 88 auf **132 %** (≈ 630 MiB) und fiel ab 22:10 wieder.
    Diese Spitze kommt vom Neuaufbau selbst. Eine korrigierte Sitemap allein senkt sie nicht, wenn danach
    289 richtige statt 289 falscher URLs gewärmt werden.
  - **`tro-cur-web-p`:** `warmCache` läuft jede Minute und ruft dabei **sechs tote URLs parallel** auf
    (`/en/publications/id<uuid>`, `/localede/veroeffentlichungen/id<uuid>`), jede mit `404`, voll
    gerendert, ~2 s und 225 KB. Zusammen sind das **74 % der Worker-Zeit** des Service. Ein 404 wird nicht
    gecacht, deshalb rendert der Warmer dieselben sechs Seiten jede Minute neu.
  - **`tro-tro-web-p`:** `/en/site.webmanifest` liefert jede Minute `500`. Das ist die eine 5xx-Antwort je
    `warmCache`-Lauf.
  - **404 rendert das volle Layout.** Bei `tro-cur` ist sie die schwerste Seite überhaupt (225 KB, 2,6 s
    gegen 93 KB, 1,4 s bei `200`). Scanner bekommen jedes Mal die ganze Seite, bei `tro-tro` z. B.
    `/wordpress` 9.263× pro Woche.

  **Zu tun, Anwendung:** Link-Erzeugung korrigieren. `localede` sieht nach einem nicht aufgelösten
  Locale-Schlüssel aus, `id<uuid>` nach Einträgen ohne Slug oder gelöschten Einträgen. Der Warmer darf keine
  404 wärmen und gehört als `artisan`-Befehl in die CLI statt in einen Apache-Worker, der den Speicher danach
  behält. `invalidateDaily` durch gezielte Invalidierung ersetzen. Die 404-Seite statisch ausliefern.
  **Überbrückung, Infrastruktur:** `fixed-response` 404 auf die toten Pfade. Kein Template kann das heute,
  `alb-ecsservice-rule` und `alb-redirect-rule` kennen nur `forward` und `redirect`.
  ⚠️ **Staging kann den Fix nicht zeigen.** In Paris laufen weder der minütliche Warmer noch
  `invalidateDaily`. In 30 Tagen gab es dort keinen einzigen `localede`-Aufruf, und der Fix-Kandidat vom
  2026-09-29 ist dort nie unter Last gelaufen. Prüfen lässt er sich über die Staging-Sitemap
  (`grep -c localede`), indem man `invalidateDaily` und `warmCache` dort von Hand auslöst, oder erst in der
  ersten Prod-Nacht nach dem Deploy.
  ℹ️ **Gegenprobe aus EasyCron (nur Fehlerprotokoll, 20 Einträge, 07.10. 00:02 – 09.10. 00:03 CEST):**
  vier 504er, jeder mit zwei bis sieben Folge-409ern. Laufzeiten der 504er: **60,37 / 60,38 / 60,54 /
  60,57 s** — mechanischer ALB-Timeout ohne Streuung, keine Lastabhängigkeit. Der vom `09.10. 00:00:03
  CEST` entspricht `08.10. 22:00:03 UTC` und deckt sich auf die Sekunde mit dem ALB-Protokoll; die
  409-Kaskade bis `00:03 CEST` deckt sich mit den verworfenen Antwortpaketen um `22:02:59–22:03:58 UTC`.
  ⚠️ **Zwei der vier liegen nicht bei Mitternacht:** `08.10. 20:58` und `21:59 CEST` (18:58 / 19:59 UTC),
  passend zu den `TargetResponseTime`-Spitzen derselben Stunden. **Die `invalidateDaily`-Kollision erklärt
  also nur einen Teil** — auffällig ist, dass alle drei Zeiten kurz vor oder zur vollen Stunde liegen.
  Beim Team erfragen, ob es neben `invalidateDaily` noch etwas Stündliches gibt.
  ✅ **Erfolgsquote nachgereicht (EasyCron-Jobübersicht):** `EPDs 1.440`, `TS 12.533`, `TF 82`, `CF 0`.
  Fehlerquote **0,65 %**, Zählhistorie rund **8,8 Tage**, also ~9 Fehler am Tag — davon nach der Verteilung
  der Stichprobe etwa **zwei echte Timeouts**, der Rest die nachfolgende 409-Sperre. Keine Fehlerserie.
  📌 **Das ordnet die Dringlichkeit neu:** Empfänger des 504 ist EasyCron, kein Besucher — **direkter
  Nutzerschaden: keiner**. Zweimal täglich bleibt ein Teil des Caches ungewärmt; wer dann eine kalte Seite
  trifft, wartet etwas länger. Im Vergleich der drei tro-Befunde nach Volumen:
  `site.webmanifest` → **1.440 × 500** am Tag à 7,8 KB (~11 MB), Crawler auf `localede` → **~190 × 404**
  à 113 KB (~22 MB), `warmCache`-Timeout → **~2** am Tag. Der Timeout ist der kleinste der drei; er war nur
  der auffälligste, weil er eine Spur bis in die Flow Logs gezogen hat.
  ➡️ Wer eine Stunde hat, nimmt die Manifest-Datei, nicht die Umstellung des Warmers. Letztere bleibt
  richtig, löst aber vor allem Struktur- und keine Volumenprobleme.
  ℹ️ Taktung passt nicht zur Laufzeit: Warmer **jede Minute**, vollständiger Neuaufbau **neun Minuten**.
  Nach jeder Invalidierung ist Überlappung garantiert, daher die 409-Sperre.
  ℹ️ Diese Fehler sind seit Tagen in EasyCron sichtbar — eine Meldestelle, die in keiner unserer
  Überwachungen auftaucht. Dasselbe Muster wie beim EFS-Alarm am 02.10.: gemeldet, aber dort, wo niemand
  den Zusammenhang herstellt.
  ✅ **Die Link-Erzeugung ist korrigiert — nachgemessen am 2026-10-09.** `sitemap.xml` von `tron-mainz.de`
  liefert **0** Treffer auf `localede` (vorher alle 289 Publikationen). In den Service-Log-Gruppen der
  tro-Dienste fällt die Zahl der `localede`-Aufrufe entsprechend:
  `03.–06.10. je ~5.900` → `07.10. 2.532` → `08.10. 248` → `09.10. 190`. Rückgang **97 %**.
  Sitemap und Warmer erzeugen die kaputten URLs also nicht mehr selbst.
  ⚠️ **Was bleibt, sind Suchmaschinen.** ~190–250 Aufrufe am Tag von Crawlern, die die Adressen indexiert
  haben, solange die Sitemap sie auslieferte. Belegt im ALB-Protokoll vom 08.10. um 22:02:47: `bingbot`
  auf `/de/localede/veroffentlichungen/…` → **404 mit 113.656 Byte**. Bei 190 am Tag rund 21 MB und ~8
  Minuten Worker-Zeit täglich für Seiten, die es nicht gibt.
  ➡️ Ein 404 ist für Crawler ein schwaches Signal, das klingt über Monate ab. Schneller geht es mit einer
  Route, die `localede/` aus dem Pfad entfernt und per **301** auf die richtige URL verweist — beendet die
  Renderings sofort und räumt den Index auf. **Der ALB kann das nicht:** `alb-redirect-rule` kennt nur
  feste Ziele und `#{path}`, kein Entfernen eines Pfadsegments. Überbrückung bleibt die statische 404-Seite.
  ✅ **Nachgemessen am 2026-10-09, drei Ergänzungen — zwei davon ändern die Diagnose.**
  **Der Speicher ist als Ursache raus.** `MemoryUtilization` von `tro-tro-web-p-Service` lag am 05.10. bis
  11:00 bei 79–87 %, seit der `TaskMemory`-Anhebung auf 956 stabil zwischen **32 und 52 %**, über vier Tage
  ohne Aufwärtstrend. Die 132-%-Spitze aus diesem Eintrag stammt vom 04.10., also von **vor** der Anhebung.
  Die langsamen Warmläufe sind trotzdem geblieben (`TargetResponseTime` max: 06.10. 22:00 → 32,9 s,
  07.10. 22:00 → 27,6 s, 08.10. 19:00 → 24,3 s). Das Treppensteigen ist weg, das Zeitproblem nicht.
  **Der 500er ist kein Einzelposten, sondern eine Grundlinie.** `HTTPCode_Target_5XX_Count` für die
  Zielgruppe: **konstant 60,0 pro Stunde vom 05.10. bis 09.10.**, also ~1.440 am Tag, ~5.800 im Fenster.
  ⚠️ Damit lässt sich auf dieser Metrik für den Dienst **kein Alarm setzen** — ein echter Ausfall mit
  hundert Fehlern bliebe im Rauschen. Derselbe Mechanismus wie beim Egress-Rauschen und bei
  `ec2.internal`: ein dauerhaft harmlos aussehender Zustand macht die Erkennung des Ernstfalls unbrauchbar.
  Nach dem Fix ist ein Target-5XX-Alarm für die Zielgruppe überhaupt erst sinnvoll.
  **Die Egress-REJECTs mit Nutzlast gehören hierher.** Belegt am 08.10.: `22:00:03.557` wird `warmCache`
  erzeugt, `22:01:03.568` meldet der ALB **504** mit `target_processing_time = -1` — exakt 60 Sekunden,
  der Idle-Timeout. Um `22:02:59` schickt das Backend die fertige Antwort (11 Pakete, 10.470 Byte) in die
  längst geschlossene Verbindung; die Docker-NAT-Abbildung ist weg, das Paket verlässt die Instanz mit
  Quellport **443** statt des gemappten Host-Ports, und `SgEgress` verwirft es. Zwei Wiederholungen, dann
  Schluss. **Der Nutzer hatte sein 504 schon anderthalb Minuten vorher** — die verworfenen Pakete sind
  Folge, nicht Ursache. Sie sind damit ein indirekter Melder für Anfragen über 60 s.
  ⚠️ **Zwei Messfallen, beide heute getreten:** `TargetResponseTime` zählt Anfragen mit
  `target_processing_time = -1` **nicht** — echte Timeouts sind dort unsichtbar, man sieht nur die Läufe,
  die es knapp geschafft haben. Und `HTTPCode_ELB_5XX_Count` existiert nur mit der **LoadBalancer**-,
  nicht mit der `TargetGroup`-Dimension; die Abfrage kommt stumm zurück und sieht aus wie „keine Fehler".
- [ ] **Apache-prefork im Basis-Image an das Speicherbudget anpassen.** Ein Worker behält den Speicher
  seiner größten Anfrage, und ohne `MaxConnectionsPerChild` wird er nie ersetzt. Paris `tro-tro-web-s` stand
  nach einem Testnachmittag **drei Tage ohne eine einzige Anfrage bei 46 %** (≈ 220 MiB). Erst ein Neustart
  hat den Speicher freigegeben. Frankfurt `tro-tro-web-p` stieg nach jeder Nachtspitze eine Stufe höher
  (55 → 71 % in fünf Tagen). Zu setzen: `MaxConnectionsPerChild` (~500), `MaxRequestWorkers` so, dass
  Anzahl × ~45 MB unter `TaskMemory` bleibt, und `MaxSpareServers` niedrig. Außerdem `LogLevel info` →
  `warn`, denn heute schreibt `AH01964` eine Zeile je TLS-Verbindung. Die aktuellen Werte im Image sind
  noch nicht ausgelesen: `mpm_prefork.conf` und `php -i` in einem laufenden Container prüfen. Gehört zu
  Entscheidung 2, sofern die tro-Images auf `docker-base-images-v2` bauen. Das ist nicht geprüft.
- [ ] **Interner Listener auf 8443** (statt zweitem ALB; entschieden 2026-09-28). Löst zugleich, dass
  `ecsservice` heute keinen privaten Service ausdrücken kann — `Target` und `LoadbalancerRule*` sind
  bedingungslos, jeder Service bekommt eine öffentliche Listener-Regel, ob er eine braucht oder nicht.
  Services, die niemand
  von außen braucht — Solr, interne APIs — bekommen ihre Listener-Regel auf einem zweiten HTTPS-Listener
  desselben ALB. Host und Pfad bleiben, Aufruf als `https://<host>:8443/`. Erledigt den Solr-Punkt unten.
  ⚠️ **SG-Referenz greift nicht.** Instanzen liegen in `SubnetPrivate1/2` ohne öffentliche IP, der ALB ist
  `internet-facing`; sein DNS liefert nur öffentliche Adressen. Der Weg führt über das NAT Gateway, am ALB
  kommt dessen EIP an. Quelle muss `{"Fn::Sub": "${NatEip}/32"}` sein, keine `SourceSecurityGroupId`.
  **Cluster `1.8.0`:** Parameter `InternalListener` (off/on, Default off), `InternalListenerPort` (8443),
  `InternalBlockedAlarmAction` (Default **alert**). Neu `SgInternalListener` (nur NatEip), per `Fn::If` an
  `Loadbalancer.SecurityGroups`; `Internallistener` mit `HttpsdefaultlistenerCertificate` und
  fixed-response 404; `WafInternalIpSet`; Export `ListenerArnInternal`.
  **WAF, Variante 3:** interner Verkehr wird ganz normal inspiziert — nur `RateLimitSourceIp` (Prio 91)
  bekommt die NatEip per `NotStatement` aus dem `ScopeDownStatement` genommen, sonst kollabiert das Limit
  von 2.000/5 min auf eine einzige Quelle. `RateLimitForwardedIp` (Prio 90) braucht nichts, die Regel
  existiert nur mit gesetztem `WafClientIpHeader`. Dazu Metric Filter auf `WafLogGroup` mit
  `{ $.action = "BLOCK" && $.httpRequest.clientIp = "${NatEip}" }` und ein Alarm, **Schwelle 0,
  `Period: 60`** — nicht 300 wie die übrigen Alarme, weil es bei Schwelle 0 nichts zu glätten gibt und
  jede Minute Verzögerung zählt. Realistisch 2–3 min bis zur Mail, davon der Löwenanteil Log-Zustellung.
  **`ecsservice 1.8.0`:** Parameter `ListenerTarget` (public/internal). Die beiden bestehenden Regeln
  bekommen `Condition: ServiceIsPublic`, neu `LoadbalancerRuleInternal` auf den importierten
  `ListenerArnInternal`. Target Group, Health Checks und Priorität unverändert.
  **Einführung:** Paris `off` → `on` → ein Service umstellen → dann Frankfurt. Beim Umstellen löscht CFN
  die öffentlichen Regeln und legt die interne an, kurze Lücke. An einen Werktagvormittag legen.
  **Preis gegenüber einem echten internen ALB:** ein öffentlich erreichbarer TCP-Port, gehalten von einer
  SG-Regel. Dafür kein zweiter ALB (~16 USD/Monat je Region), kein neues Zertifikat, keine Private Hosted
  Zone, und der NAT-Umweg besteht ohnehin schon — gemessen ~225 GB/Monat für die *gesamte* VPC, ≈12 USD.
- [x] **LibreChat (`10.1.3.7`, Paris): Endpunkte aus der Konfiguration ergänzt — erledigt 2026-10-09.**
  Keine ECS-Instanz; die DNS-Firewall hängt an der VPC und erfasst sie mit, `SgEgress` erreicht sie gar
  nicht. Ihre *gemessenen* Abhängigkeiten stehen seit 16.09. auf der Pariser Whitelist. Offen sind die
  Endpunkte aus `librechat.yaml` und der MCP-Server-Liste, die im Messfenster niemand benutzt hat — kein
  Log kann zeigen, was nie abgefragt wurde.
  ✅ **Durchgearbeitet am 2026-10-09.** Alle 54 in 14 Tagen aufgelösten Namen sind von der bestehenden
  Whitelist gedeckt. Aus `librechat.yaml` und `.env` kamen vier Hosts dazu, die nie abgefragt wurden:
  `*.labor.tools` (Sandpack-Bundler `bundler.ai.labor.tools`, Vorschau vier Label tief, Slack-OAuth-
  Rückleitung), `*.sharepoint.com` (`SHAREPOINT_BASE_URL`), `*.labor.media` (MCP `ftp-media`),
  `*.openweathermap.org` (vorsorglich, `OPENWEATHER_API_KEY` ist leer). Dazu `registry.librechat.ai`
  erweitert auf `*.librechat.ai` für Code-Interpreter und Marketplace.
  ❌ **Nicht aufgenommen, mit Grund:** `api.jina.ai` — `JINA_API_URL` zeigt auf `litellm:4000`, also
  intern. `host.docker.internal` (`SD_WEBUI_URL`) erreicht den VPC-Resolver nicht.
  ✅ **Websuche geklärt**, mein größter Vorbehalt: eine Testsuche löste nur `api.search.brave.com` und
  `api.firecrawl.dev` auf, beide gedeckt. SearXNG nutzt derzeit ausschließlich Brave — vom Team bestätigt.
  Keine scrapenden Engines, der befürchtete Block aus Dutzenden Suchmaschinen-Domains entfällt.
  ℹ️ **Wildcard-Tiefe empirisch belegt:** `www.tm.a.prd.aadg.akadns.net` steht unter `*.akadns.net` ohne
  `firewall_rule_action` im Log — vier zusätzliche Label. Wildcards greifen also über beliebig viele Ebenen.
  ⚠️ **Nebenbefund, firewallunabhängig:** In `librechat.yaml` steht das FTP-Passwort des MCP-Servers
  `ftp-media` im Klartext, während alle anderen Geheimnisse `${VAR}` benutzen — und `FTP_SECURE` ist
  auskommentiert, die Verbindung läuft also unverschlüsselt über Port 21. Rotieren, auf `${FTP_PASSWORD}`
  umstellen, FTPS aktivieren oder den ungenutzten MCP-Server entfernen.
- [ ] **Erfassen, welche Seiten über Cloudflare laufen und welche direkt.** Nichts unterscheidet sie, und
  das blockiert sowohl die Origin-Sperre als auch `WafClientIpHeader`. `www.gwa.de` ist proxied
  (2026-09-21).
  ⚠️ Dort sieht unsere WAF nur Cloudflares IP **und** TLS-Fingerabdruck — keine Unterscheidung möglich,
  die Abwehr muss bei Cloudflare liegen.
  ⚠️ **Geparkte Domains gehören mit erfasst** — sie bestimmen mit, was auf den Origin zeigt. Siehe den
  nächsten Punkt.
- [ ] **Update Services in allen WordPress-Installationen leeren** (Einstellungen → Schreiben). Der
  Default-Eintrag `rpc.pingomatic.com` läuft über Port 80 und wird seit der Egress-Umstellung blockiert;
  jeder Publish erzeugt dann eine Alarm-Mail und wartet auf den Timeout. Nutzen hat der Ping keinen mehr.
  Nebeneffekt der Alarme: sie zeigen, **welche** Sites noch Update Services pflegen — eventuell auch
  andere als Ping-O-Matic, die in der Messwoche nichts veröffentlicht haben.
- [ ] **Services auf Image-Versionen abbilden.** Nichts beantwortet „sind wir betroffen“, wenn eine CVE
  erscheint.
- [ ] **`S3FS-Policy` und `AzureAD_SSOUserRole_Policy` lesen** — ein pauschales `s3:*` auf `*`.
- [ ] **BPA auf die beiden `cf-templates-*`-Eimer anwenden** und nachsehen, was darin liegt.
- [ ] **IAM Access Analyzer einschalten** (kostenlos) — das Einzige, das Policy, ACL und BPA gemeinsam
  bewertet.

---

## Sicherheitslage

| Maßnahme | Gebaut? |
|---|---|
| WAF vor dem ALB | ✅ sechs Regeln, jede schaltbar |
| WAF blockiert | ✅ `KnownBadInputs` `SQLi` `WordPress` `SecretPaths` in beiden Regionen |
| DNS Firewall Audit / Durchsetzung | ✅ / ⚠️ überall `ALERT`; beide Regionen gemessen und erweitert (65 / 62), Beobachtung läuft |
| VPC Flow Logs | ✅ REJECT immer, ACCEPT bei Bedarf |
| Egress gehärtet | ✅ **`restricted` in beiden Regionen** seit 2026-10-06 |
| GuardDuty-Detektor / Findings zugestellt | ✅ / ✅ ab Schwere 4 seit 2026-09-30 |
| Quarantäne-SG / Automatik | ✅ seit 30.09. dicht / gebaut, steht auf `notify` |
| Malware- und Runtime-Monitoring | ❌ |
| 4xx/5xx-Alarme je Service | ✅ ab `1.6.0` |
| Alarme kommen tatsächlich an | ✅ Paris 7, Frankfurt 9 auf `alert`; Schwellen 2026-10-03 kalibriert |
| ALB nur über den Proxy erreichbar | ❌ offen für `0.0.0.0/0`, kein Origin-Header, Default-Action leitet weiter |
| Secrets außerhalb der Task-Definition | ➖ `DOPPLER_TOKEN` bleibt Klartext, bewusst entschieden |
| RDS-Anmeldung | ❌ statisches, geteiltes Passwort |
| ALB-Log-Eimer gehärtet | ✅ `1.1.0` seit 2026-10-02: TLS-Deny, `BucketOwnerEnforced`, `aws:SourceAccount` |

Zwei Folgerungen, die ausgesprochen gehören: **DNS-`BLOCK` bei unbeschränktem Egress bringt wenig**, denn
eine Anwendung, die die Auflösung überspringt und direkt eine IP anwählt, ist davon unberührt — beides
gehört in einen Schritt. Seit dem 2026-10-06 ist die eine Hälfte erledigt, die andere ist der nächste
Schritt. Und **Erkennung ohne Zustellung ist die leiseste Fehlerart, die es gibt.**
