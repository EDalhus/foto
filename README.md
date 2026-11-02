# Foto

Selvhostet foto-portefølje og bildeleveranse – et open source-alternativ til SmugMug, med publiseringstjeneste for Lightroom Classic.

Kjører i dag på **https://foto.dalhus.net**.

## Hva den gjør

- **Mapper og album i flere nivåer.** Strukturen er virtuell – den finnes bare i databasen, aldri som mapper på disk.
- **Offentlige og private album.** Private album (eller album i en privat mappe) krever innlogging. En lenke alene gir ingenting – heller ikke direkte lenker til bildefilene.
- **Lightroom Classic-plugin** (publiseringstjeneste). Samlingssett blir mapper, samlinger blir album. Nye versjoner, sletting, navnebytter, flytting og rekkefølge følger med.
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
| `POST` | `/api/v1/lr/sync` | Finn/opprett mappe eller album ut fra Lightroom-ID-er |
| `POST` | `/api/v1/lr/delete-collection` | Slett mappe/album |
| `POST` | `/api/v1/lr/delete-photos` | Slett flere bilder: `{ "ids": [...] }` |

Uten innlogging: `/health` og `/health/storage` (200/503, for overvåking).

## Lisens

MIT – se [LICENSE](LICENSE).
