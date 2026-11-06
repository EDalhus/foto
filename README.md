# Foto

Selvhostet foto-portefølje og bildeleveranse – et open source-alternativ til SmugMug, med publiseringstjeneste for Lightroom Classic.

Kjører i dag på **https://foto.dalhus.net**.

## Hva den gjør

- **Mapper og album i flere nivåer.** Strukturen er virtuell – den finnes bare i databasen, aldri som mapper på disk.
- **Offentlige og private album.** Private album (eller album i en privat mappe) krever innlogging. En lenke alene gir ingenting – heller ikke direkte lenker til bildefilene.
- **Gjester: familie, venner og kunder.** Lag grupper under **Administrer → Gjester**, legg til personer og del mapper eller album med gruppa (eller del fra albumsiden). Gjester logger inn med en lenke på e-post – ingen passord – og ser det som er delt med dem under «Delt med deg». Deles en mappe, følger alt under med.
- **Offentlig, privat eller kunde rett fra albumet.** På albumsiden i admin velger du hvem som ser albumet. Under «Kunde» skriver du inn navn og e-post, så lages kunden, albumet blir privat og invitasjonen sendes – og du styrer nedlasting, utløpsdato og innloggingslenker der. Under «Privat» deler du med grupper med ett klikk eller lager en ny.
- **Forsidebilde** velges i en bildevelger (også for mapper, blant bildene i albumene i mappa), fra bildene i albumet, eller med stjernen i bildevisningen når du er logget inn.
- **Biblioteket** viser forsidebilder og hvem som ser hva, kan filtreres (offentlige, private, kunder) og søkes i, og du kan gjøre flere album offentlige eller private, dele dem eller flytte dem på en gang.
- **Kunden velger bilder.** Gjester trykker på hjertet på bildene de liker og sender valget. Du får e-post med filnavnene (klare til å lime inn i Lightroom-filteret), og valget står på albumsiden i admin. Albumet kan ha «velg N bilder» (gjesten ser «12 av 30 valgt» og kan ikke velge flere), og valget låses når det er sendt – du kan låse det opp igjen fra albumsiden.
- **Utløpsdato og nedlasting per gruppe.** En gruppe kan ha «tilgang til og med» en dato, og kan få lov til å laste ned (eller ikke) uavhengig av albumet – f.eks. nedlasting først når kunden har betalt. Nye kundegrupper kan ikke laste ned før du sier ja.
- **Påminnelse før tilgangen går ut.** Gjester i grupper med «tilgang til og med» får en e-post med en lenke som logger dem rett inn, noen dager før (standard 3, under **Administrer → Innstillinger**).
- **Varsler til deg** når en gjest logger inn første gang og når noen sender valget sitt (til `NOTIFY_EMAIL`, ellers admin-adressen; `NOTIFY_EMAIL=off` slår av).
- **Statistikk** under **Administrer → Statistikk**: visninger og nedlastinger per dag og per album, og hva hver gjest har sett og lastet ned (også på kundekortene). Ingen informasjonskapsler, ingen lagrede IP-adresser; du selv og roboter telles ikke.
- **Søk** i titler, bildetekster, stikkord og filnavn, og i navn på album og mapper. Bare det brukeren har tilgang til, vises.
- **Bildevisning** som zoomer ut fra miniatyren og tilbake når den lukkes – siden står da ved bildet du så sist. Dra ned for å lukke på mobil. **Lysbildefremvisning** (mellomrom eller ▶), i fullskjerm der nettleseren støtter det.
- **Vannmerke** (valgfritt, under **Administrer → Innstillinger**) på offentlige bilder. Du og gjester i private album ser bildene uten. Vannmerkede versjoner lages første gang de trengs.
- **Lightroom Classic-plugin** (publiseringstjeneste). Samlingssett blir mapper, samlinger blir album. Nye versjoner, sletting, navnebytter, flytting og rekkefølge følger med. Det du lager på nettstedet, kan hentes inn i Lightroom med **Synkroniser med Foto**.
- **Opplasting fra nettleseren** (dra og slipp) i admin.
- **Nedlasting i full oppløsning** – enkeltbilder og hele album som zip – når det er slått på for albumet.
- **Originaler og webversjoner hver for seg.** Webversjoner (WebP i fire størrelser) ligger på serveren og vises raskt. Originalene lagres i en egen lagring (lokal disk eller S3) og hentes bare ved nedlasting.
- **Tåler at lagringen er nede.** Nye originaler venter på serveren og sendes når lagringen er tilbake. Sletting står i kø.
- **Daglig database-backup** til lagringen.

## Arkitektur (slik den kjører på foto.dalhus.net)

