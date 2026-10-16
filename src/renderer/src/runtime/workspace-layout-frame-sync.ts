// The window's layout slices drawn from main's layout stream (design phase E2b), in a layout-owner
// build only. Main publishes every workspace it holds; this window shows a frame's workspace when
// it writes that workspace to a partition this machine owns (a paired server's stay the mirror's)
// and already holds it (startup restore keeps only workspaces the catalog knows).
//
// Frames wait while this window owes main a session write: until main has the window's own change,
// a frame would put back what the window just changed. Main sends a write's frames before it
// acknowledges the write, so the cache is current by the time the window is idle again.
// A frame that changes only live terminal titles never waits: it touches no structure.

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { applyLayoutFrame, EMPTY_WORKSPACE_LAYOUT_CACHE } from '@/store/workspace-layout-cache'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import { buildLayoutFrameSlices, shownLiveTitle } from '@/store/workspace-layout-frame-slices'
import { buildLayoutFrameStorePatch } from '@/store/workspace-layout-frame-store-patch'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { buildHostIdByWorktreeId } from '@/lib/workspace-session-host-persistence'
import {
  splitWorkspaceSessionByHost,
  type HostIdByWorktreeId
} from '@/lib/workspace-session-host-split'
import {
  isWindowSessionWriteBusy,
  onWindowSessionWriteIdle
} from '@/lib/window-session-write-activity'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { TerminalTabTitleUpdate } from '@/store/slices/terminal-tab-title-batch'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { subscribeRuntimeLayout } from './runtime-layout-client'

type FrameSyncStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
}

export type WorkspaceLayoutFrameSync = {
  /** Shows every workspace the frames own once the snapshot is in, then keeps them current. */
  start: () => void
  close: () => void
}

/** A bucket, not a host: the view read-back routes the workspaces a rebuild skips here. */
const OTHER_WORKSPACES: ExecutionHostId = 'runtime:frame-sync-other-workspaces'

const structureJsonByLayout = new WeakMap<PublishedWorkspaceLayout, string>()

/** A frame's JSON without live titles, kept per frame: title frames arrive at spinner rate. */
function structureJson(layout: PublishedWorkspaceLayout): string {
  let json = structureJsonByLayout.get(layout)
  if (json === undefined) {
    json = withoutLiveTitles(layout)
    structureJsonByLayout.set(layout, json)
  }
  return json
}

function withoutLiveTitles(layout: PublishedWorkspaceLayout): string {
  return stableJson({
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? {
            ...tab,
            terminal: {
              ...tab.terminal,
              panes: tab.terminal.panes.map(({ liveTitle: _liveTitle, ...pane }) => pane)
            }
          }
        : tab
    )
  })
}

/** Title changes between two frames of one workspace, for the pane each tab shows. */
function liveTitleUpdates(
  shown: PublishedWorkspaceLayout,
  next: PublishedWorkspaceLayout,
  focusedLeafId: (tabId: string) => string | null | undefined
): TerminalTabTitleUpdate[] {
  const shownById = new Map(shown.tabs.map((tab) => [tab.id, tab]))
  const updates: TerminalTabTitleUpdate[] = []
  for (const tab of next.tabs) {
    const shownTab = shownById.get(tab.id)
    if (!tab.terminal || !shownTab) {
      continue
    }
    const focused = focusedLeafId(tab.entityId)
    const title = shownLiveTitle(tab, focused)
    if (title !== undefined && title !== shownLiveTitle(shownTab, focused)) {
      updates.push({ tabId: tab.entityId, title })
    }
  }
  return updates
}

function holdsWorkspace(state: AppState, key: string): boolean {
  return key in state.groupsByWorktree || key in state.unifiedTabsByWorktree
}

