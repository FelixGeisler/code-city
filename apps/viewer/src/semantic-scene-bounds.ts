import * as THREE from "three";

import type {
  CityBase,
  CityBuilding,
  CityModel,
} from "../../../packages/core/src/model.js";

export interface BoundedScenePrimitive {
  readonly position: CityBuilding["position"];
  readonly size: CityBuilding["size"];
}

export interface SemanticSceneBounds {
  readonly city: THREE.Box3;
  readonly districts: ReadonlyMap<string, THREE.Box3>;
}

/**
 * Computes framing bounds only from stable model primitives. Render-only
 * highlights, hidden objects, route overlays, and evolution-removal meshes
 * therefore cannot change a camera preset or exported frame.
 */
export function createSemanticSceneBounds(
  model: CityModel,
  base: CityBase | undefined,
  externalNodes: readonly BoundedScenePrimitive[],
): SemanticSceneBounds {
  const city = new THREE.Box3();
  const districts = new Map<string, THREE.Box3>();
  const includeCity = (primitive: BoundedScenePrimitive): THREE.Box3 => {
    const bounds = boxBounds(primitive.position, primitive.size);
    city.union(bounds);
    return bounds;
  };

  if (base !== undefined) includeCity(base);
  for (const district of model.districts) {
    districts.set(district.id, includeCity(district).clone());
  }
  for (const building of model.buildings) {
    const bounds = includeCity(building);
    districts.get(building.districtId)?.union(bounds);
  }
  for (const node of externalNodes) includeCity(node);
  if (model.identityPanel !== undefined) includeCity(model.identityPanel);

  return { city, districts };
}

export function boxBounds(
  position: CityBuilding["position"],
  size: CityBuilding["size"],
): THREE.Box3 {
  if (
    ![
      position.x,
      position.y,
      position.z,
      size.x,
      size.y,
      size.z,
    ].every(Number.isFinite) ||
    size.x < 0 ||
    size.y < 0 ||
    size.z < 0
  ) {
    throw new RangeError(
      "Semantic scene bounds require finite positions and non-negative sizes.",
    );
  }
  return new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Vector3(size.x, size.y, size.z),
  );
}
