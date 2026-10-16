import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  equalizeTerminalPanes,
  sendPaneCommandToLayoutOwner
} from './terminal-pane-layout-owner-commands'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    ownerEnvironmentId: string | null
    layoutOwnerIsMain: boolean
  } => ({
    callRuntimeRpc: vi.fn(),
    ownerEnvironmentId: null,
    layoutOwnerIsMain: false
  })
)

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExplicitRuntimeEnvironmentIdForWorktree: () => mocks.ownerEnvironmentId
}))

const SPLIT = {
  type: 'splitPane',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  direction: 'vertical'
} as const

function handlers() {
  return { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }
}

describe('sendPaneCommandToLayoutOwner', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('asks local main first, then applies main’s result', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: { leafId: 'leaf-minted' } })
    const on = handlers()

    expect(sendPaneCommandToLayoutOwner('worktree-1', SPLIT, on)).toBe(true)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'layout.apply', {
      command: { ...SPLIT, workspace: 'worktree-1' }
    })
    expect(on.apply).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(on.apply).toHaveBeenCalledWith({ leafId: 'leaf-minted' }))
    expect(on.asToday).not.toHaveBeenCalled()
  })

  it.each([
    ['a refusal', () => mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'last_pane' })],
    ['a failed call', () => mocks.callRuntimeRpc.mockRejectedValue(new Error('rpc_failed'))]
  ])('changes nothing after %s', async (_case, arrange) => {
    arrange()
    const on = handlers()

    expect(sendPaneCommandToLayoutOwner('worktree-1', SPLIT, on)).toBe(true)

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(on.apply).not.toHaveBeenCalled()
    expect(on.asToday).not.toHaveBeenCalled()
  })

  it('hands any other refusal to the caller', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'last_pane' })
    const on = handlers()

    sendPaneCommandToLayoutOwner('worktree-1', SPLIT, on)

    await vi.waitFor(() => expect(on.refused).toHaveBeenCalledWith('last_pane'))
  })

  it('acts as today when main says a paired server holds the tab', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'host_not_owned' })
    const on = handlers()

    expect(sendPaneCommandToLayoutOwner('worktree-1', SPLIT, on)).toBe(true)

    await vi.waitFor(() => expect(on.asToday).toHaveBeenCalled())
    expect(on.apply).not.toHaveBeenCalled()
  })

  it('leaves a paired server’s workspace to today’s path', () => {
    mocks.ownerEnvironmentId = 'env-1'

    expect(sendPaneCommandToLayoutOwner('worktree-1', SPLIT, handlers())).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('equalizeTerminalPanes', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    mocks.layoutOwnerIsMain = false
  })

  function manager() {
    const equalizePaneSizes = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: equalize calls only equalizePaneSizes.
    return { equalizePaneSizes } as unknown as PaneManager & {
      equalizePaneSizes: typeof equalizePaneSizes
    }
  }

  it('a window-owned build equalizes at once, without asking main', () => {
    const current = manager()
    const then = vi.fn()

    equalizeTerminalPanes(
      { worktreeId: 'worktree-1', tabId: 'tab-1', getManager: () => current },
      then
    )

    expect(current.equalizePaneSizes).toHaveBeenCalledOnce()
    expect(then).toHaveBeenCalledWith(current)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('a layout-owner build equalizes once main has', async () => {
    mocks.layoutOwnerIsMain = true
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
    const current = manager()

    equalizeTerminalPanes(
      { worktreeId: 'worktree-1', tabId: 'tab-1', getManager: () => current },
      vi.fn()
    )

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'layout.apply', {
      command: { type: 'equalizePanes', tabId: 'tab-1', workspace: 'worktree-1' }
    })
    expect(current.equalizePaneSizes).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(current.equalizePaneSizes).toHaveBeenCalledOnce())
  })
})
