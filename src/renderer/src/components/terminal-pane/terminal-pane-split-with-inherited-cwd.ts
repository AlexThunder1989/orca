import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { splitWebRuntimeTerminal } from '@/runtime/web-runtime-terminal-actions'
import type { PtyTransport } from './pty-transport-types'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { sendPaneCommandToLayoutOwner } from './terminal-pane-layout-owner-commands'

type SplitArgs = {
  worktreeId: string
  tabId: string
  manager: PaneManager
  getManager?: () => PaneManager | null
  paneTransports: Map<number, PtyTransport>
  paneCwdMap: PaneCwdMap
  fallbackCwd: string
  pane: ManagedPane
  direction: 'vertical' | 'horizontal'
  source: TerminalPaneSplitSource
}

export function splitTerminalPaneWithInheritedCwd(args: SplitArgs): void {
  const ptyId = args.paneTransports.get(args.pane.id)?.getPtyId() ?? null
  if (
    splitWebRuntimeTerminal(ptyId, args.direction, args.source, {
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: args.pane.leafId
    })
  ) {
    return
  }
  // Switch point: main writes the split and mints the new pane's id; the window then mounts it.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    sendPaneCommandToLayoutOwner(
      args.worktreeId,
      { type: 'splitPane', tabId: args.tabId, leafId: args.pane.leafId, direction: args.direction },
      {
        apply: ({ leafId }) => leafId && splitLocally(args, ptyId, leafId),
        asToday: () => splitLocally(args, ptyId)
      }
    )
  ) {
    return
  }
  splitLocally(args, ptyId)
}

function splitLocally(args: SplitArgs, ptyId: string | null, leafId?: string): void {
  const manager = args.getManager ? args.getManager() : args.manager
  if (!manager) {
    return
  }
  const placement = leafId ? { leafId } : {}
  const cached = args.paneCwdMap.get(args.pane.id)
  if (cached?.confirmed && cached.cwd) {
    const createdPane = manager.splitPane(args.pane.id, args.direction, {
      ...placement,
      cwd: cached.cwd
    })
    recordCreatedTerminalPaneSplit(createdPane, {
      source: args.source,
      direction: args.direction
    })
    return
  }
  const paneId = args.pane.id
  const cwdPromise =
    cached?.pendingCwd ??
    resolveSplitCwd({
      paneCwdMap: args.paneCwdMap,
      sourcePaneId: paneId,
      sourcePtyId: ptyId,
      fallbackCwd: args.fallbackCwd
    })
  const createdPane = manager.splitPane(paneId, args.direction, { ...placement, cwdPromise })
  recordCreatedTerminalPaneSplit(createdPane, {
    source: args.source,
    direction: args.direction
  })
}
