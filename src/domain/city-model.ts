import type { ModuleComplexityFact } from "./complexity";
import { compareUnsignedUtf8, isCanonicalSourcePath, MAX_ADMITTED_MODULES } from "./source-admission";
import { planRecursiveLayout } from "./district-layout";

export const PRESENTATION_KIND = "CODE_CITY_RECURSIVE_PRESENTATION_1" as const;
export type PresentationModel = Readonly<{ kind: typeof PRESENTATION_KIND; count: number; origins: Float32Array; sizes: Float32Array; rgba: Uint8Array; bounds: Float32Array }>;
export type InspectionFact = Readonly<{ canonicalPath: string; S: number; U: number; M: number }>;
export type City = Readonly<{ geometry: PresentationModel; inspection: readonly InspectionFact[] }>;
type DataRecord = Record<string, unknown>;
type FactSnapshot = InspectionFact;
const MAX_FLOAT_INTEGER = 2 ** 24, MAX_TARGET_RELATIVE = 2 ** 23;
const FACT_KEYS = ["canonicalPath", "S", "U", "M"] as const;
const PALETTE = [[0x22,0xc5,0x5e,0xff],[0x84,0xcc,0x16,0xff],[0xfa,0xcc,0x15,0xff],[0xf5,0x9e,0x0b,0xff],[0xf9,0x73,0x16,0xff],[0xef,0x44,0x44,0xff]] as const;
export const COMPLEXITY_PALETTE_LEGEND = Object.freeze([
  Object.freeze({range:"0",rgba:"#22C55EFF"}),Object.freeze({range:"1",rgba:"#84CC16FF"}),Object.freeze({range:"2–3",rgba:"#FACC15FF"}),Object.freeze({range:"4–7",rgba:"#F59E0BFF"}),Object.freeze({range:"8–15",rgba:"#F97316FF"}),Object.freeze({range:"16+",rgba:"#EF4444FF"}),
]);
function invalid(): never { throw new Error("M1-CITY-1"); }
function ownEnumerableDataRecord(value: unknown, exactKeys: readonly string[]): DataRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== exactKeys.length || keys.some(key => typeof key !== "string") || exactKeys.some(key => !Object.hasOwn(descriptors,key))) return undefined;
    const record: DataRecord = {};
    for (const key of exactKeys) { const descriptor=descriptors[key]; if(!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined; record[key]=descriptor.value; }
    return record;
  } catch { return undefined; }
}
function nonnegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function paletteIndex(complexity: number): number { return complexity===0?0:complexity===1?1:complexity<=3?2:complexity<=7?3:complexity<=15?4:5; }
export function paletteForComplexity(complexity: number): typeof PALETTE[number] { return PALETTE[paletteIndex(complexity)]!; }
export function paletteBandForComplexity(complexity: number): typeof COMPLEXITY_PALETTE_LEGEND[number] { return COMPLEXITY_PALETTE_LEGEND[paletteIndex(complexity)]!; }
export function displayedHeight(sourceLines: number): number {
  if (!nonnegativeSafeInteger(sourceLines)) invalid();
  return 4 + Math.floor(36 * Math.sqrt(Math.min(sourceLines, 1000) / 1000) + 0.5);
}
export function displayedSide(executableUnits: number): number {
  if (!nonnegativeSafeInteger(executableUnits)) invalid();
  return 3 + Math.floor(15 * (Math.log1p(Math.min(executableUnits, 100)) / Math.log(101)) ** 1.5 + 0.5);
}
function snapshotFacts(value: unknown): FactSnapshot[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const descriptors=Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey,PropertyDescriptor>, lengthDescriptor=descriptors.length;
    if(!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) invalid();
    const length=lengthDescriptor.value as number;
    if(length<1 || length>MAX_ADMITTED_MODULES || Reflect.ownKeys(descriptors).length!==length+1) invalid();
    const facts: FactSnapshot[]=[], identities=new Set<string>();
    for(let index=0;index<length;index++) {
      const element=descriptors[String(index)]; if(!element || !("value" in element) || !element.enumerable) invalid();
      const record=ownEnumerableDataRecord(element.value,FACT_KEYS);
      if(!record || typeof record.canonicalPath!=="string" || !isCanonicalSourcePath(record.canonicalPath) || !nonnegativeSafeInteger(record.S) || !nonnegativeSafeInteger(record.U) || !nonnegativeSafeInteger(record.M) || identities.has(record.canonicalPath)) invalid();
      identities.add(record.canonicalPath);facts.push({canonicalPath:record.canonicalPath,S:record.S,U:record.U,M:record.M});
    }
    facts.sort((a,b)=>compareUnsignedUtf8(a.canonicalPath,b.canonicalPath));return facts;
  } catch { return invalid(); }
}

export function buildCity(input: readonly ModuleComplexityFact[]): City {
  const facts=snapshotFacts(input), count=facts.length;
  let origins: Float32Array|undefined,sizes: Float32Array|undefined,rgba: Uint8Array|undefined,bounds: Float32Array|undefined;
  try {
    sizes=new Float32Array(count*3);rgba=new Uint8Array(count*4);
    const files=facts.map((fact,index)=>{const side=displayedSide(fact.U),height=displayedHeight(fact.S);sizes!.set([side,height,side],index*3);rgba!.set(paletteForComplexity(fact.M),index*4);return {canonicalPath:fact.canonicalPath,side,height};});
    const plan=planRecursiveLayout(files);origins=Float32Array.from(plan.origins);bounds=Float32Array.from(plan.bounds);
    for(let index=0;index<plan.origins.length;index++) if(!Number.isFinite(plan.origins[index]) || Math.abs(plan.origins[index]!)>=MAX_FLOAT_INTEGER || origins[index]!==plan.origins[index]) invalid();
    for(let index=0;index<plan.bounds.length;index++) if(!Number.isFinite(plan.bounds[index]) || Math.abs(plan.bounds[index]!)>=MAX_FLOAT_INTEGER || bounds[index]!==plan.bounds[index]) invalid();
    const centre=[0,1,2].map(axis=>plan.sceneBounds[axis]!+(plan.sceneBounds[axis+3]!-plan.sceneBounds[axis]!)/2);
    const exactBox=(minimum:readonly number[],dimensions:readonly number[])=>{for(let axis=0;axis<3;axis++)for(const point of [minimum[axis]!,minimum[axis]!+dimensions[axis]!]) { const relative=point-centre[axis]!;if(!Number.isFinite(relative)||Math.abs(relative)>=MAX_TARGET_RELATIVE||Math.fround(relative)!==relative) invalid(); }};
    for(let index=0;index<count;index++)exactBox(plan.origins.slice(index*3,index*3+3),[files[index]!.side,files[index]!.height,files[index]!.side]);
    for(const plate of plan.plates)exactBox(plate.minimum,plate.dimensions);
    const geometry:PresentationModel=Object.freeze({kind:PRESENTATION_KIND,count,origins,sizes,rgba,bounds});
    return Object.freeze({geometry,inspection:Object.freeze(facts.map(fact=>Object.freeze({...fact})))});
  } catch(error) {origins?.fill(0);sizes?.fill(0);rgba?.fill(0);bounds?.fill(0);facts.length=0;if(error instanceof Error&&error.message==="M1-CITY-1")throw error;invalid();}
}
