/**
 * Tests for the `MusicalWork` type's methods. Each runs against a MOCKED gateway
 * (no live server, no API keys): `entityForTest` builds a real `MusicalWork` with
 * its fields set and the mock gateway injected — exactly what the host does at
 * runtime — so the method under test runs unchanged. We then assert it called the
 * right underlying gateway op with the right args.
 */
import { describe, it, expect, vi } from "vitest";
import { entityForTest, mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { MusicalWork } from "../src/api/work";

describe("MusicalWork.recordings", () => {
  it("searches YouTube for the work's stored searchQuery, embeddable videos only", async () => {
    const searchYouTubeVideos = vi.fn().mockResolvedValue({ items: [{ id: { videoId: "abc123" } }] });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", searchQuery: "Beethoven Symphony no. 5 in C minor" },
      mockGateway<GenericGatewayContext>({ youtube: { searchYouTubeVideos } }),
    );

    const r = await work.recordings();

    expect(searchYouTubeVideos).toHaveBeenCalledWith({
      q: "Beethoven Symphony no. 5 in C minor",
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: 8,
    });
    expect(r).toMatchObject({ items: [{ id: { videoId: "abc123" } }] });
  });

  it("falls back to composer + title when searchQuery is absent", async () => {
    const searchYouTubeVideos = vi.fn().mockResolvedValue({ items: [] });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", composer: "Beethoven", title: "Symphony no. 5" },
      mockGateway<GenericGatewayContext>({ youtube: { searchYouTubeVideos } }),
    );

    await work.recordings({ maxResults: 3 });

    expect(searchYouTubeVideos).toHaveBeenCalledWith({
      q: "Beethoven Symphony no. 5",
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: 3,
    });
  });
});

describe("MusicalWork.details", () => {
  it("re-resolves the work via Open Opus omnisearch on its search string", async () => {
    const omnisearch = vi.fn().mockResolvedValue({ results: [{ work: { id: "16406" } }] });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", searchQuery: "Beethoven Symphony no. 5" },
      mockGateway<GenericGatewayContext>({ openopus: { omnisearch } }),
    );

    const r = await work.details();

    expect(omnisearch).toHaveBeenCalledWith({ query: "Beethoven Symphony no. 5", offset: 0 });
    expect(r).toMatchObject({ results: [{ work: { id: "16406" } }] });
  });
});

describe("MusicalWork.rate", () => {
  it("attributes the rating to the current user with a rater-inclusive identity key", async () => {
    const createEntry = vi.fn().mockResolvedValue({ id: "wr1" });
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "rod_johnson_assistant", name: "Rod Johnson" }] });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", title: "Symphony no. 5 in C minor, op. 67", composer: "Beethoven" },
      mockGateway<GenericGatewayContext>({ repository: { createEntry }, kg: { query } }),
    );

    await work.rate({ rating: 9, notes: "the four notes" });

    expect(createEntry).toHaveBeenCalledWith({
      type: "MusicalWorkRating",
      data: {
        ratingKey: "rod_johnson_assistant::16406",
        raterId: "rod_johnson_assistant",
        raterName: "Rod Johnson",
        workId: "16406",
        title: "Symphony no. 5 in C minor, op. 67",
        composer: "Beethoven",
        rating: 9,
        notes: "the four notes",
        heardOn: undefined,
      },
    });
  });
});

describe("MusicalWork.neighbors (inherited from Entity)", () => {
  it("walks the graph from this work's id via kg.neighbors — no per-type code", async () => {
    const neighbors = vi.fn().mockResolvedValue([{ id: "c1", label: "Composer", name: "Beethoven" }]);
    const work = entityForTest(
      MusicalWork,
      { id: "work-16406", workId: "16406" },
      mockGateway<GenericGatewayContext>({ kg: { neighbors } }),
    );

    const r = await work.neighbors({ hops: 2 });

    expect(neighbors).toHaveBeenCalledWith({ id: "work-16406", hops: 2 });
    expect(r).toMatchObject([{ name: "Beethoven" }]);
  });
});
