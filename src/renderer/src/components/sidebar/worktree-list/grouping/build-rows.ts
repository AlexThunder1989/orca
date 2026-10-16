import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import type { AppState } from '../../../../store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { ALL_GROUP_KEY, ALL_GROUP_META, PINNED_GROUP_KEY, PINNED_GROUP_META } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedWorktreeHostContextLabels,
  getNoticeHostContextLabels
} from './host-labels'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from '../../../../../../shared/project-section-grouping'
import {
  buildWorktreeOccurrencePlan,
  type WorktreeOccurrenceSection
} from '../../../../../../shared/worktree-occurrence-plan'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import { appendProjectGroupSections, getProjectGroupOccurrencePaths } from './project-group-sections'
import { getSidebarLineageChildren } from '../../pinned-section-worktrees'
import { emitPinnedGroup } from './pinned-group-rows'
import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildPendingCreationRow
} from './row-builders'
import {
  compareFolderWorkspacesForDisplay,
  getRenderableFolderWorkspaces
} from './folder-workspace-lanes'
import { getPinnedWorktreeDisplayPolicy } from './row-types'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  PinnedWorktreeDisplayPolicy,
  Row,
  WorktreeGroupBy
} from './row-types'
import { orderMainWorktreeFirst, getRenderedNaturalAnchorRepoIds } from './section-order'
import { withRepoSectionDisplayLabels } from '../../../../../../shared/project-section-order'
import { buildOrderedGroups } from './worktree-grouping'

type SidebarOccurrenceSection = WorktreeOccurrenceSection<Worktree> & { group: WorktreeGroupEntry }

