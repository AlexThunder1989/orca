import type { PaneManager } from '@/lib/pane-manager/pane-manager'

/**
 * Main refused a pane close as its last pane. An earlier close in flight took the sibling: once
 * it lands here too, the tab closes. More panes here than main has: main's copy lags, so close as
 * today. An unmounted tab is left alone.
 */
export function closeAfterLastPaneRefusal(
  manager: PaneManager | null,
  closeTab: () => void,
  closePaneAsToday: (paneId: number) => void,
  paneId: number
): void {
  const panes = manager?.getPanes().length
  if (panes === 1) {
    closeTab()
  } else if (panes) {
    closePaneAsToday(paneId)
  }
}
