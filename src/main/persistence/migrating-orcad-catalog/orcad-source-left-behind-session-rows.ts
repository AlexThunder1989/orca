import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { TabGroup } from '../../../shared/tab-types'
import { ORCA_BROWSER_PARTITION } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/**
 * Saved rows the managed server cannot hold and that are no one's live work, removed from a copy
 * of one partition before export. The profile itself keeps them, so a downgrade still has them.
 */
export function withoutLeftBehindSessionRows(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): WorkspaceSessionState {
  const owns = (ownerKey: string): boolean => orcadMigrationOwnerMatchesScope(ownerKey, scope)
  const isolated = new Set(
    Object.entries(session.browserTabsByWorktree ?? {}).flatMap(([ownerKey, workspaces]) =>
      owns(ownerKey) ? workspaces.filter(usesSessionProfile).map((workspace) => workspace.id) : []
    )
  )
  const hiddenFiles = hiddenHostBoundFiles(session, owns)
  if (isolated.size === 0 && hiddenFiles.size === 0) {
    return session
  }
  const keepsFile = (ownerKey: string, filePath: string): boolean =>
    !hiddenFiles.get(ownerKey)?.has(filePath)
  const droppedTabIds = new Set(
    Object.values(session.unifiedTabs ?? {})
      .flat()
      .filter((tab) => tab.contentType === 'browser' && isolated.has(tab.entityId))
      .map((tab) => tab.id)
  )
  // Built as a new object: this is an export copy, never a write to the saved layout.
  return structuredClone({
    ...session,
    browserTabsByWorktree: mapRows(session.browserTabsByWorktree, (_key, workspaces) =>
      workspaces.filter((workspace) => !isolated.has(workspace.id))
    ),
    browserPagesByWorkspace: Object.fromEntries(
      Object.entries(session.browserPagesByWorkspace ?? {}).filter(([id]) => !isolated.has(id))
    ),
    activeBrowserTabIdByWorktree: Object.fromEntries(
      Object.entries(session.activeBrowserTabIdByWorktree ?? {}).filter(
        ([, id]) => !isolated.has(id ?? '')
      )
    ),
    unifiedTabs: mapRows(session.unifiedTabs, (_key, tabs) =>
      tabs.filter((tab) => !droppedTabIds.has(tab.id))
    ),
    tabGroups: mapRows(session.tabGroups, (_key, groups) =>
      groups.map((group) => withoutTabs(group, droppedTabIds))
    ),
    openFilesByWorktree: mapRows(session.openFilesByWorktree, (ownerKey, files) =>
      files.filter((file) => keepsFile(ownerKey, file.filePath))
    ),
    activeFileIdByWorktree: Object.fromEntries(
      Object.entries(session.activeFileIdByWorktree ?? {}).filter(
        ([ownerKey, fileId]) => !fileId || keepsFile(ownerKey, fileId)
      )
    )
  })
}

function mapRows<T>(
  rows: Record<string, T[]> | undefined,
  map: (ownerKey: string, row: T[]) => T[]
): Record<string, T[]> | undefined {
  return rows
    ? Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, map(key, row)]))
    : rows
}

function withoutTabs(group: TabGroup, tabIds: ReadonlySet<string>): TabGroup {
  const tabOrder = group.tabOrder.filter((id) => !tabIds.has(id))
  const recentTabIds = group.recentTabIds?.filter((id) => !tabIds.has(id))
  const activeTabId =
    group.activeTabId && tabIds.has(group.activeTabId)
      ? (recentTabIds?.at(-1) ?? tabOrder[0] ?? null)
      : group.activeTabId
  return { ...group, tabOrder, ...(recentTabIds ? { recentTabIds } : {}), activeTabId }
}

/** Whether a partition is some Orca profile's shared browser default rather than a session profile. */
export function isOrcaProfileBrowserDefaultPartition(partition: string): boolean {
  return (
    partition === ORCA_BROWSER_PARTITION ||
    (partition.startsWith('persist:orca-profile-') &&
      partition.endsWith('-browser-default') &&
      !partition.includes('-browser-session-'))
  )
}

/**
 * Isolated or imported login profiles are this desktop's alone and the server stores none, so the
 * tab stays behind rather than reopen on the shared profile. A tab switched back to Default keeps
 * the default partition and moves as usual.
 */
function usesSessionProfile(workspace: BrowserWorkspace): boolean {
  const { sessionProfileId, sessionPartition } = workspace
  return (
    (sessionProfileId ? sessionProfileId !== 'default' : false) ||
    (sessionPartition ? !isOrcaProfileBrowserDefaultPartition(sessionPartition) : false)
  )
}

/**
 * Clean editor files bound to another host that no tab shows. The user cannot see or close them,
 * and the server cannot hold them; one with an unsaved draft is never in this set.
 */
function hiddenHostBoundFiles(
  session: WorkspaceSessionState,
  owns: (ownerKey: string) => boolean
): Map<string, Set<string>> {
  const hidden = new Map<string, Set<string>>()
  // Without the unified model, hydration shows every saved file as a tab.
  if (!session.unifiedTabs || !session.tabGroups) {
    return hidden
  }
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!owns(ownerKey)) {
      continue
    }
    const shown = new Set(
      (session.unifiedTabs[ownerKey] ?? []).flatMap((tab) => [tab.id, tab.entityId])
    )
    for (const file of files) {
      const hostBound = file.externalSshTargetId !== undefined || Boolean(file.runtimeEnvironmentId)
      const visible =
        shown.has(file.filePath) ||
        shown.has(ownedEditorFileId(file.filePath, ownerKey, file.runtimeEnvironmentId))
      if (hostBound && file.dirtyDraftContent === undefined && !visible) {
        hidden.set(ownerKey, (hidden.get(ownerKey) ?? new Set()).add(file.filePath))
      }
    }
  }
  return hidden
}
