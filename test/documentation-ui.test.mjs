import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const partialPath = path.join(projectRoot, "docs", "ui", "partials", "head-icons.hbs");
const logoPath = path.join(projectRoot, "docs", "ui", "img", "code-city.svg");
const expectedLogoUrl = "https://felixgeisler.github.io/code-city/_/img/code-city.svg";

function linkAttributes(rendered) {
  assert.match(rendered, /^<link\s[^>]*>\s*$/u);
  return Object.fromEntries(
    [...rendered.matchAll(/\b([\w:-]+)="([^"]*)"/gu)].map((match) => [match[1], match[2]]),
  );
}

test("the favicon partial renders the SVG link relative to root and deep documentation pages", async () => {
  const render = Handlebars.compile(await readFile(partialPath, "utf8"));
  const pages = [
    {
      name: "component root",
      pageUrl: "https://felixgeisler.github.io/code-city/code-city/",
      uiRootPath: "../_",
    },
    {
      name: "deep architecture page",
      pageUrl: "https://felixgeisler.github.io/code-city/code-city/architecture/07-deployment-view/",
      uiRootPath: "../../../_",
    },
  ];

  for (const page of pages) {
    const attributes = linkAttributes(render({ uiRootPath: page.uiRootPath }));
    assert.deepEqual(attributes, {
      rel: "icon",
      type: "image/svg+xml",
      sizes: "any",
      href: `${page.uiRootPath}/img/code-city.svg`,
    }, page.name);
    assert.equal(new URL(attributes.href, page.pageUrl).href, expectedLogoUrl, page.name);
  }
});

test("the logo is the selected scalable, self-contained static SVG", async () => {
  const logo = await readFile(logoPath);
  const svg = logo.toString("utf8");

  assert.equal(
    createHash("sha256").update(logo).digest("hex"),
    "cde71f60f1adbe5b0f5b432f1011f782c728778229eba2b4324515b1d7a1a79a",
  );
  assert.match(svg, /<svg\b[^>]*\bviewBox="0 0 64 64"[^>]*>/u);
  assert.doesNotMatch(
    svg,
    /<script\b|<foreignObject\b|<iframe\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|\burl\s*\(/iu,
  );
});
