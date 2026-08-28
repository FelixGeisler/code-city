import { parseWorkerCommand, type WorkerMessage } from "../application/protocol";
import { createWorkerAttemptPipeline } from "../application/worker-attempt";
import { createGithubRevisionGateway } from "./github-revision-gateway";
import { createGithubSourceGateway } from "./github-source-gateway";
import { createProductionTreeSitterAdapter } from "./tree-sitter-assets";

const workerScope: DedicatedWorkerGlobalScope = self;
export function publishWorkerMessage(scope: Pick<DedicatedWorkerGlobalScope, "postMessage">, message: WorkerMessage): void {
  if (message.type !== "SUCCESS") {
    scope.postMessage(message);
    return;
  }

  let city: typeof message.city | undefined = message.city;
  const geometry = city.geometry;
  try {
    scope.postMessage(message, [
      geometry.origins.buffer,
      geometry.sizes.buffer,
      geometry.rgba.buffer,
      geometry.bounds.buffer,
    ]);
  } finally {
    city = undefined;
  }
}

const pipeline = createWorkerAttemptPipeline(
  createGithubRevisionGateway(fetch),
  createGithubSourceGateway(fetch),
  (message) => publishWorkerMessage(workerScope, message),
  undefined,
  createProductionTreeSitterAdapter(),
);

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const command = parseWorkerCommand(event.data);
  if (!command) {
    return;
  }
  if (command.type === "START") {
    pipeline.start(command.repository, command.generation);
  } else {
    pipeline.stop(command.generation);
  }
});
