import { compareUnsignedUtf8, isCanonicalSourcePath, MAX_ADMITTED_MODULES, MAX_NORMALIZED_MODULE_BYTES, MAX_NORMALIZED_TOTAL_BYTES } from "../domain/source-admission";
import { PRESENTATION_KIND, type City, type InspectionFact, type PresentationModel } from "../domain/city-model";
import { planRecursiveLayout } from "../domain/district-layout";
export type { InspectionFact } from "../domain/city-model";
export type CityPayload = City;
declare const validatedGeometryBrand: unique symbol;
export type ValidatedGeometry = Readonly<PresentationModel & { readonly [validatedGeometryBrand]: true }>;
export type DistrictPlate = Readonly<{ minimum: readonly [number,number,number]; dimensions: readonly [number,number,number] }>;
export type NumericPresentation = Readonly<{ plates: readonly DistrictPlate[]; sceneBounds: readonly [number,number,number,number,number,number]; centre: readonly [number,number,number] }>;
export type DistrictDescriptor = Readonly<{ root: boolean; identity: string }>;
export type ValidatedCity = Readonly<{ geometry: ValidatedGeometry; inspection: readonly InspectionFact[]; presentation: NumericPresentation; districts: readonly DistrictDescriptor[] }>;
type DataRecord=Record<string,unknown>;type IntrinsicGetter=(this:unknown)=>unknown;
const CITY_KEYS=["geometry","inspection"],GEOMETRY_KEYS=["kind","count","origins","sizes","rgba","bounds"],FACT_KEYS=["canonicalPath","S","U","M"];
const ARRAY_BUFFER_IS_VIEW=ArrayBuffer.isView,ARRAY_BUFFER_PROTOTYPE=ArrayBuffer.prototype,TYPED_ARRAY_PROTOTYPE=Object.getPrototypeOf(Float32Array.prototype) as object;
const TYPED_ARRAY_TAG=Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,Symbol.toStringTag)!.get as IntrinsicGetter;
const TYPED_ARRAY_BUFFER=Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,"buffer")!.get as IntrinsicGetter;
const TYPED_ARRAY_BYTE_LENGTH=Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,"byteLength")!.get as IntrinsicGetter;
const TYPED_ARRAY_BYTE_OFFSET=Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,"byteOffset")!.get as IntrinsicGetter;
const TYPED_ARRAY_LENGTH=Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,"length")!.get as IntrinsicGetter;
const ARRAY_BUFFER_BYTE_LENGTH=Object.getOwnPropertyDescriptor(ARRAY_BUFFER_PROTOTYPE,"byteLength")!.get as IntrinsicGetter;
const MAX_FLOAT_INTEGER=2**24,MAX_TARGET_RELATIVE=2**23,MAX_EXECUTABLE_UNITS_PER_MODULE=1+Math.floor(MAX_NORMALIZED_MODULE_BYTES/3);
const CONTROLLER_PALETTE=[{maximum:0,rgba:[0x22,0xc5,0x5e,0xff]},{maximum:1,rgba:[0x84,0xcc,0x16,0xff]},{maximum:3,rgba:[0xfa,0xcc,0x15,0xff]},{maximum:7,rgba:[0xf5,0x9e,0x0b,0xff]},{maximum:15,rgba:[0xf9,0x73,0x16,0xff]},{maximum:Number.MAX_SAFE_INTEGER,rgba:[0xef,0x44,0x44,0xff]}] as const;
function invalid():never{throw new Error("M1-CITY-1");}
function ownEnumerableDataRecord(value:unknown,exactKeys:readonly string[]):DataRecord|undefined{
 try{if(typeof value!=="object"||value===null||Object.getPrototypeOf(value)!==Object.prototype)return undefined;
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 if(keys.length!==exactKeys.length||keys.some(key=>typeof key!=="string")||exactKeys.some(key=>!Object.hasOwn(descriptors,key)))return undefined;
 const record:DataRecord={};for(const key of exactKeys){const descriptor=descriptors[key];if(!descriptor||!("value"in descriptor)||!descriptor.enumerable)return undefined;record[key]=descriptor.value;}return record;}catch{return undefined;}
}
function nonnegativeSafeInteger(value:unknown):value is number{return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;}
function checkedAdd(a:number,b:number):number{const result=a+b;if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||!Number.isSafeInteger(result))invalid();return result;}
function checkedMultiply(a:number,b:number):number{const result=a*b;if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||!Number.isSafeInteger(result))invalid();return result;}
function exactFloatInteger(value:number):boolean{return Number.isSafeInteger(value)&&value>=0&&value<MAX_FLOAT_INTEGER&&Math.fround(value)===value;}
function exactHalf(value:number):boolean{return Number.isFinite(value)&&value>=0&&value<MAX_FLOAT_INTEGER&&Number.isSafeInteger(value*2)&&Math.fround(value)===value;}
function exactTargetRelative(value:number):boolean{return Number.isFinite(value)&&Math.abs(value)<MAX_TARGET_RELATIVE&&Math.fround(value)===value;}
function expectedHeight(lines:number):number{return 4+Math.floor(36*Math.sqrt(Math.min(lines,1000)/1000)+0.5);}
function expectedSide(units:number):number{return 3+Math.floor(15*(Math.log1p(Math.min(units,100))/Math.log(101))**1.5+0.5);}
function expectedColor(complexity:number):readonly number[]{for(const band of CONTROLLER_PALETTE)if(complexity<=band.maximum)return band.rgba;invalid();}
function exactTypedArray<T extends Float32Array|Uint8Array>(value:unknown,prototype:object,brand:"Float32Array"|"Uint8Array",length:number,bytesPerElement:number):value is T{
 if(typeof value!=="object"||value===null||!ARRAY_BUFFER_IS_VIEW(value))return false;
 try{const byteLength=checkedMultiply(length,bytesPerElement);
 if(TYPED_ARRAY_TAG.call(value)!==brand||TYPED_ARRAY_LENGTH.call(value)!==length||TYPED_ARRAY_BYTE_OFFSET.call(value)!==0||TYPED_ARRAY_BYTE_LENGTH.call(value)!==byteLength||Object.getPrototypeOf(value)!==prototype)return false;
 const buffer=TYPED_ARRAY_BUFFER.call(value);if(typeof buffer!=="object"||buffer===null||Object.getPrototypeOf(buffer)!==ARRAY_BUFFER_PROTOTYPE||ARRAY_BUFFER_BYTE_LENGTH.call(buffer)!==byteLength||Reflect.ownKeys(buffer).length!==0)return false;
 const keys=Reflect.ownKeys(value);if(keys.length!==length)return false;for(let index=0;index<length;index++)if(keys[index]!==String(index))return false;return true;}catch{return false;}
}
function snapshotInspection(value:unknown,count:number):readonly InspectionFact[]{
 try{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
 const descriptors=Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey,PropertyDescriptor>,lengthDescriptor=descriptors.length;
 if(!lengthDescriptor||!("value"in lengthDescriptor)||lengthDescriptor.value!==count||Reflect.ownKeys(descriptors).length!==count+1)invalid();
 const inspection:InspectionFact[]=[];let priorPath:string|undefined,totalSourceLines=0,totalExecutableUnits=0;
 for(let index=0;index<count;index++){const element=descriptors[String(index)];if(!element||!("value"in element)||!element.enumerable)invalid();
 const record=ownEnumerableDataRecord(element.value,FACT_KEYS);
 if(!record||typeof record.canonicalPath!=="string"||!isCanonicalSourcePath(record.canonicalPath)||!nonnegativeSafeInteger(record.S)||record.S>MAX_NORMALIZED_MODULE_BYTES||!nonnegativeSafeInteger(record.U)||record.U>MAX_EXECUTABLE_UNITS_PER_MODULE||!nonnegativeSafeInteger(record.M)||(priorPath!==undefined&&compareUnsignedUtf8(priorPath,record.canonicalPath)>=0))invalid();
 totalSourceLines=checkedAdd(totalSourceLines,record.S);totalExecutableUnits=checkedAdd(totalExecutableUnits,record.U);
 if(totalSourceLines>MAX_NORMALIZED_TOTAL_BYTES||totalExecutableUnits>checkedAdd(count,Math.floor(MAX_NORMALIZED_TOTAL_BYTES/3)))invalid();
 const fact=Object.freeze({canonicalPath:record.canonicalPath,S:record.S,U:record.U,M:record.M});inspection.push(fact);priorPath=fact.canonicalPath;
 }return Object.freeze(inspection);}catch{return invalid();}
}
function snapshotGeometry(value:unknown):ValidatedGeometry{
 const record=ownEnumerableDataRecord(value,GEOMETRY_KEYS);
 if(!record||record.kind!==PRESENTATION_KIND||!nonnegativeSafeInteger(record.count)||record.count<1||record.count>MAX_ADMITTED_MODULES)invalid();
 const count=record.count,vectorLength=checkedMultiply(count,3),colorLength=checkedMultiply(count,4);
 if(!exactTypedArray<Float32Array>(record.origins,Float32Array.prototype,"Float32Array",vectorLength,4)||!exactTypedArray<Float32Array>(record.sizes,Float32Array.prototype,"Float32Array",vectorLength,4)||!exactTypedArray<Uint8Array>(record.rgba,Uint8Array.prototype,"Uint8Array",colorLength,1)||!exactTypedArray<Float32Array>(record.bounds,Float32Array.prototype,"Float32Array",6,4))invalid();
 const origins=new Float32Array(record.origins),sizes=new Float32Array(record.sizes),rgba=new Uint8Array(record.rgba),bounds=new Float32Array(record.bounds);
 for(let index=0;index<count;index++){const offset=index*3,width=sizes[offset]!,height=sizes[offset+1]!,depth=sizes[offset+2]!,x=origins[offset]!,y=origins[offset+1]!,z=origins[offset+2]!;
 if(![width,height,depth,x,z].every(exactFloatInteger)||!exactHalf(y)||width<3||width>18||height<4||height>40||depth!==width)invalid();
 const colorOffset=index*4;if(!CONTROLLER_PALETTE.some(({rgba:color})=>rgba[colorOffset]===color[0]&&rgba[colorOffset+1]===color[1]&&rgba[colorOffset+2]===color[2]&&rgba[colorOffset+3]===color[3]))invalid();
 }
 if(![0,2,3,5].every(axis=>exactFloatInteger(bounds[axis]!))||!exactHalf(bounds[1]!)||!exactHalf(bounds[4]!)||bounds[3]!<=0||bounds[4]!<=bounds[1]!||bounds[5]!<=0)invalid();
 return Object.freeze({kind:PRESENTATION_KIND,count,origins,sizes,rgba,bounds}) as ValidatedGeometry;
}
export function validateCityPayload(value:unknown):ValidatedCity{
 try{
 const city=ownEnumerableDataRecord(value,CITY_KEYS);if(!city)invalid();const geometry=snapshotGeometry(city.geometry),inspection=snapshotInspection(city.inspection,geometry.count);
 const files=inspection.map(fact=>({canonicalPath:fact.canonicalPath,side:expectedSide(fact.U),height:expectedHeight(fact.S)})),expected=planRecursiveLayout(files);
 for(let index=0;index<geometry.count;index++){const offset=index*3,file=files[index]!;for(let axis=0;axis<3;axis++)if(!Object.is(geometry.origins[offset+axis],expected.origins[offset+axis]))invalid();
 if(geometry.sizes[offset]!==file.side||geometry.sizes[offset+1]!==file.height||geometry.sizes[offset+2]!==file.side)invalid();const color=expectedColor(inspection[index]!.M);for(let channel=0;channel<4;channel++)if(geometry.rgba[index*4+channel]!==color[channel])invalid();}
 for(let axis=0;axis<6;axis++)if(!Object.is(geometry.bounds[axis],expected.bounds[axis]))invalid();
 const sceneBounds=Object.freeze([...expected.sceneBounds]) as NumericPresentation["sceneBounds"];
 const centre=Object.freeze([sceneBounds[0]+(sceneBounds[3]-sceneBounds[0])/2,sceneBounds[1]+(sceneBounds[4]-sceneBounds[1])/2,sceneBounds[2]+(sceneBounds[5]-sceneBounds[2])/2]) as NumericPresentation["centre"];
 const plates=Object.freeze(expected.plates.map(plate=>Object.freeze({minimum:Object.freeze([...plate.minimum]) as DistrictPlate["minimum"],dimensions:Object.freeze([...plate.dimensions]) as DistrictPlate["dimensions"]})));
 const exactRelativeBox=(minimum:ArrayLike<number>,dimensions:ArrayLike<number>)=>{for(let axis=0;axis<3;axis++){const endpoint=minimum[axis]!+dimensions[axis]!;if(!exactTargetRelative(minimum[axis]!-centre[axis])||!exactTargetRelative(endpoint-centre[axis]))invalid();}};
 for(let index=0;index<geometry.count;index++){const offset=index*3;exactRelativeBox(geometry.origins.subarray(offset,offset+3),geometry.sizes.subarray(offset,offset+3));}for(const plate of plates)exactRelativeBox(plate.minimum,plate.dimensions);
 const districts=Object.freeze(expected.districts.map(district=>Object.freeze({...district})));if(districts.length!==plates.length)invalid();
 return Object.freeze({geometry,inspection,presentation:Object.freeze({plates,sceneBounds,centre}),districts});
 }catch(error){if(error instanceof Error&&error.message==="M1-CITY-1")throw error;invalid();}
}