export function openWorkspaceLayoutFrameSync(store: FrameSyncStore): WorkspaceLayoutFrameSync {
  let cache: WorkspaceLayoutCache = EMPTY_WORKSPACE_LAYOUT_CACHE
  /** Workspace key → the frame the store shows. */
  let shown: Record<string, PublishedWorkspaceLayout> = {}
  let started = false
  let live = false
  let snapshotReceived = false
  let flushQueued = false

  const rebuild = (state: AppState, keys: string[]): void => {
    // The view and content facts are this window's: read them back out of what it saves.
    const rebuilt = new Set(keys)
    const own = splitWorkspaceSessionByHost(buildWorkspaceSessionPayload(state), (key) =>
      rebuilt.has(key) ? LOCAL_EXECUTION_HOST_ID : OTHER_WORKSPACES
    )[LOCAL_EXECUTION_HOST_ID]!
    const { facts, desktopView } = loadWorkspaceLayoutWithoutReport(
      LOCAL_EXECUTION_HOST_ID,
      own,
      nameBasedLoadContext()
    )
    const built = buildLayoutFrameSlices({
      layouts: Object.fromEntries(keys.map((key) => [key, cache[key]!])),
      facts,
      view: desktopView
    })
    const patch = buildLayoutFrameStorePatch(state, built, keys)
    if (Object.keys(patch).length > 0) {
      store.setState(patch)
    }
  }

  const flush = (): void => {
    flushQueued = false
    if (!live) {
      return
    }
    const state = store.getState()
    let hostIdOf: HostIdByWorktreeId | null = null
    const ownedByPairedServer = (key: string): boolean => {
      hostIdOf ??= buildHostIdByWorktreeId(state)
      return parseExecutionHostId(hostIdOf(key))?.kind === 'runtime'
    }
    const busy = isWindowSessionWriteBusy()
    const nextShown: Record<string, PublishedWorkspaceLayout> = {}
    const structural: string[] = []
    const titleUpdates: TerminalTabTitleUpdate[] = []
    for (const [key, layout] of Object.entries(cache)) {
      const previous = shown[key]
      if (layout === previous || !holdsWorkspace(state, key) || ownedByPairedServer(key)) {
        if (previous) {
          nextShown[key] = previous
        }
        continue
      }
      if (previous && structureJson(previous) === structureJson(layout)) {
        titleUpdates.push(
          ...liveTitleUpdates(
            previous,
            layout,
            (tabId) => state.terminalLayoutsByTabId[tabId]?.activeLeafId
          )
        )
        nextShown[key] = layout
      } else if (busy) {
        if (previous) {
          nextShown[key] = previous
        }
      } else {
        structural.push(key)
        nextShown[key] = layout
      }
    }
    // A workspace main stopped publishing keeps what the window shows; main has nothing to say.
    shown = nextShown
    if (structural.length > 0) {
      rebuild(state, structural)
    }
    if (titleUpdates.length > 0) {
      store.getState().updateTabTitles(titleUpdates)
    }
  }

  const scheduleFlush = (): void => {
    if (live && !flushQueued) {
      flushQueued = true
      // Coalesces the frames of one task; also lets a write that is about to start report busy.
      queueMicrotask(flush)
    }
  }

  const stream = subscribeRuntimeLayout(
    { kind: 'local' },
    {},
    (frame) => {
      cache = applyLayoutFrame(cache, frame)
      if (frame.type === 'snapshot') {
        snapshotReceived = true
        live = started
      }
      scheduleFlush()
    },
    (status) => {
      if (status.state === 'lost' || status.state === 'refused') {
        console.warn('[layout-owner] layout stream stopped:', status)
      }
    }
  )
  const stopIdleListener = onWindowSessionWriteIdle(scheduleFlush)

  return {
    start: () => {
      started = true
      // Before its snapshot, the snapshot starts it; a stream that ends first leaves restore's.
      live = snapshotReceived
      // A re-run restore rebuilt the slices, so every workspace is shown again.
      shown = {}
      flush()
    },
    close: () => {
      live = false
      stopIdleListener()
      stream.close()
    }
  }
}

let startupFrames: WorkspaceLayoutFrameSync | null = null

/** After restore: the window's one layout stream shows the frames' workspaces from now on. */
export function showStartupLayoutFrames(): void {
  // Kept for the document's life: a local stream ends only with main, and a re-run boot reuses it.
  startupFrames ??= openWorkspaceLayoutFrameSync(useAppStore)
  startupFrames.start()
}
