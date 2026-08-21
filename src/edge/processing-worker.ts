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

  let model: typeof message.model | undefined = message.model;
  const outbound = model;
  try {
    scope.postMessage(message, [
      outbound.origins.buffer,
      outbound.sizes.buffer,
      outbound.rgba.buffer,
      outbound.bounds.buffer,
    ]);
  } finally {
    model = undefined;
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
