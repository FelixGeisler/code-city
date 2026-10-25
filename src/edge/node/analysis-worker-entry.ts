import { parentPort } from "node:worker_threads";
import { runNodeAnalysisWorker } from "./analysis-worker";
import { productionNodeAnalysisWorkerDependencies } from "./analysis-worker-production";

if (!parentPort) throw new Error("Node analysis worker requires a parent port");
runNodeAnalysisWorker(parentPort, productionNodeAnalysisWorkerDependencies());
