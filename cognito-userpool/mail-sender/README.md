# Mail-Sender-Artefakt bauen und hochladen

Der Cognito-Custom-Email-Sender wird als einzelnes ZIP aus dem S3-Bucket geladen, dessen Bucket und Key im Pool-Stack als `MailSenderCodeBucket` und `MailSenderCodeKey` gesetzt werden.

## Voraussetzungen

- nvm mit installiertem Node.js 22 und npm; die benötigte Major-Version steht in `.nvmrc`
- Netzwerkzugriff auf die npm-Registry beim Build; `build.sh` installiert die festgelegten Build- und Laufzeitabhängigkeiten lokal
- AWS CLI sowie Schreibzugriff auf den regionalen Artefakt-Bucket zum Hochladen

`build.sh` lädt `nvm` und führt `nvm use` anhand der `.nvmrc` aus. Fehlt nvm, bricht der Build absichtlich ab, statt eine möglicherweise inkompatible Node-Version aus dem `PATH` zu verwenden.

## Build

Im Verzeichnis `cognito-userpool/mail-sender` ausführen:

```bash
./build.sh
```

Das Skript bündelt `src/index.mjs` samt AWS Encryption SDK zu einer Node.js-22-Datei und legt ein versioniertes ZIP unter `dist/cognito-userpool-mail-sender-1.0.0.zip` ab. Das ZIP enthält nur `index.mjs`; `node_modules`, Build-Werkzeuge und native Binärdateien werden nicht mit ausgeliefert.

## Hochladen

Jede veröffentlichte Version bekommt einen eigenen, unveränderlichen S3-Key. Beispiel mit Platzhaltern:

```bash
aws s3 cp \
  dist/cognito-userpool-mail-sender-1.0.0.zip \
  s3://ARTIFACT_BUCKET/cognito-userpool/mail-sender/1.0.0/cognito-userpool-mail-sender-1.0.0.zip
```

Beim Deployment des Pool-Stacks müssen `MailSenderCodeBucket` und `MailSenderCodeKey` exakt auf diesen Upload zeigen. Für eine neue Sender-Version zuerst die `version` in `package.json` erhöhen, neu bauen und unter einem neuen Key hochladen; danach den Stack mit diesem Key aktualisieren.

Die Mailjet-Zugangsdaten werden nur über die `NoEcho`-Parameter des Pool-Stacks gesetzt. Sie gehören weder in dieses Verzeichnis noch in das ZIP.
