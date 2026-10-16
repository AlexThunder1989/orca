import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  localDesktopSession,
  WORKSPACE_LAYOUT_PROFILES
} from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { reportWindowSessionWriteActivity } from '../lib/window-session-write-activity'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import type { LayoutFrameSlices } from '../store/workspace-layout-frame-slices'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type StreamDouble = {
  onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null
  onStatus: ((status: { state: string }) => void) | null
  close: () => void
}
const stream = vi.hoisted((): StreamDouble => ({ onFrame: null, onStatus: null, close: () => {} }))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
    onStatus: (status: { state: string }) => void
  ) => {
    stream.onFrame = onFrame
    stream.onStatus = onStatus
    return { close: stream.close }
  }
}))

createStoreSessionMockApi()

const SLICES: (keyof LayoutFrameSlices)[] = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'layoutByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'remoteBrowserPageHandlesByPageId',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree'
]

/** What main publishes for one stored partition. */
function published(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): Record<string, PublishedWorkspaceLayout> {
  const { layout } = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
  return Object.fromEntries(
    Object.entries(layout.workspaces).map(([key, workspace]) => [
      key,
      publishWorkspaceLayout(workspace, hostId)
    ])
  )
}

function snapshot(layouts: Record<string, PublishedWorkspaceLayout>): WorkspaceLayoutChangeFrame {
  return {
    type: 'snapshot',
    workspaces: Object.entries(layouts).map(([key, layout]) => ({ key, layout }))
  }
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function bootWithFrames(hostId: ExecutionHostId, session: WorkspaceSessionState) {
  const store = createTestStore()
  await bootWindowFromPartitions(store, [{ hostId, session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const layouts = published(hostId, session)
  stream.onFrame!(snapshot(layouts))
  return { store, sync, layouts }
}

/** Fixtures whose frames differ from the restore, as the frame parity test lists. */
const FRAME_DIFFERENCE_FIXTURES = new Set([
  'row without a tab-bar entry or a terminal',
  'legacy surface tombstone on a pane still showing its terminal',
  'tab-bar label differing from the row title',
  'row without a tab-bar entry, still bound to a terminal',
  'legacy split row sharing one pane’s terminal with a tab-bar tab',
  'session from before the tab bar, with an open file'
])

beforeEach(() => {
  reportWindowSessionWriteActivity(false)
})

describe('the window drawn from layout frames', () => {
  it.each(
    [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]
      .filter((profile) => !FRAME_DIFFERENCE_FIXTURES.has(profile.name))
      .map((profile) => [profile.name, profile] as const)
  )('startup from the first snapshot changes nothing restore showed: %s', async (_, profile) => {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: profile.hostId, session: profile.build() }])
    const before = store.getState()
    const sync = openWorkspaceLayoutFrameSync(store)
    stream.onFrame!(snapshot(published(profile.hostId, profile.build())))
    sync.start()
    const after = store.getState()
    expect(SLICES.filter((slice) => after[slice] !== before[slice])).toEqual([])
    sync.close()
  })

  it('shows a structure change main publishes, keeping what only the window knows', async () => {
    const session = localDesktopSession()
    const { store, sync, layouts } = await bootWithFrames('local', session)
    sync.start()
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [GIT_KEY]: store.getState().tabsByWorktree[GIT_KEY]!.map((tab) =>
          tab.id === 'tab-shell'
            ? {
                ...tab,
                ptyId: 'live-pty',
                pendingActivationSpawn: true,
                restoredFromSession: undefined
              }
            : tab
        )
      }
    })
    const renamed = structuredClone(layouts[GIT_KEY]!)
    renamed.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'renamed'
    stream.onFrame!({ type: 'workspace', key: GIT_KEY, layout: renamed })
    await flushMicrotasks()
    const shell = store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!
    expect(shell).toMatchObject({
      customTitle: 'renamed',
      ptyId: 'live-pty',
      pendingActivationSpawn: true
    })
    // Restore marks every row it builds; a row whose terminal bound since must not get it back.
    expect(shell).not.toHaveProperty('restoredFromSession')
    sync.close()
  })

  it('holds a structure frame while the window owes main a write, then shows it', async () => {
    const { store, sync, layouts } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    reportWindowSessionWriteActivity(true)
    const renamed = structuredClone(layouts[GIT_KEY]!)
    renamed.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'renamed'
    stream.onFrame!({ type: 'workspace', key: GIT_KEY, layout: renamed })
    await flushMicrotasks()
    const shellTitle = () =>
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!.customTitle
    expect(shellTitle()).not.toBe('renamed')
    reportWindowSessionWriteActivity(false)
    await flushMicrotasks()
    expect(shellTitle()).toBe('renamed')
    sync.close()
  })

  it('shows a live title change of the focused pane at once, even while a write is owed', async () => {
    const { store, sync, layouts } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    reportWindowSessionWriteActivity(true)
    const titled = structuredClone(layouts[GIT_KEY]!)
    const shell = titled.tabs.find((tab) => tab.id === 'tab-shell')!
    const focused = store.getState().terminalLayoutsByTabId['tab-shell']!.activeLeafId
    shell.terminal!.panes = shell.terminal!.panes.map((pane) => ({
      ...pane,
      liveTitle: pane.leafId === focused ? 'vim notes.md' : 'other pane'
    }))
    const before = store.getState()
    stream.onFrame!({ type: 'workspace', key: GIT_KEY, layout: titled })
    await flushMicrotasks()
    const after = store.getState()
    expect(after.tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!.title).toBe(
      'vim notes.md'
    )
    expect(after.groupsByWorktree).toBe(before.groupsByWorktree)
    expect(after.terminalLayoutsByTabId).toBe(before.terminalLayoutsByTabId)
    sync.close()
  })

  it('leaves a paired server’s workspaces to the mirror', async () => {
    const profile = WORKSPACE_LAYOUT_PROFILES.find(
      (entry) => entry.name === 'remote server partition'
    )!
    const { store, sync, layouts } = await bootWithFrames(profile.hostId, profile.build())
    sync.start()
    const before = store.getState()
    const [key, layout] = Object.entries(layouts)[0]!
    stream.onFrame!({ type: 'workspace', key, layout: { ...layout, tabs: [], groups: [] } })
    await flushMicrotasks()
    expect(SLICES.filter((slice) => store.getState()[slice] !== before[slice])).toEqual([])
    sync.close()
  })

  it('leaves restore in place when the stream ends before its snapshot', async () => {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: localDesktopSession() }])
    const before = store.getState()
    const sync = openWorkspaceLayoutFrameSync(store)
    sync.start()
    stream.onStatus!({ state: 'refused' })
    await flushMicrotasks()
    expect(SLICES.filter((slice) => store.getState()[slice] !== before[slice])).toEqual([])
    sync.close()
  })

  it('started before its snapshot, shows the snapshot when it arrives', async () => {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: localDesktopSession() }])
    const sync = openWorkspaceLayoutFrameSync(store)
    sync.start()
    const layouts = published('local', localDesktopSession())
    layouts[GIT_KEY]!.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'from main'
    stream.onFrame!(snapshot(layouts))
    await flushMicrotasks()
    expect(
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!.customTitle
    ).toBe('from main')
    sync.close()
  })
})
