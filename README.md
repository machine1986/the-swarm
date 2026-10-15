# THE SWARM

**1,000 INDIVIDUALS. ONE INTELLIGENCE.**

Interaktive Schwarm-Simulation mit 1.000 leuchtenden Individuen. Die Gegner sind Käfer aus rot leuchtenden Punkten, im selben Stil wie der Schwarm: Sie laufen im Dreifuß-Gang, schwenken die Fühler und setzen sich beim Erscheinen aus einer Punktwolke zusammen. Die strategischen Entscheidungen trifft **TypeSafe Jev** (`jev-latest`), die Bewegung jedes Individuums wird lokal per Boids-Algorithmus berechnet. Gebaut für ein Social-Media-Demovideo (1920×1080, optional 1080×1920).

## Schnellstart

```bash
npm install
cp .env.example .env          # TYPESAFE_API_KEY eintragen (optional)
npm run dev                   # Backend :8787 + Vite :5173
```

Dann **http://127.0.0.1:5173** öffnen.

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklung: Backend (Watch) und Vite-Dev-Server |
| `npm run build` | Typecheck (Client + Server) und Produktionsbuild nach `client/dist` |
| `npm start` | Produktion: Express liefert Build und API auf **http://127.0.0.1:8787** |
| `npm test` | Vitest: Simulation, Scheduler, Regeln, Jev-Normalisierung, Replay |

Voraussetzung: Node.js ≥ 22.18. Der Server läuft ohne Build-Schritt direkt als TypeScript.

## API-Key

Der Key liegt ausschließlich in der **`.env` im Projektroot** und wird nur vom Backend gelesen:

```
TYPESAFE_API_KEY=...
```

- Der Browser sieht den Key nie. `/api/status` meldet nur, ob ein Key konfiguriert ist.
- `.env` steht in `.gitignore`, eingecheckt wird nur `.env.example`.
- Optionale Limits: `JEV_MAX_REQUESTS_PER_MINUTE` (Standard 45), `JEV_MAX_REQUESTS_TOTAL` (1500 pro Serverlauf), `JEV_TIMEOUT_MS` (6000).

**Ohne Key** läuft die App im Modus **SIMULATION**: Eine nachvollziehbare Regel-Engine (`shared/rules.ts`) entscheidet. Das HUD zeigt dann `LOCAL RULE ENGINE · NOT JEV`, schraffierte Balken mit `RULE` statt Prozenten und `N/A` bei Confidence. Simulierte Werte erscheinen nie als Jev-Wahrscheinlichkeiten.

## Bedienung

| Eingabe | Aktion |
|---|---|
| Linksklick auf die Bühne | Bedrohung an dieser Stelle |
| `ADD THREAT` / `T` | Bedrohung nahe am Schwarm |
| `SPAWN 5`, `CLEAR` | 5 Bedrohungen / alle entfernen |
| `CHAOS MODE` / `X` | 15–20 Bedrohungen, Verdunkelung, Warnbanner, Jev bewertet neu |
| `PAUSE` / Leertaste | Simulation anhalten (UI bleibt bedienbar) |
| `RESET` / `R` | Alles zurücksetzen |
| `CINEMATIC` / `C` | Nur Essentials sichtbar, Cursor aus (Esc beendet) |
| `RECORD DEMO` / `D` | 60-Sekunden-Autopilot, wird automatisch aufgezeichnet |
| `1`–`6` | Strategie manuell erzwingen (FLOCK … REGROUP), KI pausiert 8 s, Anzeige „MANUAL OVERRIDE · NOT JEV“ |

## Wie Jev entscheidet

Etwa alle 1,5 s schickt der Client einen **kompakten Zustand** an `POST /api/decide`: Population, Energie, Kohäsion, Dispersion, Bedrohungsanzahl, Distanz, Sektoren usw. Einzelne Partikelpositionen werden nie gesendet. Der `JevService` (`server/src/services/JevService.ts`) stellt in **einem** `systemOne`-Aufruf drei unabhängige Fragen:

- **strategy** (`choice`): FLOCK / FLIGHT / ATTACK / DEFEND / SPLIT / REGROUP
- **urgency** (`score`, Rubrik 0–3): normalisiert als `score / 3`, steuert Übergangsgeschwindigkeit, Pulsstärke, Kraft und Glow
- **conserveEnergy** (`noul`): drosselt Maximalgeschwindigkeit und Energieverbrauch

Die Antwort wird strikt validiert. Fehlt ein Wert oder ist er ungültig, wird die ganze Antwort verworfen, statt sie aufzufüllen. Das Ergebnis ist ein typisiertes `DecisionResult` mit Latenz, Modellversion und Request-ID.

Der **DecisionScheduler** (`client/src/api/DecisionScheduler.ts`) sorgt für:

- maximal eine laufende Anfrage
- sofortige Neubewertung bei Ereignissen, mit 650 ms Sperrfrist
- 2,4 s Cooldown für Strategiewechsel (1 s bei hoher Urgency)
- Verwerfen veralteter Antworten nach einem Reset
- langsameres Intervall im Leerlauf
- Request-Budget (Client und Server)
- bei Fehlern: Backoff (3 → 6 → 15 → 30 s) und bis dahin gekennzeichnete lokale Regeln

