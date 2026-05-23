# Argus — civil early-warning network for def/acc

Argus turns a single voice interview, a portrait and a last-known location into a multi-agent defensive operation that scans, verifies, alerts and learns. Built for the **def/acc** track: tools that strengthen society's ability to defend itself instead of accelerating raw capability.

Threat model in scope:
- missing-person reports (the live demo)
- coordinated trafficking patterns (Sentinel)
- deepfake / disinformation portraits (intel.provenance)
- false-report fraud (Sentinel integrity warnings)
- response routing failures (intel.overpass critical infrastructure)

## What it does end-to-end

1. **Intake**: the voice agent (Simli + ElevenLabs + Gemini) interviews the family in Spanish. Photo + last seen + signs.
2. **Geocode**: Mapbox resolves the location and rehydrates the operational map.
3. **Photo provenance** (`intel.provenance`): EXIF presence + perceptual dHash + Gemini Vision deepfake classifier → verdict `verified / suspect / unknown`. Filters poisoned inputs before any downstream agent acts on them.
4. **Atlas**: projects probable search sectors + walks the route outward.
5. **Echo** + Facebook Graph: drafts the post copy and publishes the banner.
6. **Ghost (vision)**: per-image comparison via MiniMax-VL → Gemini fallback.
7. **Ghost.social** (SERP OSINT): public, indexed social posts only — adapted from the operator's [auto-social](../Descargas/outliers/auto-social) engine but flipped for *sighting intent*. Brave → Serper → DuckDuckGo fallback. Per-source RPS throttle (`OSINT_RATE_RPS`).
7. **Ghost.harvest** (controlled-post comment ingest): the operator publishes the alert to a page they control (via `/api/publish`), Argus auto-schedules harvests at +30 s and +5 min that read the comments via Facebook Graph (or Nitter for X), scores each comment for sighting intent, inserts witness tips as matches and pings the authority on confidence ≥ 0.75. Operator can also POST `/api/osint/harvest` manually with any `postUrl`.
8. **GDELT 2.0** (`intel.gdelt`): geo-scoped global news events in the last 24h around the case. Public, no key.
9. **OSM Overpass** (`intel.overpass`): police, hospitals, shelters, transit in a 4 km radius. Public, no key.
10. **Sentinel**: not just clusters — detects `trafficking_pattern_alert` (≥3 cases, ≤5 km, same gender + age band, 7 d window) and `false_report_cluster` (same phone reporting ≥2 cases in 24h).
11. **Pulse**: notifies authority (Resend / SMTP) + WhatsApp (Baileys worker).
12. **Struere co-pilot**: every operator question can be routed to a Struere-deployed agent for narrative analysis, with the live case as context. Falls back gracefully when no agent is deployed.

Everything emits `pipeline_events` so the live map + Defense Posture panel render in real time.

## Screens

- `/` — conversational intake; collapses into the operational center post-interview.
- `/dashboard` — classic operator dashboard.
- `/defense` — **Defense Posture**, the def/acc-facing public panel: KPI strip (cases 24 h, trafficking patterns, deepfakes filtered, OSINT articles, critical infra, integrity warnings), per-agent activity bars, Sentinel patterns, live Struere wiring snapshot, telemetry feed. Polls every 4 s.
- `/agente` — voice avatar inherited from RadarHuman.

## Defensive APIs

```
POST /api/intel/provenance      photo verdict (verified / suspect / unknown)
POST /api/intel/gdelt           OSINT context near (lat,lng)
POST /api/intel/overpass        critical infrastructure near (lat,lng)
GET  /api/intel/posture         aggregated defense posture snapshot

POST /api/agents/atlas          probable search sectors + path
POST /api/agents/sentinel       cluster + trafficking-pattern detector
POST /api/agents/pulse-watch    notification heartbeat

POST /api/osint/social          Ghost.social OSINT (Brave/Serper/DDG)
POST /api/osint/harvest         Ghost.harvest — read tips from a controlled post URL

POST /api/struere/chat          operator → Struere agent co-pilot
GET  /api/struere/state         live snapshot of Struere account

POST /api/alert-authorities     authority email (Resend / SMTP)
POST /api/publish               Facebook Graph publish
```

