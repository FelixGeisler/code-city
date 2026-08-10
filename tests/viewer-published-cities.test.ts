import { promises as fs } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PublishedCitiesApi } from "../apps/viewer/src/published-cities-api.js";

const publicationId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";

function publication() {
  return {
    id: publicationId,
    title: "Published demo",
    description: "Fixed snapshot",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:01:00.000Z",
    latestVersionId: versionId,
    latestUrl: `/?published=${publicationId}`,
    versions: [
      {
        id: versionId,
        publishedAt: "2026-08-10T10:01:00.000Z",
        generatedAt: "2026-08-10T09:59:00.000Z",
        model: { size: 123, sha256: "a".repeat(64) },
        evolution: {
          size: 456,
          sha256: "b".repeat(64),
          frameCount: 100,
          deltaCount: 99,
        },
        modelVersion: "abc123",
        districtCount: 12,
        buildingCount: 345,
        modelUrl:
          `/api/v1/published/${publicationId}/versions/${versionId}/city-model.json`,
        evolutionUrl:
          `/api/v1/published/${publicationId}/versions/${versionId}/evolution.json`,
        viewerUrl: `/?published=${publicationId}&version=${versionId}`,
      },
    ],
  };
}

describe("published cities viewer", () => {
  it("presents immutable freshness, sharing, and lifecycle controls", async () => {
    const html = await fs.readFile("apps/viewer/index.html", "utf8");
    expect(html).toContain('id="published-cities-open"');
    expect(html).toContain('id="published-cities-dialog"');
    expect(html).toContain("Publications are snapshots and are not automatically updated.");
    expect(html).toContain('id="published-city-submit"');
    expect(html).toContain('id="published-city-search"');
    expect(html).toContain('id="published-city-sort"');
    expect(html).toContain('maxlength="120"');
    expect(html).toContain('maxlength="1000"');
  });

  it("strictly loads public metadata without browser credentials", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(JSON.stringify({ publications: [publication()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = new PublishedCitiesApi(fetchImplementation);
    await expect(api.list()).resolves.toEqual([publication()]);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/v1/published",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
      }),
    );
  });

  it("rejects substituted artifact paths in public metadata", async () => {
    const unsafe = publication();
    unsafe.versions[0]!.modelUrl = "https://attacker.invalid/model.json";
    const api = new PublishedCitiesApi(async () =>
      new Response(JSON.stringify({ publications: [unsafe] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(api.list()).rejects.toThrow(
      "Published city version is invalid.",
    );
  });
});
