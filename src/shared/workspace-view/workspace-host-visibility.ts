import {
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../execution-host'

// The Workspace options "Hosts" value, shared so every surface reads and writes it the same way.

/** The shown hosts; with no list saved, the legacy single-host scope still narrows (null is all). */
export function resolveVisibleWorkspaceHostIds(
  visibleWorkspaceHostIds: readonly string[] | null | undefined,
  workspaceHostScope: string | null | undefined
): ExecutionHostId[] | null {
  const visibleHostIds = normalizeVisibleExecutionHostIds(visibleWorkspaceHostIds)
  if (visibleHostIds) {
    return visibleHostIds
  }
  const legacyScope = normalizeExecutionHostScope(workspaceHostScope)
  return legacyScope === 'all' ? null : [legacyScope]
}

/**
 * The scope that goes with a new shown-hosts list. It is also the default host for new workspaces,
 * so a multi-host list keeps the current one; "all" must be written, or the fallback above revives
 * the old scope.
 */
export function workspaceHostScopeForVisibleHosts(
  visibleHostIds: readonly ExecutionHostId[] | null,
  current: ExecutionHostScope
): ExecutionHostScope {
  if (visibleHostIds === null) {
    return 'all'
  }
  return visibleHostIds.length === 1 ? visibleHostIds[0] : current
}
