// A runtime-started pane, written through the layout module before its terminal starts (design
// 4.1): Loader, then the command, then the Serializer, so the partition is rewritten from one model.

import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { locatePane } from '../../../shared/workspace-layout/workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { paneKeyOf } from '../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { patchStoredSession } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import { followRemoteSessionAfterPaneClose } from './pane-close-remote-session'

/** A new tab, or a split of an existing pane, with the ids its terminal will run under. */
export type TerminalPaneAdmission =
  | (CommandOf<'createTerminalTab'> & { tabId: string; leafId: string })
  | (CommandOf<'splitPane'> & { newLeafId: string })

/** 'exists': the start attaches to a pane already in the layout, so nothing is written. */
export type TerminalPaneAdmissionOutcome = 'admitted' | 'exists' | LayoutRefusalCode

/** The partition to write, or null when nothing changes. */
export type PaneLayoutChange<T> = { value: T; session: WorkspaceSessionState | null }

export function admitPaneToSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  admission: TerminalPaneAdmission
): PaneLayoutChange<TerminalPaneAdmissionOutcome> {
  const leafId = admission.type === 'createTerminalTab' ? admission.leafId : admission.newLeafId
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[admission.workspace]
  if (workspace && locatePane(workspace, paneKeyOf(admission.tabId, leafId))) {
    return { value: 'exists', session: null }
  }
  const change = applyToSession(loaded, admission)
  return { ...change, value: change.value.ok ? 'admitted' : change.value.code }
}

export function withdrawPaneFromSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  pane: CommandOf<'closePane'>
): PaneLayoutChange<LayoutRefusalCode | null> {
  const change = applyToSession(loadWorkspaceLayout(hostId, session, nameBasedLoadContext()), pane)
  return { ...change, value: change.value.ok ? null : change.value.code }
}

/**
 * A client's layout command (`layout.apply`), with main minting every new id. Only the records the
 * command changed are written; the rest of the partition stays as stored, normalized or not.
 */
export function applyCommandToSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  command: LayoutCommand
): PaneLayoutChange<LayoutApplyOutcome> {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  return applyToSession(loaded, command, (after) => {
    const patched = patchStoredSession(session, saveWorkspaceLayout(loaded), after)
    return patched === session ? null : followRemoteSessionAfterPaneClose(command, session, patched)
  })
}

function applyToSession(
  loaded: LoadedWorkspaceLayout,
  command: LayoutCommand,
  write: (after: WorkspaceSessionState) => WorkspaceSessionState | null = (after) => after
): PaneLayoutChange<LayoutApplyOutcome> {
  const applied = applyLayoutCommand(loaded.layout, command, {
    mintId: randomUUID,
    mintLeafId: randomUUID,
    now: Date.now
  })
  return applied.ok
    ? {
        value: { ok: true, result: applied.result },
        session: write(saveWorkspaceLayout({ ...loaded, layout: applied.model }))
      }
    : { value: { ok: false, code: applied.code }, session: null }
}
