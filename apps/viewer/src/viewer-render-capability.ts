export interface ViewerInstancingContext {
  readonly drawArraysInstanced?: unknown;
  readonly drawElementsInstanced?: unknown;
  readonly vertexAttribDivisor?: unknown;
}

/**
 * Detects the core WebGL 2 draw operations used by Three.js instanced meshes.
 * Three.js r163 and newer require WebGL 2, so extension-based WebGL 1 aliases
 * are deliberately outside the viewer capability contract.
 */
export function supportsViewerInstancing(
  context: ViewerInstancingContext,
): boolean {
  return (
    typeof context.drawArraysInstanced === "function" &&
    typeof context.drawElementsInstanced === "function" &&
    typeof context.vertexAttribDivisor === "function"
  );
}
