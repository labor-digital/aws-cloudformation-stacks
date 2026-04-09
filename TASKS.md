### Verbesserungsvorschläge für das Netzwerk-Design

Hier sind die konkreten Punkte, die du im Template verbessern kannst:

---

#### 1. 🟡 NACL ist vollständig offen — sinnvoller einschränken oder entfernen

```json
// NetaclEntry1 + NetaclEntry2: Protocol -1, 0.0.0.0/0, allow
```

Die Network ACL erlaubt alles in beide Richtungen (Protocol `-1` = alle Protokolle). Das ist funktional identisch mit der Standard-NACL von AWS. Entweder:
- Die NACL **entfernen** (Standard-NACL übernimmt) und nur auf Security Groups setzen, oder
- Sinnvolle Regeln definieren, z.B. nur TCP auf bestimmten Ports erlauben

---

#### 2. 🟡 ALB Access Logs aktivieren

```json
{ "Key": "access_logs.s3.enabled", "Value": "false" }
```

Für Produktion sollten ALB Access Logs in einen S3-Bucket geschrieben werden. Das hilft bei Debugging, Security-Audits und Compliance.

---

#### 3. 🟡 ALB Deletion Protection aktivieren

```json
{ "Key": "deletion_protection.enabled", "Value": "false" }
```

In Produktion sollte der Load Balancer nicht versehentlich gelöscht werden können.

---

#### 4. 🟡 `SgPublicHttps` hat falschen `GroupDescription`

```json
"GroupDescription": "Securitygroup to access http and https from everywhere",
// Beschreibung ist identisch mit SgPublicHttpHttps — Copy-Paste-Fehler
```

Der Name suggeriert "nur HTTPS", aber die Beschreibung sagt "http and https". Entweder die Beschreibung korrigieren oder prüfen, ob Port 80 in `SgPublicHttps` wirklich nötig ist (HTTP→HTTPS-Redirect sollte am ALB passieren, nicht durch eine separate SG).

---

#### 5. 🟢 VPC Flow Logs hinzufügen

Aktuell gibt es keine VPC Flow Logs. Diese helfen bei der Analyse von Netzwerkproblemen und Security-Incidents:

```json
"VpcFlowLog": {
  "Type": "AWS::EC2::FlowLog",
  "Properties": {
    "ResourceId": { "Ref": "Vpc" },
    "ResourceType": "VPC",
    "TrafficType": "ALL",
    "LogDestinationType": "cloud-watch-logs"
  }
}
```

---

#### 6. 🟢 IPv6 im ALB nutzen oder konsequent weglassen

Der ALB hat `"IpAddressType": "ipv4"`, aber `SgPublicHttpHttps` und `SgPublicHttps` haben bereits IPv6-Regeln (`::/0`). Entweder:
- ALB auf `"dualstack"` umstellen und IPv6 konsequent nutzen, oder
- Die IPv6-Ingress-Regeln aus den Security Groups entfernen

---

#### 7. 🟢 `InitialDockerImage` über SSM Parameter Store lösen

Aktuell muss das Docker-Image bei jedem Stack-Deployment manuell eingegeben werden:

```json
"InitialDockerImage": {
  "Type": "String",
  "MinLength": 1
}
```

**Empfehlung:** Den Parameter auf `AWS::SSM::Parameter::Value<String>` umstellen und den Image-Pfad zentral im SSM Parameter Store verwalten:

```json
"InitialDockerImage": {
  "Type": "AWS::SSM::Parameter::Value<String>",
  "Default": "/myproject/prd/docker-image",
  "Description": "SSM path to the Docker image URI. The SSM parameter must exist before stack deployment."
}
```

Im SSM Parameter Store einmalig anlegen (z.B. per CLI oder CI/CD-Pipeline):
```
/myproject/prd/docker-image = 123456789.dkr.ecr.eu-central-1.amazonaws.com/myapp:latest
```

**Vorteile:**
- Kein manuelles Eingeben bei Stack-Deployments
- CI/CD-Pipeline aktualisiert nur den SSM-Wert, nicht den Stack
- Verschiedene Umgebungen (prd/stg) nutzen verschiedene SSM-Pfade

**Hinweis:** Beim allerersten Deployment (bevor das eigene Image existiert) kann als Übergangslösung ein öffentliches Placeholder-Image genutzt werden: `amazon/amazon-ecs-sample`

---

#### 8. 🟢 EC2-Instanzen automatisch mit `dnf-automatic` aktuell halten

Aktuell werden auf den EC2-Instanzen keine automatischen OS-Updates durchgeführt. In Amazon Linux 2023 steht `dnf-automatic` zur Verfügung, das regelmäßig Sicherheitsupdates einspielt.

**Empfehlung:** Im `UserData`-Skript des `Launchtemplate` aktivieren:

```bash
sudo dnf install -y dnf-automatic
sudo sed -i 's/^apply_updates = no/apply_updates = yes/' /etc/dnf/automatic.conf
sudo systemctl enable --now dnf-automatic-install.timer
```

**Vorteile:**
- Sicherheitsupdates werden automatisch eingespielt, ohne manuellen Eingriff
- `dnf-automatic-install.timer` läuft täglich und installiert verfügbare Updates
- Konfigurierbar: nur Security-Updates oder alle Updates (via `upgrade_type` in `/etc/dnf/automatic.conf`)

**Hinweis:** Bei kritischen Updates kann ein Neustart der ECS-Instanz nötig sein. Da der ASG mit `OldestLaunchTemplate`-Terminierungspolicy konfiguriert ist, werden alte Instanzen bei Scale-Events ohnehin ersetzt. Für erzwungene Neustarts nach Updates kann zusätzlich `needs-restarting` genutzt werden.

---

### Zusammenfassung nach Priorität

| Priorität | Maßnahme |
|---|---|
| 🟡 Mittel | ALB Access Logs + Deletion Protection aktivieren |
| 🟡 Mittel | NACL sinnvoll einschränken oder entfernen |
| 🟡 Mittel | `SgPublicHttps` GroupDescription korrigieren |
| 🟢 Nice-to-have | VPC Flow Logs |
| 🟢 Nice-to-have | IPv6 konsequent ein- oder ausschalten |
| 🟢 Nice-to-have | `InitialDockerImage` über SSM Parameter Store lösen |
| 🟢 Nice-to-have | EC2-Instanzen automatisch mit `dnf-automatic` aktuell halten |
