import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const viewerRoot = path.resolve("apps/viewer");

describe("viewer project import UI", () => {
  it("documents close and cancellation as distinct lifecycle actions", async () => {
    const runtimeGuide = await fs.readFile(
      path.resolve(
        "docs/modules/ROOT/pages/06-runtime-view.adoc",
      ),
      "utf8",
    );

    expect(runtimeGuide).toMatch(
      /Closing the dialog cancels unfinished local-directory packaging; otherwise it\s+only hides the wizard/u,
    );
    expect(runtimeGuide).toMatch(
      /Closing or navigating away from the page\s+stops browser requests and polling without issuing server cancellation/u,
    );
    expect(runtimeGuide).toMatch(
      /explicit \*Cancel import\* action abandons a live reservation or,\s+once acceptance is known, deletes the job/u,
    );
    expect(runtimeGuide).toMatch(
      /explicit \*Sign out\* action revokes the HttpOnly browser\s+session, clears the saved import-job UUID/u,
    );
  });

  it("exposes an accessible import wizard and every supported source", async () => {
    const html = await fs.readFile(
      path.join(viewerRoot, "index.html"),
      "utf8",
    );

    expect(html).toContain('id="project-import-open"');
    expect(html).toContain('id="project-import-sign-out"');
    expect(html).toMatch(
      /<dialog[\s\S]*id="project-import-dialog"[\s\S]*aria-labelledby="project-import-title"[\s\S]*aria-describedby="project-import-privacy"/u,
    );
    for (const source of [
      "directory",
      "zip",
      "github-public",
      "github-authenticated",
      "azure-devops",
      "git",
      "city-model",
    ]) {
      expect(html).toContain(`value="${source}"`);
    }
    expect(html).toMatch(
      /id="project-import-directory"[\s\S]*type="file"[\s\S]*webkitdirectory[\s\S]*multiple/u,
    );
    expect(html).toContain('id="project-import-zip"');
    expect(html).toContain('id="project-import-model"');
    expect(html).toContain('id="project-import-profile"');
    expect(html).toContain('value="branch"');
    expect(html).toContain('value="tag"');
    expect(html).toContain('value="commit"');
    expect(html).toContain('id="project-import-progress-meter"');
    expect(html).toContain('id="project-import-cancel"');
    expect(html).toMatch(
      /id="project-import-retry"[\s\S]*id="project-import-restart"[\s\S]*Start another import/u,
    );
    expect(html).toContain('id="project-import-live-status"');
    expect(html).toContain('aria-live="polite"');
    for (const heading of [
      "source",
      "details",
      "options",
      "progress",
    ]) {
      expect(html).toMatch(
        new RegExp(
          `id="project-import-${heading}-title"\\s+tabindex="-1"`,
          "u",
        ),
      );
    }
    expect(html).toMatch(
      /id="project-import-max-files"[\s\S]*max="50000"/u,
    );
    expect(html).toMatch(
      /id="project-import-max-file-mib"[\s\S]*max="2"/u,
    );
    expect(html).toMatch(
      /id="project-import-max-total-mib"[\s\S]*max="256"/u,
    );
    expect(html).toMatch(
      /id="project-import-timeout-seconds"[\s\S]*max="300"/u,
    );
    expect(html).toMatch(
      /City version[\s\S]*optional; requires a city title[\s\S]*id="project-import-version-help"/u,
    );
    for (const id of [
      "project-import-max-files",
      "project-import-max-file-mib",
      "project-import-max-total-mib",
      "project-import-timeout-seconds",
    ]) {
      expect(html).toMatch(
        new RegExp(
          `id="${id}"[^>]*aria-describedby="project-import-analysis-help project-import-error-analysis"`,
          "u",
        ),
      );
    }
    expect(html).toMatch(
      /id="project-import-persistence-warning"[\s\S]*role="status"/u,
    );
    expect(html).toMatch(
      /Repository credentials[\s\S]*never[\s\S]*stored in this browser\./u,
    );
  });

  it("uses one module worker and never stores access or repository data", async () => {
    const [dialogSource, archiveClient, controllerSource] =
      await Promise.all([
        fs.readFile(
          path.join(viewerRoot, "src/project-import-dialog.ts"),
          "utf8",
        ),
        fs.readFile(
          path.join(
            viewerRoot,
            "src/project-directory-archive-client.ts",
          ),
          "utf8",
        ),
        fs.readFile(
          path.join(viewerRoot, "src/import-controller.ts"),
          "utf8",
        ),
      ]);

    expect(archiveClient).toContain(
      'new URL("./project-directory-archive-worker.ts", import.meta.url)',
    );
    expect(archiveClient).toContain('type: "module"');
    expect(dialogSource).toContain('tokenInput.value = ""');
    expect(dialogSource).toContain("scrubAcceptedSubmission(state.job.id)");
    expect(dialogSource).toContain('repositoryUrlInput.value = ""');
    expect(dialogSource).toContain('profileSelect.value = ""');
    expect(dialogSource).toContain('directoryInput.value = ""');
    expect(dialogSource).toMatch(
      /signOutButton\.addEventListener\("click",[\s\S]*cancelPackaging\(\)[\s\S]*controller\.logout\(\)/u,
    );
    expect(dialogSource).not.toContain(
      'form.setAttribute("aria-busy"',
    );
    expect(dialogSource).toContain('dialog.dataset["busy"]');
    expect(dialogSource).not.toMatch(
      /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\s*\([^)]*(?:token|repository|profile|revision)/iu,
    );
    expect(controllerSource).toContain(
      'code-city.last-import-job.v1',
    );
    expect(controllerSource).toContain(
      "this.storage.write(job.id)",
    );
    expect(controllerSource).toContain(
      "await this.api.logout(controller.signal)",
    );
    expect(controllerSource).not.toContain(
      "this.storage.write(request",
    );
  });

  it("keeps the wizard usable on a narrow touch viewport", async () => {
    const css = await fs.readFile(
      path.join(viewerRoot, "src/styles.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.project-import-dialog\s*\{[\s\S]*width:\s*min\(760px,\s*calc\(100vw - 32px\)\)[\s\S]*max-height:/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*\.project-import-dialog,[\s\S]*width:\s*calc\(100vw - 20px\)/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*\.project-import-sources,[\s\S]*grid-template-columns:\s*1fr/u,
    );
  });
});