Die Animation läuft unabhängig davon weiter.

## Autopilot-Demo (`RECORD DEMO`)

| Zeit | Szene |
|---|---|
| 0–8 s | **Awakening**: ein Lichtpunkt teilt sich zu 1.000 Individuen, Titel |
| 8–18 s | **First Contact**: eine Bedrohung, Jev entscheidet live |
| 18–30 s | **Escalation**: weitere Bedrohungen, Kamera zoomt heraus |
| 30–45 s | **Chaos**: 18 Bedrohungen, „CRITICAL THREAT DETECTED“ |
| 45–55 s | **The Singularity**: Verdichtung zur hellen Kugel, Explosion in tausende Lichtpartikel |
| 55–60 s | **End Card**: „INTELLIGENCE DOESN'T NEED WORDS. · POWERED BY JEV“ |

Bedrohungen, Titel und Kamera sind geskriptet. Die Strategie in den Szenen 2–4 kommt von Jev. Die Singularity ist ausdrücklich ein Kinoeffekt: Das HUD zeigt dabei `AI PAUSED` und `CINEMATIC SEQUENCE · NOT A JEV DECISION`.

## Record & Replay

Echte Jev-Sessions lassen sich aufnehmen und beliebig oft ohne API-Aufrufe abspielen. Das ist ideal fürs Video.

1. **START REC** (oder `RECORD DEMO`) startet einen frischen Schwarm mit neuem Seed und zeichnet auf.
2. **STOP REC** speichert die Aufnahme automatisch als `recordings/swarm-<zeit>.json`.
3. **EXPORT** lädt die zuletzt aufgenommene oder geladene Aufnahme als Datei herunter.
4. **LOAD** öffnet eine Aufnahme aus `recordings/` oder aus einer Datei.
5. **PLAY REPLAY** spielt sie ab. Das HUD zeigt `REPLAY` und „● RECORDED JEV DECISIONS“.

Aufgezeichnet werden alle Kommandos mit ihrem Simulations-Tick: Bedrohungen, Benutzeraktionen, Jev-Anfragen samt Zustand, Jev-Antworten, Strategiewechsel, Kamera und Titel, plus Seed und Weltgröße. Die Reproduzierbarkeit kommt von einem Seeded RNG (Mulberry32), einem festen 60-Hz-Physik-Timestep und einem einzigen Command-Bus. Ein Test prüft, dass Live-Lauf und Replay bitgenau übereinstimmen.

## Video-Tipps

- Browserfenster auf 1920×1080 (oder 1080×1920 für das Hochformat-Layout), dann `C` für Cinematic Mode.
- Erst die Demo live aufnehmen (`D`), dann für die OBS-Aufnahme `PLAY REPLAY` nutzen. So stören keine Netzwerklatenzen.

## Architektur

```
shared/          Typen (SwarmState, DecisionResult …) + Regel-Engine, von Client und Server genutzt
server/src/      Express: /api/status, /api/decide, /api/recordings
  services/      JevService (TypeSafe SDK), RequestBudget
client/src/
  simulation/    World (Boids + Formationen + Energie, deterministisch), SpatialHash, RNG, Metriken
  rendering/     PixiJS v8: ParticleContainer (1 Draw Call), Trail-Feedback-Buffer + Bloom,
                 Bedrohungen, Effekte (Pulse, Funken, Barriere), Hintergrund, Kamera
  api/           API-Client, DecisionScheduler
  hud/           HTML/CSS-HUD und Overlays
  demo/          Autopilot-Skript
  replay/        Recorder / Replayer
  app/           App: Frame-Loop, Command-Bus, Eingaben
```

Zur Performance: 1.000 Partikel werden per Struct-of-Arrays und Spatial Hash (Counting Sort, keine Allokationen pro Frame) berechnet, mit festem Timestep und Interpolation. Trails entstehen über einen ausblendenden Render-Buffer statt über Partikelhistorien. Gemessen: stabile 60 FPS in Chrome auf Apple Silicon bei 1920×1080.

## Bekannte Einschränkungen

- Eine Aufnahme beginnt immer mit einem frischen Schwarm. Mitten in einer laufenden Session lässt sich nicht aufnehmen.
- Replays sind im selben Browser bzw. derselben JS-Engine deterministisch. Über verschiedene Engines hinweg ist Gleitkomma-Gleichheit nicht garantiert.
- Rein visuelle Effekte (Funken, Glut) nutzen `Math.random` und können sich im Replay minimal unterscheiden. Die Simulation selbst ist identisch.
- Zeitstempel im Event-Log zeigen beim Replay die Wiedergabezeit.
- Schriften kommen von Google Fonts. Offline wird auf Systemschriften zurückgefallen.
- Einen direkten Videoexport gibt es nicht. Aufnahme über OBS bzw. Bildschirmaufnahme.
- Das Server-Budget (`JEV_MAX_REQUESTS_TOTAL`) gilt pro Serverprozess und wird bei Neustart zurückgesetzt.
