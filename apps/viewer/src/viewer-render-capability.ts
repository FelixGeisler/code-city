export interface ViewerInstancingContext {
  readonly drawArraysInstanced?: unknown;
  readonly drawElementsInstanced?: unknown;
  readonly vertexAttribDivisor?: unknown;
  getExtension(name: string): unknown;
}

interface AngleInstancedArrays {
  readonly drawArraysInstancedANGLE?: unknown;
  readonly drawElementsInstancedANGLE?: unknown;
  readonly vertexAttribDivisorANGLE?: unknown;
}

/**
 * Detects the actual draw operations used by Three.js instanced meshes.
 *
 * WebGL 2 exposes them on the context. WebGL 1 can expose the equivalent
 * ANGLE extension. Keeping this check independent of Three.js capability
 * aliases makes the bounded legacy path reachable on real WebGL 1 devices.
 */
export function supportsViewerInstancing(
  context: ViewerInstancingContext,
): boolean {
  if (
    typeof context.drawArraysInstanced === "function" &&
    typeof context.drawElementsInstanced === "function" &&
    typeof context.vertexAttribDivisor === "function"
  ) {
    return true;
  }

  const extension = context.getExtension(
    "ANGLE_instanced_arrays",
  ) as AngleInstancedArrays | null;
  return (
    extension !== null &&
    typeof extension.drawArraysInstancedANGLE === "function" &&
    typeof extension.drawElementsInstancedANGLE === "function" &&
    typeof extension.vertexAttribDivisorANGLE === "function"
  );
}
