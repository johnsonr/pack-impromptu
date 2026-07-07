# pack-impromptu

Classical / art-music companion for the Embabel assistant — grounded in the
works the user has rated, live Open Opus metadata, recordings on YouTube, and
public-domain scores on IMSLP.

This pack is the art-music analogue of [`pack-movie`](../pack-movie): where the
movie pack recommends films grounded in ratings + OMDb + streaming, this pack
recommends musical works grounded in ratings + Open Opus + YouTube + IMSLP. It
is a distillation of the standalone [`impromptu`](../impromptu) app (a Spring
Boot classical-music assistant with hand-coded actions, Neo4j persistence, and
its own UI) down to the things a pack can ship: APIs, types, a workflow skill,
and a personality. The chat LLM owns the workflow; the assistant owns the
persistence and the UI.

> **Requires [`pack-research`](../pack-research)** for the `youtube`
> recording search (`gateway.youtube.searchYouTubeVideos`). It's a vendored
> OpenAPI spec there — general enough to be shared, and deliberately not an MCP
> server. Without pack-research, everything else (work lookup, scores, ratings,
> recommendations) still works; only recording lookups go quiet.

## What's in the pack

| Directory | What it contributes |
|---|---|
| `apis/` | One OpenAPI 3 spec — **Open Opus** (`gateway.openopus.omnisearch`, free/no-auth work metadata). Recordings use **YouTube** (`gateway.youtube.searchYouTubeVideos`), a vendored OpenAPI spec that lives in **[pack-research](../pack-research)** (a shared, reusable capability — NOT MCP), so this pack **requires pack-research** installed. Calls go through the gateway from `execute_javascript`. |
| `types/music.yml` | `MusicalWork` (canonical metadata, keyed by Open Opus id) + `MusicalWorkRating` (the user's score), plus three **virtual** types materialized on demand: `MusicalRecording` (YouTube), `MusicalScore` (IMSLP), and the fan-in `MusicalTasteSummary`. Every type is `Musical*`-namespaced so it can't collide with another pack's `Work`/`Recording`/`Score`. |
| `producers/impromptu.yml` | The five virtual-join producers: `similarWorks` (generative `SIMILAR_TO`), `recordingsByWork` (remote `HAS_RECORDING` over YouTube), `scoresForWork` (web-grounded `HAS_SCORE` over IMSLP), `workTasteSummary` (aggregate `HAS_MUSICAL_TASTE_SUMMARY`), `tasteBasedWorks` (generative `SUGGESTS`). |
| `skills/music/` | One skill for everything: look up a work, find a recording or score, recommend, rate, recall. Owns the Open Opus + YouTube workflow and the cardinal rules (always search with `<composer> <title>`; never fabricate an id/recording/score). |
| `personalities/maestro/` | Concert-programme-note voice — used only by the recommendation / write-up path. Rate confirmations and recall replies stay in the default assistant voice. |
| `views/` , `lenses/` | Saved Cypher views (`WorkRecommendations`, `ListenableRecommendations`, `MyMusicTaste`, `TasteBasedRecommendations`, …) and JS lenses (`Rated Works`, `Recommendations You Can Hear`, `Your Music Taste`, `Top 3 — Scores`). |
| `focuses/music.yml` | `/focus music` — scopes chat to this pack + the `maestro` persona. |
| `apps/MusicalWork.component.js` | The `MusicalWork` entity card: play button (top YouTube recording), composer, genre badges, and a 1–10 rating widget. |
| `src/api/work.ts` | The **`MusicalWork` type** — a TypeScript class `extends Entity`. Fields are the shape; async methods (`work.recordings`, `work.details`, `work.rate`, inherited `work.neighbors`) are affordances callable on an in-scope object. Built to `dist/`. |

## Setup

- **Open Opus** needs no key.
- **YouTube** (recordings) is provided by **pack-research** — install it, then set an
  API key. Create one at [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
  with the **YouTube Data API v3** enabled, and set it on the assistant process:
  ```bash
  export YOUTUBE_API_KEY=...
  ```
  This is a deployment-level key (one Google Cloud project), not per-user OAuth.
- **IMSLP** needs no key — scores are found by an LLM with web search (`scoresForWork`),
  because IMSLP's own lookup is a multi-step MediaWiki crawl, not a single API call.

## How a work reaches its recordings and scores

A `MusicalWork` carries a `searchQuery` scalar (`"<composer> <title>"`). That single
string is the join key for both media edges, so the graph can go:

```
(MusicalWorkRating)-[:SIMILAR_TO]->(MusicalWork)-[:HAS_RECORDING]->(MusicalRecording)   # YouTube
                                   (MusicalWork)-[:HAS_SCORE]->(MusicalScore)            # IMSLP (web-grounded)
```

The recommendation producers (`similarWorks`, `tasteBasedWorks`) resolve each
LLM-suggested work name onto the Open Opus spine (so it dedupes against works the
user already rated) and stamp the suggested `<composer> <title>` as the new work's
`searchQuery` — so a recommended work can chain straight into its recording or score.

## Sample queries

Run these in the Cypher console (Settings → Data → **Query**). Each virtual edge
materializes on demand. Keep a virtual join in the **leading `MATCH` chain** (a join
after a `WITH` is not materialized), and put `LIMIT`/`ORDER BY` at the end.

**Instant (Neo4j only)**
```cypher
-- Your top-rated works
MATCH (me:AssistantUser)-[:RATED]->(r:MusicalWorkRating)
RETURN r.composer, r.title, r.rating ORDER BY r.rating DESC, r.title LIMIT 15
```

**Generative (SIMILAR_TO / fan-IN summary / two-stage SUGGESTS)**
```cypher
-- Recommendations from works you LOVED, excluding what you've rated
MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(w:MusicalWork)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN DISTINCT w.composer, w.title, w.genre LIMIT 15
```
```cypher
-- Your taste in ~100 words (a fan-IN aggregate node over all your ratings)
MATCH (me:AssistantUser)-[:HAS_MUSICAL_TASTE_SUMMARY]->(ts:MusicalTasteSummary)
RETURN ts.summary, ts.count
```
```cypher
-- Recommendations from your WHOLE taste (fan-IN summary → fan-OUT SUGGESTS)
MATCH (me:AssistantUser)-[:HAS_MUSICAL_TASTE_SUMMARY]->(ts:MusicalTasteSummary)
MATCH (ts)-[:SUGGESTS]->(w:MusicalWork)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN DISTINCT w.composer, w.title, w.genre
```

**Recordings (HAS_RECORDING → YouTube)**
```cypher
-- Recommendations you can listen to right now
MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(w:MusicalWork)-[:HAS_RECORDING]->(r:MusicalRecording)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN w.composer, w.title, collect(r.title)[0..2] AS recordings
```

**Web-grounded scores (HAS_SCORE → many MusicalScore nodes)**
```cypher
-- Public-domain scores of one work — pin the work by its searchQuery
MATCH (w:MusicalWork {searchQuery:'Beethoven Symphony no. 5 in C minor, op. 67'})-[:HAS_SCORE]->(s:MusicalScore)
RETURN s.title, s.description, s.url ORDER BY s.title
```

You can also click **Run** on the saved views in the console's **Views** tab, and
the lenses ship `Top 3 — Scores` (one pinned `HAS_SCORE` search per top-rated work,
since the engine can't bound a set of virtual works before a per-work web search).

## Type methods (`src/api/work.ts`)

`MusicalWork extends Entity`. Its async methods are affordances on an in-scope
work object:

- `work.recordings({ maxResults? })` → YouTube search for performances of the work.
- `work.details()` → re-resolve the work's Open Opus metadata.
- `work.rate({ rating, notes?, heardOn? })` → record a `MusicalWorkRating` (auto-links `RATED`).
- `work.neighbors({ hops })` → inherited graph walk from this work's node.

Build and test:

```bash
npm install
npm run typecheck
npm test          # vitest — methods run against a mocked gateway, no keys needed
npm run build     # tsc -> dist/ + manifest
```

## Why no separate Composer / Performer entities?

The `impromptu` app models a rich reference graph (Composer, Ensemble, Performer,
Epoch, Genre, Instrument, …). This pack deliberately keeps only `MusicalWork` and
the user's `MusicalWorkRating`: the composer and genre are denormalised onto the
work, recordings and scores are virtual (fetched on demand, never stored), and
anything about the *user's* taste is the DICE proposition graph's job — not a
second entity that drifts. If a deployment wants the full composer graph, that is
Open Opus bulk-population, a separate concern from this query-time pack.
