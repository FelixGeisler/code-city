import { parseWorkerCommand } from "../application/protocol";
import { createWorkerAttemptPipeline } from "../application/worker-attempt";
import { createGithubRevisionGateway } from "./github-revision-gateway";
import { createGithubSourceGateway } from "./github-source-gateway";

const workerScope: DedicatedWorkerGlobalScope = self;
const pipeline = createWorkerAttemptPipeline(
  createGithubRevisionGateway(fetch),
  createGithubSourceGateway(fetch),
  (message) => workerScope.postMessage(message),
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
