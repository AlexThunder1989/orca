import { useCallback, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { getMobileWorkspaceLineageGroupKey } from '../worktree/mobile-workspace-lineage'
import { WORKSPACE_SORT_OPTIONS as SORT_OPTIONS } from '../worktree/workspace-list-picker-options'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  type MobileViewPatch,
  type MobileViewState,
  type WorkspaceViewSettings
} from '../worktree/workspace-view-settings'
import type { Worktree } from '../worktree/workspace-list-sections'
import {
  changedWorkspaceRowFilters,
  NO_WORKSPACE_ROW_FILTERS
} from '../../../src/shared/workspace-view/workspace-row-filters'
import { hostViewSettingsRead, hostViewSettingsWrite } from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'
import type { FilterState } from '../worktree/workspace-list-types'

export function useHostViewSettings(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: HostScreenState
}) {
  const { client, connState, hostId, state } = args
  const { clientRef, setView, viewRef } = state

  const localEditsRef = useRef(0)

  // The one writer of the view: the ref is its synchronous mirror for edits made before a render.
  const applyViewState = useCallback((next: MobileViewState) => {
    viewRef.current = next
    setView(next)
  }, [])

  // Apply the change locally, then patch the desktop's shared store (ui.set) so both apps stay in sync.
  const persistViewSettings = useCallback(
    (patch: MobileViewPatch) => {
      localEditsRef.current += 1
      const previous = viewRef.current
      const next: MobileViewState = {
        ...previous,
        ...patch,
        filters: { ...previous.filters, ...patch.filters }
      }
      applyViewState(next)
      if (!client) {
        return
      }
      // Send only the touched fields: the host merges partial updates, so a stale
      // mirror can no longer revert sibling settings another client just changed
      // (STA-5781; supersedes the #8873 whole-payload special case).
      const payload: WorkspaceViewSettings = buildWorkspaceViewSettingsUpdate(patch, next)
      if (Object.keys(payload).length === 0) {
        return
      }
      void hostViewSettingsWrite.request(client, payload).catch(() => {
        // Best-effort: view settings are a convenience preference.
      })
    },
    [client, applyViewState]
  )

  // Merge the desktop's shared view settings (PersistedUIState) onto local state so desktop changes appear here.
  const syncViewSettingsFromDesktop = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    const requestClient = client
    const requestHostId = hostId
    const editsAtRequest = localEditsRef.current
    try {
      const reply = await hostViewSettingsRead.request(requestClient)
      // Why skip after a local edit: this reply may predate it; the edit's own change event re-reads.
      if (
        clientRef.current !== requestClient ||
        hostId !== requestHostId ||
        localEditsRef.current !== editsAtRequest
      ) {
        return
      }
      const settings = hostViewSettingsRead.interpret(reply)
      if (!settings.accepted) {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      const ui = settings.value as WorkspaceViewSettings | undefined
      if (!ui) {
        return
      }
      applyViewState(applyDesktopViewSettings(viewRef.current, ui))
    } catch {
      // Transient transport failure; retry on the next focus/connect.
    }
  }, [client, connState, hostId, applyViewState])

  const handleSortChange = useCallback(
    (value: MobileViewState['sortBy']) => {
      persistViewSettings({ sortBy: value })
    },
    [persistViewSettings]
  )

  const setFilter = useCallback(
    <Key extends keyof FilterState>(key: Key, value: FilterState[Key]) => {
      persistViewSettings({ filters: { [key]: value } })
    },
    [persistViewSettings]
  )

  const toggleRepoFilter = useCallback(
    (repoId: string) => {
      const current = viewRef.current.filters.filterRepoIds
      setFilter(
        'filterRepoIds',
        current.includes(repoId) ? current.filter((id) => id !== repoId) : [...current, repoId]
      )
    },
    [setFilter]
  )

  // Why every filter: Clear filters on the desktop resets them all, not only the ones shown here.
  const clearFilters = useCallback(() => {
    persistViewSettings({
      // Only what differs: an older host's strict ui.set refuses a key it does not know.
      filters: changedWorkspaceRowFilters(viewRef.current.filters, NO_WORKSPACE_ROW_FILTERS)
    })
  }, [persistViewSettings])

  const selectedSortLabel =
    SORT_OPTIONS.find((option) => option.value === state.view.sortBy)?.label ?? 'Recent'

  const handleGroupChange = useCallback(
    (value: MobileViewState['groupBy']) => {
      persistViewSettings({ groupBy: value })
    },
    [persistViewSettings]
  )

  const toggleCollapsed = useCallback(
    (key: string) => {
      const next = new Set(viewRef.current.collapsedGroups)
      if (!next.delete(key)) {
        next.add(key)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [persistViewSettings]
  )
  const toggleWorktreeLineage = useCallback(
    (item: Worktree) => toggleCollapsed(getMobileWorkspaceLineageGroupKey(item)),
    [toggleCollapsed]
  )

  return {
    clearFilters,
    handleGroupChange,
    handleSortChange,
    selectedSortLabel,
    syncViewSettingsFromDesktop,
    toggleCollapsed,
    setFilter,
    toggleRepoFilter,
    toggleWorktreeLineage
  }
}

export type HostViewSettings = ReturnType<typeof useHostViewSettings>
