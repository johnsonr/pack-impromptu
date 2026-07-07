import { Entity } from "@embabel/runtime-types";

// ─── Data shapes ────────────────────────────────────────────────────────────
// Plain records the methods read or write. They have no behaviour of their own,
// so they stay interfaces and live beside the `MusicalWork` type that uses them.

/**
 * The current user's rating of a MusicalWork. Identity is `workId`; the framework
 * anchors it to the user via `RATED` on createEntry, so one row per (user, work) —
 * a re-rate updates in place. Canonical schema lives in `types/music.yml`; this is
 * the slice `MusicalWork.rate` writes.
 */
export interface MusicalWorkRating {
  /** Open Opus id of the rated work — the identity key (same value as MusicalWork.workId). */
  workId: string;
  /** Title, denormalised for cheap recall without a join. */
  title?: string;
  /** Composer, denormalised for cheap recall. */
  composer?: string;
  /** Score from 1 (couldn't stand it) to 10 (masterpiece). Whole numbers only. */
  rating: number;
  /** Optional one-line reaction in the user's own words. */
  notes?: string;
  /** Optional ISO-8601 date the user last heard the work. */
  heardOn?: string;
}

/** One YouTube search hit — the slice the pack reads from `search.list`. */
export interface YouTubeSearchItem {
  id?: { kind?: string; videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    thumbnails?: { medium?: { url?: string } };
  };
}

/** The YouTube `search.list` response — the slice the pack reads. */
export interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
}

/** One Open Opus omnisearch hit: always a composer, plus a work when the hit is a work. */
export interface OmnisearchHit {
  composer?: { id?: string; name?: string; complete_name?: string; epoch?: string };
  work?: {
    id?: string;
    title?: string;
    subtitle?: string;
    genre?: string;
    popular?: string;
  } | null;
}

/** The Open Opus omnisearch response — the slice the pack reads. */
export interface OmnisearchResponse {
  results?: OmnisearchHit[];
}

/** What the workspace repository returns when a MusicalWorkRating is created or updated. */
export interface RatingEntry {
  id: string;
}

/**
 * The gateway ops `MusicalWork` calls, typed. Until `embabel-pack sync` generates
 * the host's fully-typed `GatewayContext`, a pack types the slice it uses itself and
 * reads it through {@link MusicalWork.api}, so method bodies and return types are
 * fully typed (no `unknown`). Swap this for the generated surface when `sync` lands.
 */
interface ImpromptuGateway {
  youtube: {
    searchYouTubeVideos(args: {
      q: string;
      part?: string;
      type?: string;
      videoEmbeddable?: string;
      maxResults?: number;
    }): Promise<YouTubeSearchResponse>;
  };
  openopus: { omnisearch(args: { query: string; offset: number }): Promise<OmnisearchResponse> };
  repository: { createEntry(args: { type: string; data: MusicalWorkRating }): Promise<RatingEntry> };
}

// ─── The type ───────────────────────────────────────────────────────────────

/**
 * A classical musical work in the knowledge graph. Identity is `workId` (the Open
 * Opus id).
 *
 * Extending `Entity` is the whole declaration: it makes the host recognise
 * `MusicalWork` as a type, hydrates an in-scope object's fields onto `this`, and
 * gives it `neighbors()` for free. Each async method below is an affordance callable
 * on that object — `work.recordings({})` — with no `ctx`/`self` plumbing: `this` is
 * the work, `this.api` reaches the APIs the pack brings in (where the credentials
 * live, server-side).
 */
export class MusicalWork extends Entity {
  /** Open Opus work id — the identity key (e.g. "16406"). */
  workId!: string;
  title?: string;
  subtitle?: string;
  composer?: string;
  composerId?: string;
  genre?: string;
  /** '<composer> <title>' — the string used to search YouTube / IMSLP for this work. */
  searchQuery?: string;

  /** The injected gateway, typed to the ops this pack uses. */
  private get api(): ImpromptuGateway {
    return this.gateway as unknown as ImpromptuGateway;
  }

  /** The best free-text query for this work: its stored searchQuery, else composer + title. */
  private query(): string {
    return this.searchQuery || [this.composer, this.title].filter(Boolean).join(" ");
  }

  /**
   * Recordings (performances) of this work on YouTube. Returns the raw
   * `search.list` response; each `items[].id.videoId` gives a watch URL of
   * `https://www.youtube.com/watch?v=<videoId>`.
   */
  async recordings(args?: { maxResults?: number }): Promise<YouTubeSearchResponse> {
    return this.api.youtube.searchYouTubeVideos({
      q: this.query(),
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: (args && args.maxResults) || 8,
    });
  }

  /**
   * Fresh Open Opus metadata for this work (re-resolves it by its search string).
   */
  async details(): Promise<OmnisearchResponse> {
    return this.api.openopus.omnisearch({ query: this.query(), offset: 0 });
  }

  /**
   * Record the user's rating of this work (1–10). Recording IS making the link:
   * createEntry against MusicalWorkRating auto-emits (User)-[:RATED]->(MusicalWorkRating)
   * and upserts by workId, so a re-rate updates in place. The same gateway op the
   * card's star widget calls.
   */
  async rate(args: { rating: number; notes?: string; heardOn?: string }): Promise<RatingEntry> {
    const data: MusicalWorkRating = {
      workId: this.workId,
      title: this.title,
      composer: this.composer,
      rating: args.rating,
      notes: args.notes,
      heardOn: args.heardOn,
    };
    return this.api.repository.createEntry({ type: "MusicalWorkRating", data });
  }
}
