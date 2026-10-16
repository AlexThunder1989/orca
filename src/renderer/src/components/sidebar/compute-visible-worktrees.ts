import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { filterWorkspaceRows } from '../../../../shared/workspace-view/workspace-row-filters'
import { buildDesktopWorkspaceRowFactReader } from './desktop-workspace-row-facts'
import { sidebarWorkspaceRowFilters } from './sidebar-filter-actions'
import { getLineageAncestorIndex, getSortedWorktreeRankIndex } from './visible-worktree-indexes'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from './worktree-lineage-projection'

// Why its own module: the sidebar filter pipeline is a pure function of its options, and keeping
// it free of the store lets the store's own attention slice ask it without an import cycle.

export type VisibleWorktreeOptions = {
  filterRepoIds: readonly string[]
  showSleepingWorkspaces: boolean
  tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
  ptyIdsByTabId: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, { id: string }[]> | null
  worktreeIdsWithLiveAgent: ReadonlySet<string>
  worktreeIdsWithStructuredChat?: ReadonlySet<string>
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  alwaysShowDefaultBranchWorkspace?: boolean
  repoMap: Map<string, Repo>
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  defaultHostId: ExecutionHostId
  worktreeLineageById: Record<string, WorktreeLineage>
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
  /** Exempt from the sleeping sweep only; unlike forcedVisibleWorktreeIds, every other filter still applies. */
  sleepingSweepExemptWorktreeIds?: ReadonlySet<string>
}

export function computeVisibleWorktrees(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedIds: string[],
  opts: VisibleWorktreeOptions
): Worktree[] {
  let all: Worktree[] = getIndexedAllWorktrees(worktreesByRepo)

  // Why: sidebar lineage is structural. Archived workspaces stay hidden, but
  // every other valid ancestor can bypass filters so children never orphan.
  const lineageAncestorById = getLineageAncestorIndex(worktreesByRepo)
  const selectedRepoIds = opts.filterRepoIds.length > 0 ? new Set(opts.filterRepoIds) : null

  all = filterWorkspaceRows(
    all,
    sidebarWorkspaceRowFilters(opts),
    buildDesktopWorkspaceRowFactReader(opts)
  )

  if (opts.forcedVisibleWorktreeIds && opts.forcedVisibleWorktreeIds.length > 0) {
    const includedIds = new Set(all.map((worktree) => worktree.id))
    for (const worktreeId of opts.forcedVisibleWorktreeIds) {
      const worktree = lineageAncestorById.get(worktreeId)
      if (worktree && !includedIds.has(worktreeId)) {
        includedIds.add(worktreeId)
        all.push(worktree)
      }
    }
  }

  // Apply cached sort order. Items not yet in the cache (e.g. brand-new
  // worktrees before the next sortEpoch bump) are appended at the end.
  // Manual placement belongs to the parent, even when a hidden child has a higher rank.
  if (opts.injectLineageAncestors !== false && opts.preserveLineageParentOrder) {
    all = addVisibleLineageAncestors(
      all,
      lineageAncestorById,
      opts.worktreeLineageById,
      selectedRepoIds
    )
  }
  const orderIndex = getSortedWorktreeRankIndex(sortedIds)
  all.sort((a, b) => {
    const ai = orderIndex.get(a.id) ?? Infinity
    const bi = orderIndex.get(b.id) ?? Infinity
    return ai - bi
  })

  return opts.injectLineageAncestors === false || opts.preserveLineageParentOrder
    ? all
    : addVisibleLineageAncestors(
        all,
        lineageAncestorById,
        opts.worktreeLineageById,
        selectedRepoIds
      )
}

function addVisibleLineageAncestors(
  worktrees: Worktree[],
  worktreeById: Map<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>,
  selectedRepoIds: ReadonlySet<string> | null
): Worktree[] {
  const result: Worktree[] = []
  const included = new Set<string>()
  const visiting = new Set<string>()
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeById)

  const addWithAncestors = (worktree: Worktree): void => {
    const identity = getWorktreeHostIdentity(worktree)
    if (included.has(identity) || visiting.has(identity)) {
      return
    }
    visiting.add(identity)
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeById, cyclicLineageIds)
    if (
      lineage.state === 'valid' &&
      (!selectedRepoIds || selectedRepoIds.has(lineage.parent.repoId))
    ) {
      // Why: a repository filter is an explicit boundary; other filters keep
      // valid ancestors so visible children retain their hierarchy.
      addWithAncestors(lineage.parent)
    }
    visiting.delete(identity)
    if (!included.has(identity)) {
      included.add(identity)
      result.push(worktree)
    }
  }

  for (const worktree of worktrees) {
    addWithAncestors(worktree)
  }
  return result
}

export function computeVisibleWorktreeIds(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedIds: string[],
  opts: VisibleWorktreeOptions
): string[] {
  return computeVisibleWorktrees(worktreesByRepo, sortedIds, opts).map((worktree) => worktree.id)
}
