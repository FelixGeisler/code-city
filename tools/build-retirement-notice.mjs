import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const retirementNoticeSource = path.join(projectRoot, "publication", "retirement-notice-v1", "index.html");
export const canonicalPagesRoot = path.join(projectRoot, "build", "pages");

export async function buildRetirementNotice(outputRoot = canonicalPagesRoot) {
  const root = path.resolve(outputRoot);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await cp(retirementNoticeSource, path.join(root, "index.html"));
  return root;
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = await buildRetirementNotice();
  process.stdout.write(`Wrote the retirement notice to ${path.relative(projectRoot, root)}.\n`);
}