## Mapas

Mapbox GL JS with three modes (threat / routes / agents). Live agent zones, animated agent markers, dynamic search rings, cinematic fly-to on every new match. Token in `NEXT_PUBLIC_MAPBOX_TOKEN=pk…`. Without token a fallback message is rendered (no fake city).

## Required variables

```bash
# Core
NEXT_PUBLIC_MAPBOX_TOKEN=pk....
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Brain
GEMINI_API_KEY=...        # rotates across GEMINI_API_KEY{,_2,_3}
ELEVENLABS_API_KEY=...    # rotates across ELEVENLABS_API_KEY{,_2,_3,_4}
NEXT_PUBLIC_SIMLI_API_KEY=
NEXT_PUBLIC_SIMLI_FACE_ID=

# def/acc integrations
STRUERE_API_KEY=          # https://api.struere.dev
STRUERE_AGENT_SLUG=argus-ops
BRAVE_SEARCH_API_KEY=     # optional — best OSINT recall
SERPER_API_KEY=           # optional — fallback OSINT
INTEL_GDELT_RADIUS_KM=80
INTEL_OVERPASS_RADIUS_M=4000
PROVENANCE_GEMINI_ENABLED=true

# Notifications
RESEND_API_KEY=
RESEND_FROM="ARGUS <onboarding@resend.dev>"
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
AUTHORITY_ALERT_EMAIL=

# Facebook publisher
FACEBOOK_ENABLED=true
FACEBOOK_PAGE_ID=
FACEBOOK_PAGE_ACCESS_TOKEN=

# Optional MiniMax (vision + video)
MINIMAX_ENABLED=false
MINIMAX_API_KEY=
MINIMAX_GROUP_ID=
```

Full template lives in [.env.example](./.env.example).

## Supabase

`supabase/schema.sql` provisions `cases`, `conversation_messages`, `media`, `matches`, `pipeline_events`, `viral_posts` and the public-read storage buckets. Realtime is enabled on `cases`, `matches`, `pipeline_events` so the operational map updates without polling.

## Demo publishing flow vs. production Meta API

For the demo we publish the alert through `/api/publish` (Facebook Graph
API, page access token the operator already owns) and then **harvest
comments from that same post URL** via `/api/osint/harvest`. No
impersonation, no scraping behind walls, no third-party page touched
without consent. The operator only ever reads comments under a page
*they* control.

For production we recommend:

1. **Promote to real Meta Pages API access** with `pages_manage_posts`,
   `pages_read_engagement` and `instagram_manage_comments` so harvest
   covers IG natively (today IG harvest requires the business-account
   linkage).
2. Pair with the **Argus Sentinel cluster detector** so multi-page tips
   coalesce into a single trafficking-pattern alert.
3. Lock the page to a **verified civic operator** (police PIO, civil
   defense, NGO) so all tips arrive at a single accountable inbox.

Until then, the demo path is: operator publishes → grabs `postUrl`
from the `/api/publish` response (auto-returned now) → Argus
auto-harvests at +30 s / +5 min, or operator triggers
`POST /api/osint/harvest {caseId, postUrl}` manually.

## Why this fits def/acc

| def/acc criterion | How Argus addresses it |
| --- | --- |
| Reduce harm at scale | Multi-agent early-warning pipeline triggered by a single intake. |
| Detect threats early | Sentinel's `trafficking_pattern_alert` correlates cases across geography + demography. |
| Resilient critical infrastructure | Overpass scan surfaces police / hospitals / shelters so response routes don't depend on stale gov databases. |
| Anti-disinformation / provenance | Every portrait gets a 3-signal verdict (EXIF + dHash + Gemini deepfake classifier) before agents act on it. |
| Human-in-the-loop | Operator co-pilot via Struere; every agent emits auditable `pipeline_events`. |
| Public, no-login OSINT | Ghost.social only touches indexed public posts; explicit hint when an SERP API key is missing. |

## Development

```bash
npm install
npm run dev     # localhost:3000
npm run build   # production build
```

Do **not** run `next build` while `next dev` is alive — `.next/` corrupts the dev server until cleared.

## License

MIT.