```
Besøkende / Lightroom ──► foto.dalhus.net (svs1, Docker bak nginx)
                             │  • nettsiden, admin, API
                             │  • SQLite-database + webversjoner (/opt/foto/data)
                             │
                             └─[Tailscale]──► UNAS «Coruscant»
                                               • rclone serve s3 (127.0.0.1:8099, bruker unifi-drive)
                                               • Publisert/originaler/  ← originaler i full oppløsning
                                               • Publisert/database/    ← daglig backup av databasen
```

RAW-filene i `Foto` og `Bilder` på UNAS røres aldri.

## Mapper i repoet

| Mappe | Innhold |
|---|---|
| `app/` | SvelteKit-appen (Node 24, `node:sqlite`, sharp) |
| `lightroom/foto.lrplugin/` | Lightroom Classic-pluginen (Lua) |
| `deploy/` | Docker Compose, nginx-oppsett og `deploy.sh` for svs1 |
| `deploy/unas/` | Oppsett av lagringen på UNAS (`rclone serve s3`) |

## Lightroom-pluginen

1. Kopier `lightroom/foto.lrplugin` til `~/Library/Application Support/Adobe/Lightroom/Modules/` (eller legg den til via **Fil → Behandle tilleggsprogrammer → Legg til**). Start Lightroom på nytt.
2. I Lightroom: klikk **+** i panelet **Publiser tjenester** → **Gå til Administrasjon av publisering …**, velg **Foto**, sjekk serveradressen og trykk **Koble til Foto …**.
3. Nettleseren åpner `/koble/<kode>`: logg inn, sjekk at koden er den samme som i Lightroom og trykk **Koble til**. Tilbake i Lightroom står det «Tilkoblet som …». Trykk **Lagre**. Nøkkelen lages og hentes automatisk, og vises under **Administrer → Lightroom og API**, der den kan trekkes tilbake.
4. Lag mapper og album under tjenesten (høyreklikk), dra inn bilder og trykk **Publiser**.

Pluginen eksporterer ferdig redigerte JPEG-er (sRGB). Velg gjerne full størrelse og høy kvalitet under «Bildestørrelse» og «Filinnstillinger» – det er dette som lastes ned i full oppløsning.

Hva den gjør:

- **Synlighet per album og mappe** (høyreklikk → Rediger). En privat mappe skjuler alt under seg. Endrer du noe uten nett, huskes det og sendes neste gang albumet publiseres.
- **Navnebytte, flytting, sletting og egendefinert rekkefølge** følger med til nettstedet.
- **Synkroniser med Foto:** **Fil → Ekstra pluginmoduler → Synkroniser med Foto …** henter det som er laget eller endret på nettstedet inn i Lightroom, så du kan fortsette å publisere derfra:
  - Mapper og album som er laget på nettstedet, blir mapper og album under Foto-tjenesten, koblet til dem på nettstedet. Det du publiserer i dem, havner på samme sted. Finnes et upublisert album med samme navn i Lightroom fra før, kobles det i stedet for å lage et nytt.
  - Bilder som er lastet opp på nettstedet, kobles til samme bilde i katalogen når det finnes der (samme filnavn uten filendelse, og samme opptakstid – f.eks. `ED1_0590.jpg` på nettstedet og `ED1_0590.NEF` i katalogen). Ellers kan originalene lastes ned og importeres (standard: `~/Pictures/Foto/<mappe>/<album>/`, «Bilder» i Finder). Bildene merkes som publisert, så de lastes ikke opp på nytt.
  - Navn, plassering og synlighet som er endret på nettstedet, oppdateres i Lightroom. Innstillinger du endret i Lightroom uten nett, sendes først og vinner.
  - Det som er slettet på nettstedet, kan fjernes fra Lightroom (valgfritt, av som standard).
  - Du ser en oversikt og bekrefter før noe endres. Bildene på nettstedet endres aldri. Mapper og album fra en annen Lightroom-katalog røres ikke.
- **Kopier fra SmugMug:** **Fil → Ekstra pluginmoduler → Kopier album fra SmugMug …** lager samme mapper og album (også smarte album) under Foto, med de samme bildene. Synligheten hentes fra SmugMug der det går (Public blir offentlig, alt annet privat). Bare katalogen endres – ingenting lastes opp før du trykker Publiser, og SmugMug-tjenesten røres ikke. Kan kjøres flere ganger.
- **Tåler hikke:** forbigående feil (f.eks. mens serveren starter på nytt) prøves på nytt. Nye bilder lastes bare opp på nytt når det er sikkert at de ikke kom fram første gang, så det blir ingen duplikater.
- **Logg** i `~/Library/Logs/Foto-Lightroom.log` (knapp under Fil → Behandle tilleggsprogrammer → Foto). API-nøkkelen logges aldri.

## Kjøre selv

```sh
cd app
cp .env.example .env    # fyll inn ADMIN_EMAIL/ADMIN_PASSWORD
npm install
npm run dev
```