export function buildSidebarRowPlan(
  groupBy: WorktreeGroupBy,
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  _collapsedGroups: Set<string>,
  repoOrder?: Map<string, number>,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  projectOrderBy: ProjectOrderBy = 'manual',
  lineageById: Record<string, WorktreeLineage> = {},
  worktreeMap = new Map<string, Worktree>(worktrees.map((worktree) => [worktree.id, worktree])),
  nestLineage = false,
  settings?: AppState['settings'],
  projectGroups: readonly ProjectGroup[] = [],
  placeholderRepoIds: ReadonlySet<string> = new Set(),
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate> = new Map(),
  newExternalWorktreesInboxByRepo: ReadonlyMap<
    string,
    NewExternalWorktreesInboxCandidate
  > = new Map(),
  pendingCreations: readonly PendingCreationRef[] = [],
  projectGrouping?: ProjectGroupingModel,
  folderWorkspaces: readonly FolderWorkspace[] = [],
  hostLabelById?: ReadonlyMap<string, string>,
  defaultHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy = getPinnedWorktreeDisplayPolicy(settings),
  filterRepoIds: readonly string[] = []
) {
  const projectIndex = buildProjectGroupingIndex(projectGrouping)
  // Membership is decided once, above the groupBy switch: every mode renders the
  // same set of folder workspaces and only chooses where they land (#15362).
  const renderableFolderWorkspaces = getRenderableFolderWorkspaces(folderWorkspaces, projectGroups)
  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of pendingCreations) {
    const list = pendingByRepo.get(creation.repoId) ?? []
    list.push(creation)
    pendingByRepo.set(creation.repoId, list)
  }

  const projectGroupPaths = getProjectGroupOccurrencePaths(projectGroups)
  const occurrencePlan = buildWorktreeOccurrencePlan({
    rows: worktrees,
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: nestLineage
      ? getSidebarLineageChildren(worktrees, lineageById, worktreeMap, filterRepoIds)
      : new Map<string, Worktree[]>(),
    isPinned: (worktree) => worktree.isPinned === true,
    duplicatePinned: pinnedDisplayPolicy === 'duplicate-in-groups',
    owningSectionOf: (worktree) => getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex),
    projectIdOf: (worktree) => worktree.repoId,
    sectionsOf: ({ pinned, natural, displayRootByIdentity }) => {
      const groups: OrderedGroupEntry[] =
        groupBy === 'none'
          ? [[ALL_GROUP_KEY, { label: ALL_GROUP_META.label, items: [...natural], repoIds: new Set() }]]
          : buildOrderedGroups({
            groupBy,
            naturalWorktrees: natural,
            repoMap,
            prCache,
            settings,
            workspaceStatuses,
            projectIndex,
            displayRootByIdentity,
            placeholderRepoIds,
            importedWorktreesByRepo,
            newExternalWorktreesInboxByRepo,
            pendingByRepo,
            repoOrder,
            projectOrderBy,
            folderWorkspaces: renderableFolderWorkspaces
          })
      if (pinned.length > 0) {
        groups.unshift([
          PINNED_GROUP_KEY,
          { label: PINNED_GROUP_META.label, items: pinned, repoIds: new Set() }
        ])
      }
      return groups.map(([key, group]): SidebarOccurrenceSection => {
        const revealPath =
          groupBy === 'repo' && key !== PINNED_GROUP_KEY && group.repo?.projectGroupId
            ? projectGroupPaths.get(group.repo.projectGroupId)
            : undefined
        return {
          key,
          group,
          placement: key === PINNED_GROUP_KEY ? 'pinned' : 'natural',
          items:
            groupBy === 'repo' && key !== PINNED_GROUP_KEY
              ? orderMainWorktreeFirst(group.items)
              : group.items,
          revealPath: { key, parent: revealPath }
        }
      })
    }
  })
  const pinnedSectionWorktrees =
    occurrencePlan.sections.find((section) => section.key === PINNED_GROUP_KEY)?.group.items ?? []
  const orderedGroups: OrderedGroupEntry[] = occurrencePlan.sections
    .filter((section) => section.key !== PINNED_GROUP_KEY)
    .map((section) => [section.key, section.group])
  const naturalWorktrees = orderedGroups.flatMap(([, group]) => group.items)
  const render = (collapsedGroups: Set<string>): Row[] => {
    const result: Row[] = []
    if (groupBy !== 'repo') {
      for (const creation of pendingCreations) {
        result.push(buildPendingCreationRow(creation, repoMap))
      }
    }
    // Why the full set: under the default pinned policy a pinned worktree exists
    // only in the Pinned section, and its host is part of whether the sidebar is
    // mixed at all. Scoping to naturalWorktrees left pinned remotes unlabelled.
    const mixedWorktreeHostContextLabels = getMixedWorktreeHostContextLabels(
      worktrees,
      repoMap,
      hostLabelById,
      defaultHostId
    )
    // Why here and not per section: a notice row can land in the pinned section
    // instead of its project's own, and the host ambiguity it resolves belongs to
    // the project either way. repoMap is the unfiltered universe; the candidate
    // maps are host-filter scoped, so only they gate eligibility.
    const noticeHostContextLabelByRepoId = getNoticeHostContextLabels(
      new Set([...importedWorktreesByRepo.keys(), ...newExternalWorktreesInboxByRepo.keys()]),
      repoMap.keys(),
      repoMap,
      projectIndex,
      hostLabelById
    )
    const renderedNaturalAnchorRepoIds = getRenderedNaturalAnchorRepoIds({
      groupBy,
      worktrees: naturalWorktrees,
      repoMap,
      prCache,
      collapsedGroups,
      workspaceStatuses,
      settings,
      projectGrouping
    })
    emitPinnedGroup(
      pinnedSectionWorktrees,
      repoMap,
      defaultHostId,
      collapsedGroups,
      renderedNaturalAnchorRepoIds,
      importedWorktreesByRepo,
      groupBy !== 'repo',
      result,
      occurrencePlan,
      noticeHostContextLabelByRepoId,
      mixedWorktreeHostContextLabels
    )
    if (groupBy === 'none') {
      // Why folder workspaces gate this too: an account with only folder
      // workspaces rendered nothing at all in flat mode before (#15362).
      if (naturalWorktrees.length > 0 || renderableFolderWorkspaces.length > 0) {
        result.push({
          type: 'header',
          key: ALL_GROUP_KEY,
          label: ALL_GROUP_META.label,
          count: naturalWorktrees.length + renderableFolderWorkspaces.length,
          tone: ALL_GROUP_META.tone,
          icon: ALL_GROUP_META.icon,
          hostWorktreeCounts: getLaneHostWorktreeCounts(
            naturalWorktrees,
            renderableFolderWorkspaces,
            repoMap,
            defaultHostId
          ),
          hostWorktreeIds: getLaneHostWorktreeIds(
            naturalWorktrees,
            renderableFolderWorkspaces,
            repoMap,
            defaultHostId
          ),
          worktreeIds: naturalWorktrees.map((worktree) => worktree.id)
        })
        if (!collapsedGroups.has(ALL_GROUP_KEY)) {
          appendWorktreeRows(result, repoMap, occurrencePlan, {
            collapsedGroups,
            groupDepth: 0,
            sectionKey: ALL_GROUP_KEY,
            hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels
          })
          for (const pair of [...renderableFolderWorkspaces].sort((left, right) =>
            compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
          )) {
            result.push(buildFolderWorkspaceRow(pair, 0))
          }
        }
      }
      return result
    }

    const sectionContext: SectionAppendContext = {
      result,
      groupBy,
      collapsedGroups,
      workspaceStatuses,
      repoMap,
      defaultHostId,
      hostLabelById,
      projectIndex,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo,
      pendingByRepo,
      mixedWorktreeHostContextLabels,
      noticeHostContextLabelByRepoId,
      occurrencePlan
    }

    if (groupBy !== 'repo' || projectGroups.length === 0) {
      appendOrderedGroups(
        sectionContext,
        groupBy === 'repo' ? withRepoSectionDisplayLabels(orderedGroups) : orderedGroups
      )
      return result
    }

    appendProjectGroupSections(sectionContext, {
      orderedGroups,
      projectGroups,
      folderWorkspaces: renderableFolderWorkspaces,
      projectOrderBy,
      repoOrder
    })

    return result
  }
  return { occurrencePlan, render }
}

export function buildRows(...args: Parameters<typeof buildSidebarRowPlan>): Row[] {
  return buildSidebarRowPlan(...args).render(args[4])
}
