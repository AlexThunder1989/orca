import { useAppStore } from '@/store'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { PaneSide } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type {
  LayoutApplyReply,
  LayoutCommandResult,
  LayoutRefusalCode
} from '../../../../shared/workspace-layout/workspace-layout-command-types'

/** The pane commands a window sends `layout.apply`; main mints any new id. */
export type PaneLayoutCommand =
  | { type: 'splitPane'; tabId: string; leafId: string; direction: 'vertical' | 'horizontal' }
  | { type: 'closePane'; tabId: string; leafId: string }
  | { type: 'renamePane'; tabId: string; leafId: string; title: string | null }
  | { type: 'equalizePanes'; tabId: string }
  | { type: 'movePane'; tabId: string; leafId: string; targetLeafId: string; side: PaneSide }
  | { type: 'setPaneRatios'; tabId: string; root: TerminalPaneLayoutNode }

/**
 * A pane command in a layout-owner build: main applies it first, then `apply` shows main's result.
 * `asToday` runs instead when main cannot act on it: a paired server holds the tab (#18202), main's
 * copy lacks the workspace, tab or pane, or the call threw. `refused` on any other refusal. False
 * when a paired server owns the workspace's layout; the caller acts as today.
 */
export function sendPaneCommandToLayoutOwner(
  worktreeId: string,
  command: PaneLayoutCommand,
  handlers: {
    apply: (result: LayoutCommandResult) => void
    asToday: () => void
    refused?: (code: LayoutRefusalCode) => void
  }
): boolean {
  // Why: the same owner test that mirrors a workspace's tabs from a paired server; a focused
  // server must not claim a workspace whose row names no owner.
  if (getExplicitRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)) {
    return false
  }
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: { ...command, workspace: worktreeId }
  })
    .then(
      (reply) => {
        if (reply.ok) {
          handlers.apply(reply.result)
        } else if (reply.code === 'host_not_owned' || mainLacksTarget(reply.code)) {
          // Why lacking: main's copy lags the window's here (the window still saves its own).
          handlers.asToday()
        } else {
          console.warn(`[layout-owner] ${command.type} refused:`, reply.code)
          handlers.refused?.(reply.code)
        }
      },
      (error: unknown) => {
        // Why as today: a thrown write is rolled back. An indeterminate disk write is not, and may
        // leave a pane main minted; accepted until main is the only writer.
        console.warn(`[layout-owner] ${command.type} failed:`, errorMessage(error))
        handlers.asToday()
      }
    )
    // A throwing handler is not a failed call; it must not run the fallback too.
    .catch((error: unknown) => {
      console.warn(`[layout-owner] ${command.type} handler threw:`, errorMessage(error))
    })
  return true
}

function mainLacksTarget(code: LayoutRefusalCode): boolean {
  return code === 'workspace_not_found' || code === 'tab_not_found' || code === 'pane_not_found'
}

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error
}

/** Equalizes a tab's panes, then `then` runs (focus); in a layout-owner build main equalizes first. */
export function equalizeTerminalPanes(
  pane: { worktreeId: string; tabId: string; getManager: () => PaneManager | null },
  then: (manager: PaneManager) => void
): void {
  const equalize = (): void => {
    const manager = pane.getManager()
    if (manager) {
      manager.equalizePaneSizes()
      then(manager)
    }
  }
  // Switch point: main equalizes the tab first; the window then redraws it.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    sendPaneCommandToLayoutOwner(
      pane.worktreeId,
      { type: 'equalizePanes', tabId: pane.tabId },
      { apply: equalize, asToday: equalize }
    )
  ) {
    return
  }
  equalize()
}
