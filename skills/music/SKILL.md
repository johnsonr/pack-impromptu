---
name: music
description: Classical / art music — work facts (this pack's Open Opus source is authoritative, NOT web search), recordings (YouTube), scores (IMSLP), recommendations, and ratings. Activate for ANY classical-music request; it returns the methods and rules to follow.
---

# Classical music

One skill for everything classical-music-related. The pack ships one API
(`openopus`), the `MusicalWork` and `MusicalWorkRating` workspace types (plus
virtual `MusicalRecording` / `MusicalScore`), and the `maestro` personality
(concert-programme voice for write-ups). Recordings call `gateway.youtube.…`,
which lives in **pack-research** (required for recordings only).

All API calls go through `gateway.<ns>.<method>(args)` from inside
`execute_javascript` — never as top-level tools.

| Surface | Shape |
|---|---|
| `gateway.openopus.omnisearch({ query, offset })` | Free-text "composer + work" search, e.g. `{ query: "Beethoven Symphony 5", offset: 0 }`. Returns `{ results: [{ composer, work }] }` — take the FIRST result whose `work` is non-null. |
| `gateway.youtube.searchYouTubeVideos({ q, part, type, videoEmbeddable, maxResults })` | YouTube video search for recordings (vendored in pack-research — REQUIRES it installed). `q` is `"<composer> <title>"`. Watch URL = `https://www.youtube.com/watch?v=` + `items[].id.videoId`. |
| `gateway.kg.query({ cypher, params })` | Cypher — for recommendations (`SIMILAR_TO`) and scores (`HAS_SCORE`, web-grounded). |
| `gateway.repository.listEntries({ type })` | Read workspace entries. **Call the named methods — `gateway.repository.listEntries(...)`, not `gateway.repository(...)`.** |
| `gateway.repository.createEntry({ type, data, relations })` | Create/merge an entry (MERGEs on the identity key). |

## Look up a work — "tell me about X", who wrote it, what genre

This is the default for any factual question about a specific work.

```js
const res = await gateway.openopus.omnisearch({ query: "Sibelius Violin Concerto", offset: 0 });
const hit = (res.results || []).find((r) => r.work && r.work.id);
if (!hit) return `Open Opus has no work matching that — ask the user to confirm composer and title.`;
const work = hit.work, composer = hit.composer;
// Answer from the structured record: work.title, work.subtitle, work.genre, composer.name,
// composer.complete_name, composer.epoch. Authoritative for work facts — prefer it over web search.
```

To keep the work in scope for follow-ups ("find me a recording", "is there a
score"), **create it** — that also sets its `searchQuery`, the key the recording
and score joins need:

```js
const searchQuery = `${composer.name} ${work.title}`;
await gateway.repository.createEntry({ type: "MusicalWork", data: {
  workId: work.id, title: work.title, subtitle: work.subtitle, composer: composer.name,
  composerId: composer.id, genre: work.genre, popular: work.popular === "1", searchQuery,
} });
```

## "Find me a recording of X" / "where can I hear X"

Search YouTube with the work's `<composer> <title>` string:

```js
const q = "Beethoven Symphony no. 5 in C minor";   // composer + title
const res = await gateway.youtube.searchYouTubeVideos({ q, part: "snippet", type: "video", videoEmbeddable: "true", maxResults: 8 });
const items = res.items || [];
// Each item: id.videoId, snippet.title, snippet.channelTitle, snippet.description, snippet.thumbnails.medium.url.
// Build the watch URL: "https://www.youtube.com/watch?v=" + item.id.videoId.
```

Prefer results whose channel or title names a real orchestra / conductor /
soloist. **If the call errors, SAY the tool failed — never substitute web search
and never invent a video id or link.** If the user adds a performer ("the
Karajan one"), append it to `q`.

## "Is there a score for X?" (IMSLP)

Scores are a web-grounded virtual join (`HAS_SCORE`), so pin the work by its
`searchQuery` and traverse:

```js
const q = "Beethoven Symphony no. 5 in C minor";   // the work's searchQuery
const esc = q.replace(/'/g, "\\'");
const rows = await gateway.kg.query({
  cypher: `MATCH (w:MusicalWork {searchQuery:'${esc}'})-[:HAS_SCORE]->(s:MusicalScore)
           RETURN s.title AS title, s.description AS description, s.url AS url, s.pageUrl AS pageUrl
           ORDER BY s.title ASC`,
  params: JSON.stringify({}),
});
// A web search runs — give it ~30–60s. Present each as a markdown link to s.url (the PDF) or s.pageUrl.
```

Only IMSLP, public-domain scores are returned. If none come back, say so — don't
point at a paywalled edition or invent a link.

## "What should I listen to?" — a recommendation

1. **Exclude what they've rated:** `gateway.repository.listEntries({ type: "MusicalWorkRating" })`,
   read `workId`/`rating`. Empty is fine.
2. **Honour preferences** from the user's profile (composers, eras, forms they love, the instrument
   they play) in your context. If vague ("something good"), ask ONE clarifying question first.
3. Use the graph to generate grounded picks from what they've LOVED:
   ```js
   const rows = await gateway.kg.query({
     cypher: `MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
              MATCH (rt)-[:SIMILAR_TO]->(w:MusicalWork)
              WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
              RETURN DISTINCT w.title AS title, w.composer AS composer, w.genre AS genre
              ORDER BY w.composer LIMIT 12`,
     params: JSON.stringify({}),
   });
   // This is generative (an LLM materializes SIMILAR_TO) — ~20–40s. If the user has no ratings yet,
   // suggest a few from their profile and OFFER to record ratings so future picks get better.
   ```
4. **Write up the top 3** in the `maestro` voice — one sound-led paragraph each, with a recording
   link (search YouTube for each) and, if they play/study, a score link.

## Asking the user to choose — `choices` payloads

Whenever a flow needs the user to pick from a small closed set (a score, one of
several matching works), do NOT guess, do NOT pick silently, and do NOT bury the
options in prose. Instead the script RETURNS a `choices` payload as its result,
and you then present the question and options to the user and STOP — take no
recording/lookup action until they pick. The structured result lets a client
that can render forms show one; everywhere else, present the options as a short
list. The payload shape:

```json
{"kind": "choices",
 "question": "<one short question>",
 "options": ["<option>", "..."],
 "context": { "<ids the follow-up turn needs>": "..." },
 "hint": "Present these options to the user and wait for their pick."}
```

Carry the ids the next turn needs in `context` so you never re-resolve.

### Work named, NO score yet — "Rate Brahms 4 for me", "I heard the Sibelius concerto last night"

Resolve the work via Open Opus first (disambiguates and yields the stable work id),
then return the choices payload and wait:

```js
const userWork = "Brahms Symphony 4";
const res = await gateway.openopus.omnisearch({ query: userWork, offset: 0 });
const hit = (res.results || []).find((r) => r.work && r.work.id);
if (!hit) return `No work matching "${userWork}" on Open Opus — confirm the composer and title.`;
const work = hit.work, composer = hit.composer;
return JSON.stringify({
  kind: "choices",
  question: `How would you rate ${composer.name} — ${work.title}?`,
  options: ["1","2","3","4","5","6","7","8","9","10"],
  context: { workId: work.id, title: work.title, subtitle: work.subtitle, composer: composer.name,
             composerId: composer.id, genre: work.genre, popular: work.popular === "1",
             searchQuery: `${composer.name} ${work.title}` },
  hint: "Present these options to the user and wait for their pick, then record the rating.",
});
```

When the user answers with a score, record it with the rating script below —
but build both entries from `context` and SKIP the Open Opus re-lookup.

### Several works match — "the Brahms serenade", "a Bach partita"

When `omnisearch` returns more than one plausible work and the user's words
don't settle it (opus number, key, nickname, instrument):

```js
const res = await gateway.openopus.omnisearch({ query: "Brahms Serenade", offset: 0 });
const hits = (res.results || []).filter((r) => r.work && r.work.id).slice(0, 5);
if (hits.length > 1) return JSON.stringify({
  kind: "choices",
  question: `Which work do you mean?`,
  options: hits.map((r) => `${r.composer.name} — ${r.work.title}${r.work.subtitle ? " (" + r.work.subtitle + ")" : ""}`),
  context: { candidates: hits.map((r) => ({ workId: r.work.id, title: r.work.title, subtitle: r.work.subtitle,
                                            composer: r.composer.name, composerId: r.composer.id,
                                            genre: r.work.genre, popular: r.work.popular === "1" })) },
  hint: "Present these options to the user and wait for their pick, then continue with that work's workId.",
});
```

Then continue the original request (lookup, recording, score, rating) with the
chosen candidate from `context` — no re-lookup.

## "I gave X a 9" — record a rating

A rating belongs to a PERSON. For the current user, resolve their own id and build the
rater-inclusive identity key. Run as one `execute_javascript` and reply with **exactly the
string it returns**. (If the user named a work but gave NO score, do not run this yet —
see "Asking the user to choose" above.)

```js
const userWork = "Brahms Symphony 4", rating = 9;   // whole number 1–10
const res = await gateway.openopus.omnisearch({ query: userWork, offset: 0 });
const hit = (res.results || []).find((r) => r.work && r.work.id);
if (!hit) return `No work matching "${userWork}" on Open Opus — confirm the composer and title.`;
const work = hit.work, composer = hit.composer, searchQuery = `${composer.name} ${work.title}`;
// The rater is the current user (also a Person node). ratingKey = "<myId>::<workId>".
const meRows = await gateway.kg.query({ cypher: "MATCH (me:AssistantUser) RETURN me.id AS id, me.name AS name LIMIT 1", params: JSON.stringify({}) });
const me = ((meRows && meRows.rows) ? meRows.rows[0] : (meRows && meRows[0])) || {};
await gateway.repository.createEntry({ type: "MusicalWork", data: {
  workId: work.id, title: work.title, subtitle: work.subtitle, composer: composer.name,
  composerId: composer.id, genre: work.genre, popular: work.popular === "1", searchQuery } });
await gateway.repository.createEntry({ type: "MusicalWorkRating",
  data: { ratingKey: `${me.id}::${work.id}`, raterId: me.id, raterName: me.name,
          workId: work.id, title: work.title, composer: composer.name, rating },   // add notes/heardOn if given
  relations: [{ predicate: "OF", to: { type: "MusicalWork", workId: work.id } }] });
return `Saved ${composer.name} — ${work.title} — ${rating}/10.`;
```

Ratings are whole numbers 1–10 (round a half and confirm). The `(me)-[:RATED]->(MusicalWorkRating)`
edge is added automatically for the current user — don't add it.

**Recording a rating for SOMEONE ELSE** ("Ada gave Brahms 4 a 9"): the data model supports it —
`MusicalWorkRating` carries `raterId`/`raterName` and hangs off any `Person` by
`(Person)-[:RATED]->(rating)`, so cross-person views work. But `create_entry` only auto-anchors the
CURRENT user (and its `relations` create outgoing edges only), so it can't yet build the
`(otherPerson)-[:RATED]->` edge. Until the host adds an anchor-on-person path, attributing a rating
to another person is a **seeding** operation, not a chat one — tell the user that plainly rather than
recording it under their own name.

## "What have I rated?" / "What did I think of X?"

`gateway.repository.listEntries({ type: "MusicalWorkRating" })` — optionally
filter by title/composer substring or `workId`. Report the score and quote any
`notes` verbatim. If nothing matches, say so plainly — never invent a rating.
For cross-cuts (highest-rated chamber works, loved-and-hearable), use the Cypher
tool; the canonical shape is
`(User)-[:RATED]->(r:MusicalWorkRating)-[:OF]->(w:MusicalWork)`.

## Always

- **Never fabricate** an Open Opus id, opus number, recording, score, or rating —
  each comes from a real `openopus` / `youtube` / web-grounded call.
- For work FACTS, `openopus` is authoritative — prefer it over web search.
- Use the `maestro` voice only for recommendation / programme-note write-ups; stay
  in the default voice for facts, status, and clarifications.
