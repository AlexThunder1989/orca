// A browser tab a host with no window runs, saved as a window saves its own: the tab, its page and
// the page's last address. A restarted host lists it and starts the page when something first
// uses it, as a window restores its browser tabs.

import type { BrowserPage } from '../../shared/browser-workspace-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { BLANK_BROWSER_TAB_STATE } from '../../shared/workspace-layout/workspace-layout-beside'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { randomUUID } from 'node:crypto'

export type ServeBrowserPageState = {
  worktreeId: string
  pageId: string
  url: string
  title: string
}

/** The saved browser tab showing this page, and the page; a host's own tab is named by its page. */
export function findSavedBrowserPage(
  session: WorkspaceSessionState,
  worktreeId: string,
  pageId: string
): { tabId: string; page: BrowserPage } | null {
  for (const tab of session.browserTabsByWorktree?.[worktreeId] ?? []) {
    const page = session.browserPagesByWorkspace?.[tab.id]?.find((entry) => entry.id === pageId)
    if (page) {
      return { tabId: tab.id, page }
    }
  }
  return null
}

/** The partition with a just-created page's tab, or null when it is saved already or refused. */
export function withOpenedServeBrowserTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  page: ServeBrowserPageState & { profileId?: string; groupId?: string }
): WorkspaceSessionState | null {
  if (findSavedBrowserPage(session, page.worktreeId, page.pageId)) {
    return null
  }
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const now = Date.now()
  const applied = applyLayoutCommand(
    loaded.layout,
    {
      type: 'openBrowserTab',
      workspace: page.worktreeId,
      pageId: page.pageId,
      ...(page.profileId ? { profileId: page.profileId } : {}),
      ...(page.groupId ? { groupId: page.groupId } : {})
    },
    { mintId: randomUUID, mintLeafId: randomUUID, now: () => now }
  )
  if (!applied.ok) {
    return null
  }
  const { facts } = loaded
  const state = { ...BLANK_BROWSER_TAB_STATE, url: page.url, title: page.title }
  const savedPage: BrowserPage = {
    ...state,
    id: page.pageId,
    workspaceId: page.pageId,
    worktreeId: page.worktreeId,
    createdAt: now
  }
  return saveWorkspaceLayout({
    ...loaded,
    layout: applied.model,
    facts: {
      ...facts,
      browserTabs: {
        ...facts.browserTabs,
        [page.worktreeId]: { ...facts.browserTabs[page.worktreeId], [page.pageId]: state }
      },
      browserPagesByWorkspace: { ...facts.browserPagesByWorkspace, [page.pageId]: [savedPage] }
    }
  })
}

/**
 * The partition with the page's last address, or null when no saved tab shows the page or it is
 * unchanged. Only address fields change, so the layout is not reloaded.
 */
export function withServeBrowserPageState(
  session: WorkspaceSessionState,
  page: ServeBrowserPageState
): WorkspaceSessionState | null {
  const saved = findSavedBrowserPage(session, page.worktreeId, page.pageId)
  if (!saved || (saved.page.url === page.url && saved.page.title === page.title)) {
    return null
  }
  const state = { url: page.url, title: page.title }
  const tabs = session.browserTabsByWorktree?.[page.worktreeId] ?? []
  return {
    ...session,
    browserTabsByWorktree: {
      ...session.browserTabsByWorktree,
      // The tab mirrors its active page only.
      [page.worktreeId]: tabs.map((tab) =>
        tab.id === saved.tabId && (!tab.activePageId || tab.activePageId === page.pageId)
          ? { ...tab, ...state }
          : tab
      )
    },
    browserPagesByWorkspace: {
      ...session.browserPagesByWorkspace,
      [saved.tabId]: (session.browserPagesByWorkspace?.[saved.tabId] ?? []).map((entry) =>
        entry.id === page.pageId ? { ...entry, ...state } : entry
      )
    }
  }
}

/** The partition without the tab showing the page, or null when no saved tab shows it. */
export function withClosedServeBrowserTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  pageId: string
): WorkspaceSessionState | null {
  const saved = findSavedBrowserPage(session, worktreeId, pageId)
  if (!saved) {
    return null
  }
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const applied = applyLayoutCommand(
    loaded.layout,
    { type: 'closeTabs', workspace: worktreeId, tabIds: [saved.tabId], force: true },
    { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  )
  if (!applied.ok) {
    return null
  }
  const { [saved.tabId]: _closed, ...pages } = loaded.facts.browserPagesByWorkspace ?? {}
  return saveWorkspaceLayout({
    ...loaded,
    layout: applied.model,
    facts: { ...loaded.facts, browserPagesByWorkspace: pages }
  })
}
