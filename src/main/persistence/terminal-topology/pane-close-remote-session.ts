import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'

/**
 * A tab's remote session id is carried data the layout model does not hold, so a pane close moves
 * it here: one naming the closed pane's terminal follows the tab's remaining pane, as the legacy
 * pane close (`retireTerminalSurfaceFromPersistence`) does.
 */
export function followRemoteSessionAfterPaneClose(
  command: LayoutCommand,
  stored: WorkspaceSessionState,
  written: WorkspaceSessionState
): WorkspaceSessionState {
  if (command.type !== 'closePane') {
    return written
  }
  const closedPtyId = stored.terminalLayoutsByTabId[command.tabId]?.ptyIdsByLeafId?.[command.leafId]
  const remoteSessionIds = written.remoteSessionIdsByTabId
  if (!closedPtyId || remoteSessionIds?.[command.tabId] !== closedPtyId) {
    return written
  }
  const layout = written.terminalLayoutsByTabId[command.tabId]
  const next = { ...remoteSessionIds }
  const remaining =
    layout?.ptyIdsByLeafId?.[layout.activeLeafId ?? ''] ??
    Object.values(layout?.ptyIdsByLeafId ?? {})[0]
  if (remaining) {
    next[command.tabId] = remaining
  } else {
    delete next[command.tabId]
  }
  return { ...written, remoteSessionIdsByTabId: next }
}