Admin-brukeren opprettes fra `ADMIN_EMAIL`/`ADMIN_PASSWORD` første gang appen starter (passordet kan byttes under **Administrer → Konto**).

### E-post (innloggingslenker til gjester)

Sett `SMTP_HOST`, `SMTP_PORT` og `MAIL_FROM` (eventuelt `SMTP_USER`/`SMTP_PASS`, `SMTP_SECURE=true`). Uten `SMTP_HOST` skrives e-posten til loggen, og «Kopier lenke» i admin kan brukes i stedet. `deploy/docker-compose.yml` har en Postfix-container som bare sender og signerer med DKIM; legg den offentlige nøkkelen i DNS og ta med serverens IP i SPF.

### Tester

```sh
cd app && npm run build && node test/gjester.test.mjs   # gjester, lenker og tilgang
node test/forbedringer.test.mjs                         # favoritter, utløp, nedlasting per gruppe, varsler, søk, vannmerke
node test/admin.test.mjs                                # forsidebilde, offentlig/privat/kunde, grupper, biblioteket
node test/kunder.test.mjs                               # «velg N bilder», låst valg, påminnelser, statistikk
cd lightroom/test && bash kjor.sh                          # Lightroom-pluginen
```

### Lagring av originaler

| `STORAGE_DRIVER` | Bruk |
|---|---|
| `local` | Filer i `STORAGE_LOCAL_DIR` (standard `DATA_DIR/store`) |
| `s3` | Alt som snakker S3: `rclone serve s3` på en NAS, Cloudflare R2, MinIO, AWS S3 … Sett `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` og eventuelt `S3_BACKUP_BUCKET`. |

### Produksjon

Se `deploy/docker-compose.yml`. Appen lytter på `HOST`/`PORT` og trenger `ORIGIN` (offentlig adresse) og `BODY_SIZE_LIMIT` (f.eks. `400M`) bak en proxy.

`deploy/deploy.sh` legger appen ut på en server med Docker og nginx. Kopier `deploy/deploy.env.example` til `deploy/deploy.env` (ligger ikke i git) og fyll inn server, domene og e-post først.

## API (v1)

Alle kall krever `Authorization: Bearer <API-nøkkel>` (eller innlogget økt fra samme side).

| Metode | Sti | Hva |
|---|---|---|
| `GET` | `/api/v1/me` | Test tilkobling |
| `POST` | `/api/v1/connect/start` | «Koble til» uten nøkkel: `{ "device" }` → `{ pollSecret, code, url, interval, expiresIn }` |
| `POST` | `/api/v1/connect/poll` | Uten nøkkel: `{ "pollSecret" }` → `pending` / `approved` (+ `token`, én gang) / `denied` / `expired` |
| `POST` | `/api/v1/connect/revoke` | Sletter nøkkelen i kallet («Koble fra») |
| `POST` | `/api/v1/albums/:id/photos` | Last opp bilde (`multipart`: `file`, valgfritt `title`, `caption`, `keywords`) |
| `POST` | `/api/v1/photos/:id/replace` | Ny versjon av et bilde (samme ID) |
| `PATCH` / `DELETE` | `/api/v1/photos/:id` | Endre tittel/bildetekst, eller slett |
| `POST` | `/api/v1/albums/:id/order` | Rekkefølge: `{ "photoIds": [...] }` |
| `POST` | `/api/v1/albums/:id/cover` | Forsidebilde: `{ "photo": "<id>" }`, eller `null` for automatisk |
| `POST` | `/api/v1/favorites` | Gjest: hjerte på/av `{ "photo", "on" }` (423 når valget er låst, 409 når «velg N» er nådd) |
| `POST` | `/api/v1/stats/view` | Teller en visning av en mappe/et album `{ "node" }` (sendes av nettsiden selv) |
| `POST` | `/api/v1/lr/sync` | Finn/opprett mappe eller album ut fra Lightroom-ID-er |
| `POST` | `/api/v1/lr/delete-collection` | Slett mappe/album |
| `POST` | `/api/v1/lr/delete-photos` | Slett flere bilder: `{ "ids": [...] }` |
| `GET` | `/api/v1/lr/tree?serviceKey=` | Hele strukturen med koblingen til Lightroom (`link`: `null` = laget på nettstedet, `{ lrId }` = denne tjenesten, `"other"` = en annen katalog) og bilde-ID-ene i hvert album |
| `POST` | `/api/v1/lr/link` | Koble mapper/album til samlinger i Lightroom: `{ "serviceKey", "links": [{ "id", "kind", "lrId", "relink"? }] }` |
| `GET` | `/api/v1/albums/:id/photos` | Bildene i et album med filnavn, opptakstid (veggklokke) og størrelse |

Uten innlogging: `/health` og `/health/storage` (200/503, for overvåking).

## Lisens

MIT – se [LICENSE](LICENSE).
