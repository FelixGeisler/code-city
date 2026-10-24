import { parentPort } from "node:worker_threads";
import { productionNodeAnalysisWorkerDependencies, runNodeAnalysisWorker } from "./analysis-worker";

if (!parentPort) throw new Error("Node analysis worker requires a parent port");
runNodeAnalysisWorker(parentPort, productionNodeAnalysisWorkerDependencies());
