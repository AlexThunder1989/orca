import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'

const WORKTREE = 'repo-1::/work/one'
const SPLIT = {
  type: 'splitPane',
  workspace: WORKTREE,
  tabId: 'tab-1',
  leafId: 'leaf-1',
  direction: 'vertical'
} as const

async function registeredMethods(layoutOwnerIsMain: boolean) {
  vi.resetModules()
  vi.doMock('../../../../shared/layout-owner-switch', () => ({
    ORCA_LAYOUT_OWNER_IS_MAIN: layoutOwnerIsMain
  }))
  const { ALL_RPC_METHODS } = await import('./index')
  return eraseRpcMethods(ALL_RPC_METHODS)
}

function sessionListing(tabId: string): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: WORKTREE,
    activeTabId: tabId,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: tabId,
          ptyId: null,
          worktreeId: WORKTREE,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {}
  }
}

function runtimeHolding(hostId: string) {
  const applyLayoutCommand = vi.fn(async () => ({ ok: true, result: { leafId: 'minted' } }))
  const empty: WorkspaceSessionState = { ...sessionListing('other'), tabsByWorktree: {} }
  const store = {
    getRepo: () => undefined,
    getWorkspaceSessionHostIds: () => ['local', hostId],
    getWorkspaceSession: (host: string) => (host === hostId ? sessionListing('tab-1') : empty),
    applyLayoutCommand
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply path reads only these store methods.
  return { runtime: new OrcaRuntimeService(store as never), applyLayoutCommand }
}

afterEach(() => {
  vi.doUnmock('../../../../shared/layout-owner-switch')
  vi.resetModules()
})

describe('layout.apply', () => {
  it('is not registered in a window-owned build, and never advertised or open to phones', async () => {
    const methods = await registeredMethods(false)

    expect(methods.some((method) => method.name === 'layout.apply')).toBe(false)
    expect(RUNTIME_CAPABILITIES.some((capability) => capability.startsWith('layout'))).toBe(false)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('layout.apply')).toBe(false)
  })

  it('is registered in a layout-owner build and accepts no id main should mint', async () => {
    const apply = (await registeredMethods(true)).find((method) => method.name === 'layout.apply')
    if (!apply || isStreamingMethod(apply)) {
      throw new Error('layout.apply is not a request method')
    }
    const applyLayoutCommand = vi.fn(async () => ({ ok: true, result: {} }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only applyLayoutCommand.
    const runtime = { applyLayoutCommand } as unknown as OrcaRuntimeService

    const params = apply.params?.parse({ command: { ...SPLIT, newLeafId: 'window-minted' } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime from its context.
    await apply.handler(params, { runtime } as RpcContext)

    expect(applyLayoutCommand).toHaveBeenCalledWith(SPLIT)
  })

  it('takes no close semantics or blank title from the window', async () => {
    const apply = (await registeredMethods(true)).find((method) => method.name === 'layout.apply')
    const pane = { workspace: WORKTREE, tabId: 'tab-1', leafId: 'leaf-1' }

    expect(
      apply?.params?.parse({
        command: { type: 'closePane', ...pane, userPaneClose: true }
      })
    ).toEqual({ command: { type: 'closePane', ...pane } })
    expect(
      apply?.params?.safeParse({ command: { type: 'renamePane', ...pane, title: '  ' } }).success
    ).toBe(false)
    expect(
      apply?.params?.parse({ command: { type: 'renamePane', ...pane, title: ' Build ' } })
    ).toEqual({ command: { type: 'renamePane', ...pane, title: 'Build' } })
  })

  it('accepts only a drop side and a valid pane tree for gestures', async () => {
    const apply = (await registeredMethods(true)).find((method) => method.name === 'layout.apply')
    const pane = { workspace: WORKTREE, tabId: 'tab-1', leafId: 'leaf-1' }
    const move = { type: 'movePane', ...pane, targetLeafId: 'leaf-2' }
    const ratios = { type: 'setPaneRatios', workspace: WORKTREE, tabId: 'tab-1' }

    expect(apply?.params?.safeParse({ command: { ...move, side: 'left' } }).success).toBe(true)
    expect(apply?.params?.safeParse({ command: { ...move, side: 'center' } }).success).toBe(false)
    expect(
      apply?.params?.safeParse({
        command: { ...ratios, root: { type: 'split', direction: 'vertical', ratio: 2 } }
      }).success
    ).toBe(false)
  })

  it('applies to the partition that holds the tab, such as an SSH host’s', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('ssh:target-1')

    await expect(runtime.applyLayoutCommand(SPLIT)).resolves.toEqual({
      ok: true,
      result: { leafId: 'minted' }
    })
    expect(applyLayoutCommand).toHaveBeenCalledWith(SPLIT, ['ssh:target-1'])
  })

  it('refuses a paired server’s workspace, which keeps its mirrored layout', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('runtime:env-1')

    await expect(runtime.applyLayoutCommand(SPLIT)).resolves.toEqual({
      ok: false,
      code: 'host_not_owned'
    })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })
})
