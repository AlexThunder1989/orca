import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWindowLayoutCommand } from './runtime-layout-apply'
import type { RuntimeStore } from './runtime-store-contract'

const mocks = vi.hoisted(() => ({ markAgentLaunchesClosedByUser: vi.fn() }))
vi.mock('../agent-launch/agent-launch-pane-attachment', () => ({
  markAgentLaunchesClosedByUser: mocks.markAgentLaunchesClosedByUser
}))

const CLOSE = { type: 'closePane', workspace: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' } as const

function storeWith() {
  const applyLayoutCommand = vi.fn(async () => ({ ok: true as const, result: {} }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply path reads only applyLayoutCommand.
  const store = { applyLayoutCommand } as unknown as RuntimeStore
  return { store, applyLayoutCommand }
}

describe('applyWindowLayoutCommand', () => {
  beforeEach(() => mocks.markAgentLaunchesClosedByUser.mockReset())

  it('closes a pane as the user’s close, in every local or SSH holder', async () => {
    const { store, applyLayoutCommand } = storeWith()

    await applyWindowLayoutCommand(store, () => ['local', 'runtime:env-1', 'ssh:target-1'], CLOSE)

    expect(applyLayoutCommand).toHaveBeenCalledWith({ ...CLOSE, userPaneClose: true }, [
      'local',
      'ssh:target-1'
    ])
    expect(mocks.markAgentLaunchesClosedByUser).toHaveBeenCalledWith('wt-1', {
      kind: 'pane',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
  })

  it('applies other commands to the routed partition only', async () => {
    const { store, applyLayoutCommand } = storeWith()
    const rename = { ...CLOSE, type: 'renamePane', title: 'Pane' } as const

    await applyWindowLayoutCommand(store, () => ['local', 'ssh:target-1'], rename)

    expect(applyLayoutCommand).toHaveBeenCalledWith(rename, ['local'])
    expect(mocks.markAgentLaunchesClosedByUser).not.toHaveBeenCalled()
  })

  it('refuses a tab a paired server routes, touching nothing', async () => {
    const { store, applyLayoutCommand } = storeWith()

    await expect(
      applyWindowLayoutCommand(store, () => ['runtime:env-1', 'local'], CLOSE)
    ).resolves.toEqual({ ok: false, code: 'host_not_owned' })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
    expect(mocks.markAgentLaunchesClosedByUser).not.toHaveBeenCalled()
  })
})
