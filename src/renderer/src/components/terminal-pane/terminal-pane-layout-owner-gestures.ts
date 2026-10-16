import type { PaneManager, PaneManagerOptions } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { sendPaneCommandToLayoutOwner } from './terminal-pane-layout-owner-commands'

/**
 * A layout-owner build's pane gestures: an in-tab drop moves the pane once main has; a divider's
 * new ratios, already drawn while dragging, are saved by main when the drag ends.
 */
export function layoutOwnerPaneGestures(pane: {
  worktreeId: string
  tabId: string
  managerRef: { current: PaneManager | null }
  /** False while a restore owns the layout; the drawn ratios are then not the user's. */
  shouldPersistLayout: () => boolean
}): Pick<PaneManagerOptions, 'takePaneDrop' | 'onDividerRatiosCommitted'> {
  const { worktreeId, tabId } = pane
  return {
    takePaneDrop: ({ sourcePaneId, targetPaneId, zone }, move) => {
      const manager = pane.managerRef.current
      const leafId = manager?.getLeafId(sourcePaneId)
      const targetLeafId = manager?.getLeafId(targetPaneId)
      if (!leafId || !targetLeafId) {
        return false
      }
      return sendPaneCommandToLayoutOwner(
        worktreeId,
        { type: 'movePane', tabId, leafId, targetLeafId, side: zone },
        { apply: move, asToday: move }
      )
    },
    onDividerRatiosCommitted: () => {
      // Why the store: the gesture's own persist has just written the window's tree there.
      const root = useAppStore.getState().terminalLayoutsByTabId[tabId]?.root
      if (root && pane.shouldPersistLayout()) {
        const keep = (): void => {}
        sendPaneCommandToLayoutOwner(
          worktreeId,
          { type: 'setPaneRatios', tabId, root },
          { apply: keep, asToday: keep }
        )
      }
    }
  }
}
