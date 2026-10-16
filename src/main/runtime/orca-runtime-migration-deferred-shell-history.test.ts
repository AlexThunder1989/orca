import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { store } from './orca-runtime-test-fixtures.spec'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
}

describe('a moved shell history that waited on live shells', () => {
  it('is retried when the last shell of its worktree exits, with the live-shell check', () => {
    const installDeferred = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      installDeferredOrcadMigrationShellHistory: installDeferred
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is declared on OrcaRuntimeService's inheritance chain.
    const internals = runtime as unknown as RuntimeInternals
    internals.recordPtyWorktree('pty-1', 'repo-1::/srv/app', { connected: true })
    internals.recordPtyWorktree('pty-2', 'repo-1::/srv/app', { connected: true })

    runtime.onPtyExit('pty-1', 0)
    const [worktreeId, options] = installDeferred.mock.calls[0]
    expect(worktreeId).toBe('repo-1::/srv/app')
    // pty-2 still runs there, so the store keeps waiting.
    expect(options.worktreeHasLiveShells('repo-1::/srv/app')).toBe(true)

    runtime.onPtyExit('pty-2', 0)
    expect(installDeferred.mock.calls[1][1].worktreeHasLiveShells('repo-1::/srv/app')).toBe(false)
  })

  it('is installed once the runtime attached, counting daemon shells that outlived a restart', async () => {
    const installPending = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      installPendingOrcadMigrationReceivedBlobs: installPending
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: vi.fn(async () => [
        { id: 'daemon-pty', cwd: '/srv/app', title: 'zsh', worktreeId: 'repo-1::/srv/app' }
      ])
    })

    await runtime.installPendingOrcadMigrationShellHistory()

    const [options] = installPending.mock.calls[0]
    expect(options.worktreeHasLiveShells('repo-1::/srv/app')).toBe(true)
    expect(options.worktreeHasLiveShells('repo-1::/srv/other')).toBe(false)
  })

  it('waits when the terminal inventory does not answer', async () => {
    const installPending = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      installPendingOrcadMigrationReceivedBlobs: installPending
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: vi.fn(async () => {
        throw new Error('daemon unreachable')
      })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runtime.installPendingOrcadMigrationShellHistory()

    expect(installPending).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
