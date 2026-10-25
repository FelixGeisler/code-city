import { createGithubRevisionGateway } from "../github-revision-gateway";
import { createGithubRawSourceGateway } from "../github-source-gateway";
import { type NodeAnalysisWorkerDependencies } from "./analysis-worker";
import { createNodeTreeSitterAdapter } from "./parser-assets";

export function productionNodeAnalysisWorkerDependencies(): NodeAnalysisWorkerDependencies {
  return {
    revisionGateway: createGithubRevisionGateway(fetch),
    sourceGateway: createGithubRawSourceGateway(fetch),
    parser: createNodeTreeSitterAdapter(),
  };
}
