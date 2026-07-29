import { promises as fs } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  nextBoundedResultLimit,
  VIEWER_WORKSPACE_VIEWS,
  type ViewerWorkspaceView,
  workspaceViewForNavigation,
} from "../apps/viewer/src/viewer-workspace.js";

const viewerRoot = path.resolve("apps/viewer");
let html = "";
let css = "";

beforeAll(async () => {
  [html, css] = await Promise.all([
    fs.readFile(path.join(viewerRoot, "index.html"), "utf8"),
    fs.readFile(path.join(viewerRoot, "src/styles.css"), "utf8"),
  ]);
});

describe("viewer workspace navigation", () => {
  it("reveals bounded result chunks without crossing hard caps", () => {
    expect(nextBoundedResultLimit(8, 24, 8)).toBe(16);
    expect(nextBoundedResultLimit(16, 24, 8)).toBe(24);
    expect(nextBoundedResultLimit(24, 24, 8)).toBe(24);
    expect(() => nextBoundedResultLimit(8, 24, 0)).toThrow(
      RangeError,
    );
  });

  it("wraps predictably and supports Home and End", () => {
    expect(
      workspaceViewForNavigation("find", "ArrowLeft"),
    ).toBe("legend");
    expect(
      workspaceViewForNavigation("legend", "ArrowRight"),
    ).toBe("find");
    expect(workspaceViewForNavigation("routes", "Home")).toBe("find");
    expect(workspaceViewForNavigation("routes", "End")).toBe("legend");
  });

  it("moves through every view in stable order", () => {
    let view: ViewerWorkspaceView = VIEWER_WORKSPACE_VIEWS[0];
    const visited: ViewerWorkspaceView[] = [view];
    for (let index = 1; index < VIEWER_WORKSPACE_VIEWS.length; index += 1) {
      view = workspaceViewForNavigation(view, "ArrowRight");
      visited.push(view);
    }
    expect(visited).toEqual(VIEWER_WORKSPACE_VIEWS);
  });
});

describe("viewer workspace markup", () => {
  it("provides four labelled tabs and mounted tab panels", () => {
    for (const view of VIEWER_WORKSPACE_VIEWS) {
      expect(html).toContain(`id="viewer-tab-${view}"`);
      expect(html).toContain(`data-workspace-view="${view}"`);
      expect(html).toContain(`id="viewer-view-${view}"`);
      expect(html).toContain(`data-workspace-panel="${view}"`);
      expect(html).toMatch(
        new RegExp(
          `id="viewer-view-${view}"[\\s\\S]*?role="tabpanel"[\\s\\S]*?aria-labelledby="viewer-tab-${view}"`,
          "u",
        ),
      );
    }
    expect(html).toContain('id="viewer-workspace-toggle"');
    expect(html).toContain('aria-controls="viewer-workspace-scroll"');
  });

  it("keeps every eagerly required legacy element exactly once", () => {
    const requiredIds = [
      "find-panel",
      "building-search",
      "search-status",
      "search-results",
      "isolate-district",
      "show-whole-city",
      "district-routes-toggle",
      "district-routes-list",
      "district-routes-show-more",
      "district-route-details",
      "inspector-empty",
      "inspector-content",
      "district-inspector-content",
      "external-inspector-content",
      "clear-selection",
      "dependency-list",
      "dependency-show-more",
      "building-units",
      "building-units-show-more",
      "legend",
      "external-zone",
      "external-list",
      "print-export-open",
      "print-export-dialog",
    ];

    for (const id of requiredIds) {
      expect(
        html.match(new RegExp(`id="${id}"`, "gu"))?.length ?? 0,
        id,
      ).toBe(1);
    }
  });

  it("uses one workspace scroll owner and no redundant list tab stops", () => {
    expect(css.match(/overflow-y:\s*auto/gu)).toHaveLength(1);
    expect(css).toMatch(
      /\.viewer-workspace-scroll\s*\{[\s\S]*?overflow-y:\s*auto/u,
    );
    for (const id of [
      "district-routes-list",
      "district-route-contributors",
      "dependency-list",
      "inspector-content",
      "district-inspector-content",
      "external-inspector-content",
      "legend",
    ]) {
      expect(html).not.toMatch(
        new RegExp(`id="${id}"[^>]*tabindex=`, "u"),
      );
    }
  });

  it("exposes a visible keyboard button for the local model picker", () => {
    expect(html).toMatch(
      /<button[\s\S]*?id="model-file-open"[\s\S]*?>[\s\S]*?Open model[\s\S]*?<\/button>/u,
    );
    expect(html).toMatch(
      /<input[\s\S]*?id="model-file"[\s\S]*?type="file"/u,
    );
  });

  it("docks beside the scene and becomes a collapsible mobile sheet", () => {
    expect(css).toMatch(
      /@media \(min-width: 1100px\)[\s\S]*?#viewport[\s\S]*?grid-template-columns/u,
    );
    expect(css).toMatch(
      /@media \(min-width: 1100px\)[\s\S]*?#viewport[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.viewer-workspace[\s\S]*?height:\s*min\(62dvh,\s*560px\)/u,
    );
    expect(css).toContain(
      '.viewer-workspace[data-collapsed="true"]',
    );
  });
});
