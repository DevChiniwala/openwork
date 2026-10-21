/** Rollout-dependent visibility of Den API catalog operations to agents. Pure, so it is testable without a database. */
export type CatalogAvailabilityContext = {
  generatedArtifactViewsEnabled: boolean
  /** Managed deployment planning, launch preparation and status: managed deployments enabled. */
  managedDeploymentsEnabled: boolean
}

export function catalogOperationAvailableToCapabilities(
  context: CatalogAvailabilityContext,
  operation: { method: string; path: string },
) {
  // Hidden from search, enumeration and execution until the organization has
  // the managed deployments rollout; the routes themselves still enforce permissions and features.
  if (operation.path === "/v1/managed-deployments" || operation.path.startsWith("/v1/managed-deployments/")) {
    return context.managedDeploymentsEnabled
  }
  if (context.generatedArtifactViewsEnabled) return true
  return operation.path !== "/v1/workflows/{configObjectId}/views"
    && !operation.path.startsWith("/v1/artifact-views/")
}
