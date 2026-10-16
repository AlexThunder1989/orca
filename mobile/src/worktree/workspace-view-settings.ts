// Bi-directional mapping between the mobile workspaces screen's local view model
// and the desktop's shared PersistedUIState (read/written via the ui.get/ui.set
// RPCs). Keeping these settings in the same global store is what lets a grouping
// or filter change on the phone show up on desktop and vice-versa.

import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import {
  withDefaultWorkspaceStatuses,
  DEFAULT_WORKSPACE_STATUSES
} from '../../../src/shared/workspace-statuses'
import {
  NO_WORKSPACE_ROW_FILTERS,
  WORKSPACE_ROW_FILTER_KEYS,
  WORKSPACE_ROW_FILTER_UI_FIELDS
} from '../../../src/shared/workspace-view/workspace-row-filters'
import { resolveVisibleWorkspaceHostIds } from '../../../src/shared/workspace-view/workspace-host-visibility'
import type { PersistedUIState } from '../../../src/shared/persisted-ui-state-types'
import type { WORKSPACE_VIEW_UI_FIELDS } from '../../../src/shared/workspace-view/workspace-view-ui-fields'
import type { FilterState } from './workspace-list-types'
import {
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_SORT_BY_CHOICES
} from '../../../src/shared/workspace-view/workspace-view-options'

// Desktop PersistedUIState fields this screen syncs (a structural subset).
export type WorkspaceViewSettings = {
  [
    Key in keyof FilterState as (typeof WORKSPACE_ROW_FILTER_UI_FIELDS)[Key]
  ]?: Key extends 'filterRepoIds'
    ? string[]
    : Key extends 'visibleHostIds'
      ? string[] | null
      : FilterState[Key]
} & Partial<Pick<PersistedUIState, (typeof WORKSPACE_VIEW_UI_FIELDS)[number]>>

export type MobileViewState = {
  groupBy: PersistedUIState['groupBy']
  sortBy: PersistedUIState['sortBy']
  filters: FilterState
  collapsedGroups: readonly string[]
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  /**
   * Whether the desktop shares "Hide other-client workspaces" with this phone. One that does not
   * (before #28986) marks a row other-client only while its own filter hides it. Null until the
   * first ui.get, so a new desktop's marks don't hide rows before its filter value arrives.
   */
  sharesOtherClientFilter: boolean | null
}

/** What the screen shows until the desktop's own values arrive. */
export const INITIAL_MOBILE_VIEW: MobileViewState = {
  groupBy: 'repo',
  sortBy: 'recent',
  filters: NO_WORKSPACE_ROW_FILTERS,
  collapsedGroups: [],
  workspaceStatuses: DEFAULT_WORKSPACE_STATUSES,
  sharesOtherClientFilter: null
}

/** An edit: the fields it sets, and for filters only the filters it touches. */
export type MobileViewPatch = Partial<
  Omit<MobileViewState, 'filters' | 'sharesOtherClientFilter'>
> & {
  filters?: Partial<FilterState>
}

const GROUP_BY_VALUES: readonly string[] = WORKSPACE_GROUP_BY_CHOICES.map((choice) => choice.id)
const SORT_BY_VALUES: readonly string[] = WORKSPACE_SORT_BY_CHOICES.map((choice) => choice.id)

function isGroupBy(value: string | undefined): value is PersistedUIState['groupBy'] {
  return value !== undefined && GROUP_BY_VALUES.includes(value)
}

function isSortBy(value: string | undefined): value is PersistedUIState['sortBy'] {
  return value !== undefined && SORT_BY_VALUES.includes(value)
}

/** The filters the list applies: an older desktop's other-client marks are already its verdict. */
export function rowFiltersForView(view: MobileViewState): FilterState {
  return view.sharesOtherClientFilter === false
    ? { ...view.filters, hideWorkspacesFromOtherDevices: true }
    : view.filters
}

/**
 * Map a user edit to the ui.set payload, carrying only the fields the edit touched.
 *
 * Why patch-only (STA-5781): the shared store is edited concurrently by desktop and web clients.
 * Echoing the whole snapshot let a stale mirror revert sibling fields another client had just
 * changed; the host merges partial updates field-by-field.
 */
export function buildWorkspaceViewSettingsUpdate(
  patch: MobileViewPatch,
  next: MobileViewState
): WorkspaceViewSettings {
  const update: WorkspaceViewSettings = {}
  if ('groupBy' in patch) {
    update.groupBy = next.groupBy
  }
  if ('sortBy' in patch) {
    update.sortBy = next.sortBy
  }
  for (const key of WORKSPACE_ROW_FILTER_KEYS) {
    if (patch.filters && key in patch.filters) {
      const value = next.filters[key]
      Object.assign(update, {
        [WORKSPACE_ROW_FILTER_UI_FIELDS[key]]: Array.isArray(value) ? [...value] : value
      })
    }
  }
  const hostIds = next.filters.visibleHostIds
  // An older desktop reads its legacy scope when the list is null, so "all" must be written too.
  if (patch.filters && 'visibleHostIds' in patch.filters && (hostIds?.length ?? 1) === 1) {
    update.workspaceHostScope = hostIds?.[0] ?? 'all'
  }
  if ('collapsedGroups' in patch) {
    update.collapsedGroups = [...next.collapsedGroups]
  }
  if ('workspaceStatuses' in patch) {
    update.workspaceStatuses = [...next.workspaceStatuses]
  }
  return update
}

// Apply a desktop PersistedUIState onto the local view state, leaving any field
// the desktop hasn't set untouched (so a partial ui.get doesn't clobber).
export function applyDesktopViewSettings(
  current: MobileViewState,
  settings: WorkspaceViewSettings
): MobileViewState {
  // Why: a partially hydrated desktop settings payload may carry an empty
  // status catalog; mobile must keep renderable groups instead of hiding rows.
  const workspaceStatuses = settings.workspaceStatuses
    ? withDefaultWorkspaceStatuses(settings.workspaceStatuses)
    : current.workspaceStatuses
  const filters: FilterState = { ...current.filters }
  for (const key of WORKSPACE_ROW_FILTER_KEYS) {
    const value = settings[WORKSPACE_ROW_FILTER_UI_FIELDS[key]]
    if (key !== 'visibleHostIds' && value !== undefined) {
      Object.assign(filters, { [key]: value })
    }
  }
  // As the desktop reads it: with no list saved, its legacy single-host scope still narrows.
  if (settings.visibleWorkspaceHostIds !== undefined || settings.workspaceHostScope !== undefined) {
    filters.visibleHostIds = resolveVisibleWorkspaceHostIds(
      settings.visibleWorkspaceHostIds,
      settings.workspaceHostScope
    )
  }
  return {
    groupBy: isGroupBy(settings.groupBy) ? settings.groupBy : current.groupBy,
    sortBy: isSortBy(settings.sortBy) ? settings.sortBy : current.sortBy,
    filters,
    collapsedGroups: settings.collapsedGroups ?? current.collapsedGroups,
    workspaceStatuses,
    // Each ui.get is the desktop's whole state, so the field's absence means it keeps the filter.
    sharesOtherClientFilter: settings.hideWorkspacesFromOtherDevices !== undefined
  }
}
