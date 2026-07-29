import { describe, expect, it } from "vitest";

import {
  createSceneEntity,
  decodeSceneEntityKey,
  encodeSceneEntityKey,
  sameSceneEntity,
  transitionSceneEntity,
  type SceneEntity,
} from "../apps/viewer/src/scene-entity.js";

describe("viewer scene entities", () => {
  it("creates the three discriminated entity variants", () => {
    expect(createSceneEntity("building", "building-a")).toEqual({
      kind: "building",
      id: "building-a",
    });
    expect(createSceneEntity("district", "district-a")).toEqual({
      kind: "district",
      id: "district-a",
    });
    expect(createSceneEntity("external", "external\0rxjs")).toEqual({
      kind: "external",
      id: "external\0rxjs",
    });
    expect(Object.isFrozen(createSceneEntity("building", "immutable"))).toBe(
      true,
    );
  });

  it("round-trips canonical keys without interpreting hostile plain text", () => {
    const hostileIds = [
      "<script>alert(1)</script>",
      "  surrounding whitespace  ",
      "contains\0nulls\0and:delimiters/%",
      "decomposed-e\u0301",
      "lone-surrogate-\ud800",
    ];

    for (const id of hostileIds) {
      for (const kind of ["building", "district", "external"] as const) {
        const entity = createSceneEntity(kind, id);
        const key = encodeSceneEntityKey(entity);

        expect(key).toBe(`${kind}\0${id}`);
        expect(decodeSceneEntityKey(key)).toEqual(entity);
      }
    }
  });

  it.each([
    undefined,
    null,
    42,
    {},
    "",
    "building",
    "\0id",
    "building\0",
    "repository\0id",
    " building\0id",
    "building:\0id",
  ])("rejects malformed key %# without throwing", (key) => {
    expect(decodeSceneEntityKey(key)).toBeNull();
  });

  it("rejects malformed identities at the encoding boundary", () => {
    expect(() => createSceneEntity("building", "")).toThrow(
      /non-empty string/u,
    );
    expect(() =>
      createSceneEntity("repository" as "building", "id"),
    ).toThrow(/unknown scene entity kind/iu);
    expect(() =>
      encodeSceneEntityKey({
        kind: "building",
        id: "",
      } as SceneEntity),
    ).toThrow(/non-empty string/u);
  });

  it("compares kind and exact ID rather than object identity", () => {
    const building = createSceneEntity("building", "same");
    expect(
      sameSceneEntity(building, createSceneEntity("building", "same")),
    ).toBe(true);
    expect(
      sameSceneEntity(building, createSceneEntity("district", "same")),
    ).toBe(false);
    expect(
      sameSceneEntity(building, createSceneEntity("building", "Same")),
    ).toBe(false);
    expect(sameSceneEntity(null, null)).toBe(true);
    expect(sameSceneEntity(building, null)).toBe(false);
  });

  it("models unchanged, entered, cleared, and replaced transitions", () => {
    const building = createSceneEntity("building", "building-a");
    const equalBuilding = createSceneEntity("building", "building-a");
    const external = createSceneEntity("external", "package");

    expect(transitionSceneEntity(null, null)).toEqual({
      kind: "unchanged",
      current: null,
    });
    expect(transitionSceneEntity(building, equalBuilding)).toEqual({
      kind: "unchanged",
      current: building,
    });
    expect(transitionSceneEntity(null, building)).toEqual({
      kind: "entered",
      current: building,
    });
    expect(transitionSceneEntity(building, null)).toEqual({
      kind: "cleared",
      previous: building,
    });
    expect(transitionSceneEntity(building, external)).toEqual({
      kind: "replaced",
      previous: building,
      current: external,
    });
  });
});
