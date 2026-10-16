import type { TerminalSplitOptions } from './terminal-split-surface'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from '../../session-tabs/explicit-terminal-close-stops'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import type { Worktree } from '../../../../shared/worktree/types'

export abstract class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  protected abstract splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts?: TerminalSplitOptions,
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit>

  protected abstract waitForLeafInTab(
    tabId: string,
    leafId: string,
    timeoutMs?: number
  ): Promise<string>

  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts, createdWorktree)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'

    const newLeafId = randomUUID()

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId
    })

    const newHandle = await this.waitForLeafInTab(leaf.tabId, newLeafId)
    return {
      handle: newHandle,
      tabId: leaf.tabId,
      paneRuntimeId: leaf.paneRuntimeId,
      leafId: newLeafId
    }
  }
}
