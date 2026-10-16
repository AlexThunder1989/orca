import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type {
  LayoutApplyReply,
  LayoutCommand
} from '../../shared/workspace-layout/workspace-layout-command-types'
import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import type { RuntimeStore } from './runtime-store-contract'

/** A window's layout command: one on a tab, which names the partitions it applies to. */
export type WindowLayoutCommand = LayoutCommand & { tabId: string }

/**
 * `layout.apply`: the window's command on the partitions holding its tab, routed partition first.
 * A pane close is the user's: main marks it so, and the window cannot.
 */
export async function applyWindowLayoutCommand(
  store: RuntimeStore,
  hostIdsForTab: (worktreeId: string, tabId: string) => ExecutionHostId[],
  command: WindowLayoutCommand
): Promise<LayoutApplyReply> {
  const hostIds = hostIdsForTab(command.workspace, command.tabId)
  // Why: a paired server's workspaces keep today's mirrored layout until that server owns it.
  if (!hostIds[0] || parseExecutionHostId(hostIds[0])?.kind === 'runtime') {
    return { ok: false, code: 'host_not_owned' }
  }
  if (!store.applyLayoutCommand) {
    throw new Error('layout_store_unavailable')
  }
  if (command.type !== 'closePane') {
    return store.applyLayoutCommand(command, [hostIds[0]])
  }
  const { workspace, tabId, leafId } = command
  // A launch still starting in the pane the user closed stops, and says so (as the legacy close).
  markAgentLaunchesClosedByUser(workspace, { kind: 'pane', tabId, leafId })
  // Why every holder: a legacy relay reattach can leave one tab in two partitions.
  return store.applyLayoutCommand(
    { ...command, userPaneClose: true },
    hostIds.filter((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime')
  )
}
