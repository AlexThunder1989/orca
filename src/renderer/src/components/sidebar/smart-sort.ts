import type { Repo } from '../../../../shared/repo-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { basename } from '@/lib/path'
import {
  buildWorkspaceRowComparator,
  recentActivityWithCreateGrace,
  type WorkspaceSortBy
} from '../../../../shared/workspace-view/workspace-row-sort'
import {
  IDLE,
  buildAttentionByWorktree,
  hasFreshAttributedAgentStatus,
  type WorktreeAttention
} from './smart-attention'

export type SortBy = WorkspaceSortBy

export { CREATE_GRACE_MS } from '../../../../shared/workspace-view/workspace-row-sort'

/** Recent-sort rank: `lastActivityAt`, floored at `createdAt + CREATE_GRACE_MS` while that window is open. */
export function effectiveRecentActivity(worktree: Worktree, now: number): number {
  return recentActivityWithCreateGrace(worktree.lastActivityAt, worktree.createdAt, now)
}

export type WorktreeSortLabelInput = Pick<Worktree, 'displayName' | 'path' | 'id'>

export function getWorktreeSortLabel(worktree: WorktreeSortLabelInput): string {
  const displayName = typeof worktree.displayName === 'string' ? worktree.displayName.trim() : ''
  if (displayName) {
    return displayName
  }

  // Why: persisted or remote worktree state can briefly omit displayName after
  // a custom workspace name is removed; sorting must stay render-safe.
  const pathLabel = typeof worktree.path === 'string' ? basename(worktree.path).trim() : ''
  return pathLabel || worktree.id
}

/**
 * Sort labels precomputed once per sort, so the O(N log N) comparator does O(1)
 * lookups instead of re-deriving both labels on every comparison.
 *
 * Why keyed on the row and not its id: a two-host id collision (STA-4343) puts
 * two rows with different paths under one id, and an id key would hand one of
 * them the other's label.
 */
export type WorktreeSortLabels = ReadonlyMap<WorktreeSortLabelInput, string>

export function buildWorktreeSortLabels<T extends WorktreeSortLabelInput>(
  worktrees: readonly T[]
): Map<WorktreeSortLabelInput, string> {
  const labels = new Map<WorktreeSortLabelInput, string>()
  for (const worktree of worktrees) {
    labels.set(worktree, getWorktreeSortLabel(worktree))
  }
  return labels
}

export function compareWorktreeSortLabel(
  a: WorktreeSortLabelInput,
  b: WorktreeSortLabelInput,
  labels?: WorktreeSortLabels
): number {
  return (labels?.get(a) ?? getWorktreeSortLabel(a)).localeCompare(
    labels?.get(b) ?? getWorktreeSortLabel(b)
  )
}

/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 *
 * Smart mode requires `attentionByWorktree` — a per-worktree class +
 * timestamp map built once before sorting (see `buildAttentionByWorktree`).
 * Why non-optional: a forgotten caller would silently regress every worktree
 * to Class 5 (idle) and degrade the comparator to recent-activity ordering;
 * making the param required surfaces the omission as a typecheck error.
 */
export function buildWorktreeComparator(
  sortBy: SortBy,
  repoMap: Map<string, Repo>,
  now: number,
  attentionByWorktree: Map<string, WorktreeAttention>,
  labels?: WorktreeSortLabels
): (a: Worktree, b: Worktree) => number {
  const label = (worktree: Worktree): string =>
    labels?.get(worktree) ?? getWorktreeSortLabel(worktree)
  return buildWorkspaceRowComparator<Worktree>(sortBy, {
    label,
    repoLabel: (worktree) => repoMap.get(worktree.repoId)?.displayName ?? '',
    recentActivity: (worktree) => effectiveRecentActivity(worktree, now),
    // Why fallback to sortOrder: existing users have a persisted smart-sort snapshot but no
    // manualOrder yet, so Manual starts from that order instead of alphabetizing.
    manualRank: (worktree) => worktree.manualOrder ?? worktree.sortOrder,
    compareSmart: (a, b) => {
      const aw = attentionByWorktree.get(a.id) ?? IDLE
      const bw = attentionByWorktree.get(b.id) ?? IDLE
      return (
        // Why: 1 < 2 < 3 < 4 < 5 — lower class outranks higher.
        aw.cls - bw.cls ||
        // Why: within a class, the more recent attention event ranks first.
        bw.attentionTimestamp - aw.attentionTimestamp ||
        // Why: idle worktrees fall through to recency (and the create-grace
        // floor for brand-new worktrees) before alphabetical.
        effectiveRecentActivity(b, now) - effectiveRecentActivity(a, now)
      )
    }
  })
}

/**
 * Sort worktrees by the smart-attention comparator (status class first,
 * recency-of-attention second). On cold start (no live PTYs yet), falls back
 * to persisted `sortOrder` descending so the sidebar restores the pre-quit
 * order until the agent-status snapshot lands.
 *
 * Both the palette and `getVisibleWorktreeIds()` import this to avoid
 * duplicating the cold/warm branching logic.
 *
 * `agentStatusByPaneKey` carries the primary signal; `runtimePaneTitlesByTabId`
 * and `ptyIdsByTabId` enable the title-heuristic fallback for hookless agents
 * (Edge case 9 in the design doc). Why all three are non-optional: a forgotten
 * caller would silently regress every worktree to Class 5 or quietly disable
 * the hookless-fallback path.
 */
export function sortWorktreesSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  repoMap: Map<string, Repo>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>,
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
): Worktree[] {
  // Why: `tabHasLivePty` (over `ptyIdsByTabId`) is the source of truth for
  // liveness — slept terminals retain `tab.ptyId` as a wake hint, so reading
  // it directly would falsely keep cold-start ordering off after restart.
  const hasAnyLivePty = Object.values(tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))
  )

  const now = Date.now()
  const labels = buildWorktreeSortLabels(worktrees)
  if (!hasAnyLivePty && !hasFreshAttributedAgentStatus(agentStatusByPaneKey, now, tabsByWorktree)) {
    // Cold start: use persisted sortOrder snapshot until the agent-status
    // snapshot lands and a warm sort runs.
    return [...worktrees].sort(
      (a, b) => b.sortOrder - a.sortOrder || compareWorktreeSortLabel(a, b, labels)
    )
  }

  const attentionByWorktree = buildAttentionByWorktree(
    worktrees,
    tabsByWorktree,
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    now,
    migrationUnsupportedByPtyId,
    terminalLayoutsByTabId
  )

  return [...worktrees].sort(
    buildWorktreeComparator('smart', repoMap, now, attentionByWorktree, labels)
  )
}
