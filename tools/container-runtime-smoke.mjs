import { promises as fs } from "node:fs";

const [mode, baseUrlValue, argument] = process.argv.slice(2);
const baseUrl = new URL(baseUrlValue ?? "http://127.0.0.1:3000");
const packageMetadata = JSON.parse(
  await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
);

async function response(path, init, expectedStatus) {
  const result = await fetch(new URL(path, baseUrl), init);
  if (result.status !== expectedStatus) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} returned ${result.status}: ${await result.text()}`,
    );
  }
  return result;
}

async function json(path, init, expectedStatus = 200) {
  return await (await response(path, init, expectedStatus)).json();
}

function requestHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "X-Code-City-Request": "1",
  };
}

async function assertApplication() {
  const health = await json("/api/v1/health");
  if (
    health.status !== "ok" ||
    health.version !== packageMetadata.version ||
    health.apiVersion !== "v1"
  ) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  const viewer = await (await response("/", undefined, 200)).text();
  if (!viewer.includes("Code City")) {
    throw new Error("The production viewer was not served.");
  }
}

async function waitForCompletion(id) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const payload = await json(`/api/v1/jobs/${id}`);
    const job = payload.job ?? payload;
    if (job.state === "completed") return job;
    if (job.state === "failed" || job.state === "cancelled") {
      throw new Error(`Import ${id} ended as ${job.state}: ${JSON.stringify(job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Import ${id} did not complete within 120 seconds.`);
}

async function assertArtifact(id, job) {
  const artifactUrl = job?.result?.artifactUrl ??
    `/api/v1/artifacts/${id}/city-model.json`;
  if (artifactUrl !== `/api/v1/artifacts/${id}/city-model.json`) {
    throw new Error(`Unexpected artifact URL: ${String(artifactUrl)}`);
  }
  const model = await json(artifactUrl);
  const languages = new Set(model.buildings?.map((building) => building.language));
  if (
    model.schemaVersion !== "1.0" ||
    model.generator?.version !== packageMetadata.version ||
    model.repositories?.[0]?.name !== "Container acceptance" ||
    !languages.has("typescript") ||
    !languages.has("csharp")
  ) {
    throw new Error(`Unexpected generated model: ${JSON.stringify(model)}`);
  }
}

await assertApplication();

if (mode === "import") {
  if (argument === undefined) throw new Error("A ZIP fixture path is required.");
  const bytes = await fs.readFile(argument);
  const metadata = {
    source: {
      kind: "repository-zip",
      sizeBytes: bytes.byteLength,
      repositoryName: "Container acceptance",
      rootMode: "archive-root",
    },
  };
  const reservationPayload = await json(
    "/api/v1/imports/uploads",
    {
      method: "POST",
      headers: requestHeaders("application/json"),
      body: JSON.stringify(metadata),
    },
    201,
  );
  const reservation = reservationPayload.upload;
  if (
    reservation?.sizeBytes !== bytes.byteLength ||
    reservation?.mediaType !== "application/zip" ||
    typeof reservation?.uploadUrl !== "string"
  ) {
    throw new Error(`Unexpected upload reservation: ${JSON.stringify(reservationPayload)}`);
  }
  const queuedPayload = await json(
    reservation.uploadUrl,
    {
      method: "PUT",
      headers: requestHeaders("application/zip"),
      body: bytes,
    },
    202,
  );
  const queued = queuedPayload.job ?? queuedPayload;
  if (typeof queued.id !== "string") {
    throw new Error(`Unexpected queued job: ${JSON.stringify(queuedPayload)}`);
  }
  const job = await waitForCompletion(queued.id);
  await assertArtifact(queued.id, job);
  process.stdout.write(`${queued.id}\n`);
} else if (mode === "restore") {
  if (argument === undefined) throw new Error("A durable job ID is required.");
  const payload = await json(`/api/v1/jobs/${argument}`);
  const job = payload.job ?? payload;
  if (job.id !== argument || job.state !== "completed") {
    throw new Error(`The durable job was not restored: ${JSON.stringify(payload)}`);
  }
  await assertArtifact(argument, job);
} else {
  throw new Error("Usage: container-runtime-smoke.mjs <import|restore> <base-url> <zip|job-id>");
}
