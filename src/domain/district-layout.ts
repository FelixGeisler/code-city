import { compareUnsignedUtf8 } from "./source-admission";

export type LayoutFile = Readonly<{ canonicalPath: string; side: number; height: number }>;
export type RecursiveLayout = Readonly<{
  origins: readonly number[];
  bounds: readonly number[];
  plates: readonly Readonly<{ minimum: readonly [number, number, number]; dimensions: readonly [number, number, number] }>[];
  districts: readonly Readonly<{ root: boolean; identity: string }>[];
  sceneBounds: readonly number[];
}>;
type Directory = { path: string; parent: number; level: number; children: number[]; files: number[]; x: number; z: number; width: number; depth: number; worldX: number; worldZ: number };
const GAP = 2, PADDING = 3;
function integer(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error("M1-CITY-1"); return value; }
function add(a: number, b: number): number { return integer(a + b); }
function multiply(a: number, b: number): number { return integer(a * b); }

/** Deterministic, iterative directory packing. File dimensions are never rescaled. */
export function planRecursiveLayout(files: readonly LayoutFile[]): RecursiveLayout {
  if (files.length === 0) throw new Error("M1-CITY-1");
  const directories: Directory[] = [{ path: "", parent: -1, level: 0, children: [], files: [], x: 0, z: 0, width: 0, depth: 0, worldX: 0, worldZ: 0 }];
  const byPath = new Map<string, number>([["", 0]]), parents = new Uint32Array(files.length);
  const fileX = new Float64Array(files.length), fileZ = new Float64Array(files.length);
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!; integer(file.side); integer(file.height);
    let parent = 0, slash = file.canonicalPath.indexOf("/");
    while (slash >= 0) {
      const path = file.canonicalPath.slice(0, slash); let id = byPath.get(path);
      if (id === undefined) {
        id = directories.length; byPath.set(path, id);
        directories.push({ path, parent, level: directories[parent]!.level + 1, children: [], files: [], x: 0, z: 0, width: 0, depth: 0, worldX: 0, worldZ: 0 });
        directories[parent]!.children.push(id);
      }
      parent = id; slash = file.canonicalPath.indexOf("/", slash + 1);
    }
    parents[index] = parent; directories[parent]!.files.push(index);
  }
  for (let index = directories.length - 1; index >= 0; index--) {
    const directory = directories[index]!;
    const items = [
      ...directory.children.map(id => ({ directory: true, id, path: directories[id]!.path, width: directories[id]!.width, depth: directories[id]!.depth })),
      ...directory.files.map(id => ({ directory: false, id, path: files[id]!.canonicalPath, width: files[id]!.side, depth: files[id]!.side })),
    ];
    items.sort((a, b) => multiply(b.width, b.depth) - multiply(a.width, a.depth) || compareUnsignedUtf8(a.path, b.path) || Number(b.directory) - Number(a.directory));
    let area = 0, widest = 0;
    for (const item of items) { area = add(area, multiply(add(item.width, GAP), add(item.depth, GAP))); widest = Math.max(widest, item.width); }
    const target = Math.max(widest, integer(Math.ceil(Math.sqrt(area))));
    let x = 0, z = 0, rowDepth = 0, occupiedWidth = 0, occupiedDepth = 0;
    for (const item of items) {
      if (x !== 0 && add(x, item.width) > target) { x = 0; z = add(z, add(rowDepth, GAP)); rowDepth = 0; }
      if (item.directory) { directories[item.id]!.x = x; directories[item.id]!.z = z; }
      else { fileX[item.id] = x; fileZ[item.id] = z; }
      occupiedWidth = Math.max(occupiedWidth, add(x, item.width)); occupiedDepth = Math.max(occupiedDepth, add(z, item.depth));
      x = add(x, add(item.width, GAP)); rowDepth = Math.max(rowDepth, item.depth);
    }
    directory.width = add(occupiedWidth, PADDING * 2); directory.depth = add(occupiedDepth, PADDING * 2);
  }
  // Insertion order guarantees every parent precedes its children, regardless of path order.
  for (let index = 1; index < directories.length; index++) {
    const directory = directories[index]!, parent = directories[directory.parent]!;
    directory.worldX = add(parent.worldX, add(PADDING, directory.x)); directory.worldZ = add(parent.worldZ, add(PADDING, directory.z));
  }
  const origins = new Array<number>(files.length * 3);
  let minX = Infinity, minZ = Infinity, minY = Infinity, maxY = 0;
  for (let index = 0; index < files.length; index++) {
    const parent = directories[parents[index]!]!, x = add(parent.worldX, add(PADDING, fileX[index]!)), z = add(parent.worldZ, add(PADDING, fileZ[index]!)), y = parent.level / 2;
    origins[index * 3] = x; origins[index * 3 + 1] = y; origins[index * 3 + 2] = z;
    minX = Math.min(minX, x); minZ = Math.min(minZ, z); minY = Math.min(minY, y); maxY = Math.max(maxY, y + files[index]!.height);
  }
  let maxX = 0, maxZ = 0;
  for (let index = 0; index < files.length; index++) {
    const offset = index * 3; origins[offset] = origins[offset]! - minX; origins[offset + 2] = origins[offset + 2]! - minZ;
    maxX = Math.max(maxX, add(origins[offset]!, files[index]!.side)); maxZ = Math.max(maxZ, add(origins[offset + 2]!, files[index]!.side));
  }
  const order = directories.map((_, index) => index).sort((a, b) => compareUnsignedUtf8(directories[a]!.path, directories[b]!.path));
  const districts = order.map(id => ({ root: id === 0, identity: id === 0 ? "_root" : directories[id]!.path }));
  const plates = order.map(id => {
    const directory = directories[id]!;
    return { minimum: [directory.worldX - minX, (directory.level - 1) / 2, directory.worldZ - minZ] as const, dimensions: [directory.width, 0.5, directory.depth] as const };
  });
  const root = directories[0]!;
  return { origins, bounds: [0, minY, 0, maxX, maxY, maxZ], plates, districts, sceneBounds: [-minX, -0.5, -minZ, root.width - minX, maxY, root.depth - minZ] };
}
