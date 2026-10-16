import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  electronMocks,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  shouldRunSetupForCreate
} from './orca-runtime-test-mocks.spec'
import { store } from './orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

describe('host worktree creation while its renderer is unavailable', () => {
  it.each([
    ['git', 'reload', 'host'],
    ['git', 'crash', 'host'],
    ['folder', 'reload', 'host'],
    ['folder', 'crash', 'host'],
    ['git', 'reload', 'all'],
    ['git', 'crash', 'all'],
    ['folder', 'reload', 'all'],
    ['folder', 'crash', 'all']
  ] as const)(
    'provisions %s work after a renderer %s for %s navigation with its notifier retained',
    async (kind, loss, navigation) => {
      const repo = { ...store.getRepo('repo-1')!, kind }
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => [repo],
        getRepo: (id) => (id === repo.id ? repo : undefined)
      })
      onTestFinished(() => runtime.markGraphUnavailable(1))
      const notifier = createMobileCreateTestNotifier(vi.fn())
      runtime.setNotifier(notifier)
      runtime.setPtyController({
        spawn: vi.fn(),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
      runtime.markGraphReady(1)
      runtime.markRendererReloading(1)
      if (loss === 'crash') {
        runtime.markGraphReloadFailed(1, 'renderer-process-gone')
      }
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'background-terminal',
        worktreeId: 'created-worktree',
        title: null,
        surface: 'background'
      })
      const worktreePath = '/tmp/workspaces/renderer-unavailable'
      computeWorktreePathMock.mockReturnValue(worktreePath)
      ensurePathWithinWorkspaceMock.mockReturnValue(worktreePath)
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: worktreePath,
          head: 'abc',
          branch: 'renderer-unavailable',
          isBare: false,
          isMainWorktree: false
        }
      ])
      vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'echo setup' } })
      vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
      vi.mocked(createSetupRunnerScript).mockReturnValue({
        runnerScriptPath: '/tmp/setup-runner.sh',
        envVars: {}
      })
      const result = await runtime.createManagedWorktree({
        repoSelector: `id:${repo.id}`,
        name: 'renderer-unavailable',
        activate: true,
        navigation,
        setupDecision: 'run'
      })
      expect(createTerminal).toHaveBeenCalled()
      expect(
        createTerminal.mock.calls.every(([, options]) => options?.surfaceOwner === false)
      ).toBe(true)
      if (kind === 'git') {
        expect(createTerminal.mock.calls.some(([, options]) => options?.title === 'Setup')).toBe(
          true
        )
        expect(result.setup).toBeUndefined()
      }
    }
  )
})

const repo: Repo = {
  id: 'construction-repo',
  path: tmpdir(),
  displayName: 'Construction',
  badgeColor: 'blue',
  addedAt: 1
}
class QueryRuntime extends OrcaRuntimeService {
  checkDraft() {
    return this.buildStartupForDraft(repo, 'startup draft')
  }
  checkAgentGuard() {
    expect(() => this.buildStartupForAgent(repo, 'claude', undefined)).toThrow(
      'runtime_unavailable'
    )
  }
  checkLineage() {
    return this.recordCreatedWorktreeLineage(
      { id: `construction-repo::${tmpdir()}`, instanceId: 'construction-instance' },
      { kind: 'none', warnings: [] }
    )
  }
  checkBackground() {
    return this.shouldProvisionWorktreeInBackground()
  }
  checkProvisioningHost() {
    return Object.keys(this.getWorktreeTerminalProvisioningHost())
  }
  checkReadinessHost() {
    return Object.keys(this.getWorktreeStartupReadinessHost())
  }
}
const cases = [
  {
    name: 'public draft-agent null-store query',
    run: (r: QueryRuntime) => r.resolveStartupDraftAgent(repo),
    check: async (v: unknown) => {
      await expect(v).resolves.toBeNull()
    }
  },
  {
    name: 'protected draft-plan null-store query',
    run: (r: QueryRuntime) => r.checkDraft(),
    check: async (v: unknown) => {
      await expect(v).resolves.toBeNull()
    }
  },
  {
    name: 'protected agent-plan original null-store error',
    run: (r: QueryRuntime) => r.checkAgentGuard(),
    check: async (v: unknown) => {
      expect(v).toBeUndefined()
    }
  },
  {
    name: 'lineage-none projection with valid identities',
    run: (r: QueryRuntime) => r.checkLineage(),
    check: async (v: unknown) => {
      expect(v).toEqual({ lineage: null, workspaceLineage: null, warnings: [] })
    }
  },
  {
    name: 'public base-prefetch original async null-store error',
    run: (r: QueryRuntime) => r.prefetchManagedWorktreeCreateBase({ repoSelector: repo.id }),
    check: async (v: unknown) => {
      await expect(v).rejects.toThrow('runtime_unavailable')
    }
  },
  {
    name: 'background provisioning pure readiness query',
    run: (r: QueryRuntime) => r.checkBackground(),
    check: async (v: unknown) => {
      expect(v).toBe(true)
    }
  },
  {
    name: 'lazy terminal provisioning capability object',
    run: (r: QueryRuntime) => r.checkProvisioningHost(),
    check: async (v: unknown) => {
      expect(v).toEqual([
        'canSpawn',
        'createTerminal',
        'splitTerminal',
        'setTabTitle',
        'setTabColor',
        'getSettings',
        'getPtyId',
        'recordSetupCompletionToken'
      ])
    }
  },
  {
    name: 'lazy startup-readiness capability object',
    run: (r: QueryRuntime) => r.checkReadinessHost(),
    check: async (v: unknown) => {
      expect(v).toEqual([
        'getPtyId',
        'getForegroundProcess',
        'hasChildProcesses',
        'subscribeToData',
        'readRecentOutput',
        'write'
      ])
    }
  },
  {
    name: 'execution-host metadata query permits initial absent record',
    run: (r: QueryRuntime) => r.launchedAgentHostProvesAgent('startup-pty'),
    check: async (v: unknown) => {
      expect(v).toBe(process.platform !== 'win32')
    }
  }
]
for (const test of cases) {
  it(`preserves ${test.name} at existing constructor getter seam`, async () => {
    let result: unknown
    class ConstructionRuntime extends QueryRuntime {
      protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        result = test.run(this)
        return new Map()
      }
    }
    expect(() => new ConstructionRuntime(null)).not.toThrow()
    await test.check(result)
  })
}

describe('startup hosts retain current runtime capabilities', () => {
  it('reads current create and split overrides with the captured worktree and three arguments', async () => {
    const runtime = new OrcaRuntimeService(store)
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const created: Worktree = {
      id: 'created-worktree',
      repoId: 'repo-1',
      displayName: 'Created',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      path: tmpdir(),
      head: 'abc',
      branch: 'created',
      isBare: false,
      isMainWorktree: false
    }
    const host = runtime['getWorktreeTerminalProvisioningHost'](created)
    const options = { command: 'echo startup' }
    const create = vi.spyOn(runtime, 'createTerminal').mockImplementation(async function (
      this: OrcaRuntimeService,
      selector,
      input,
      evidence
    ) {
      expect(this).toBe(runtime)
      expect(arguments.length).toBe(3)
      expect([selector, input, evidence]).toEqual(['id:created-worktree', options, created])
      expect(evidence).toBe(created)
      return { handle: 'created-handle', worktreeId: created.id, title: null }
    })
    const split = vi.spyOn(runtime, 'splitTerminal').mockImplementation(async function (
      this: OrcaRuntimeService,
      handle,
      input,
      evidence
    ) {
      expect(this).toBe(runtime)
      expect(arguments.length).toBe(3)
      expect([handle, input, evidence]).toEqual(['created-handle', options, created])
      expect(evidence).toBe(created)
      return { handle: 'split-handle', tabId: 'tab', paneRuntimeId: 1 }
    })
    await host.createTerminal('id:created-worktree', options)
    await host.splitTerminal('created-handle', options)
    expect(create).toHaveBeenCalledOnce()
    expect(split).toHaveBeenCalledOnce()
  })

  it('reads replacement providers and preserves readiness failures after removal', async () => {
    const runtime = new OrcaRuntimeService(store)
    const host = runtime['getWorktreeStartupReadinessHost']()
    const hasChildProcesses = host.hasChildProcesses
    if (!hasChildProcesses) {
      throw new Error('missing readiness child-process callback')
    }
    const provisioning = runtime['getWorktreeTerminalProvisioningHost']()
    expect(provisioning.canSpawn()).toBe(false)
    const controller: RuntimePtyController = {
      write: () => true,
      kill: () => true,
      getForegroundProcess: vi.fn(async function (this: RuntimePtyController, ptyId: string) {
        expect(this).toBe(controller)
        expect(arguments.length).toBe(1)
        expect(ptyId).toBe('startup-pty')
        return 'late provider'
      })
    }
    runtime.setPtyController(controller)
    await expect(host.getForegroundProcess('startup-pty')).resolves.toBe('late provider')
    await expect(hasChildProcesses('startup-pty')).resolves.toBe(false)
    const replacement: RuntimePtyController = {
      write: () => true,
      kill: () => true,
      spawn: async () => ({ id: 'spawned' }),
      getForegroundProcess: async () => 'replacement provider',
      hasChildProcesses: async () => true
    }
    runtime.setPtyController(replacement)
    expect(provisioning.canSpawn()).toBe(true)
    await expect(host.getForegroundProcess('startup-pty')).resolves.toBe('replacement provider')
    await expect(hasChildProcesses('startup-pty')).resolves.toBe(true)
    runtime.setPtyController(null)
    expect(provisioning.canSpawn()).toBe(false)
    expect(() => host.getForegroundProcess('startup-pty')).toThrow(TypeError)
    expect(() => hasChildProcesses('startup-pty')).toThrow(TypeError)
  })

  it('reads the current store and canonical setup-token map when invoked', () => {
    const runtime = new OrcaRuntimeService(store)
    const host = runtime['getWorktreeTerminalProvisioningHost']()
    const original = runtime['setupCompletionTokenByPtyId']
    const replacement = new Map<string, string>()
    const settings = { ...store.getSettings(), workspaceDir: tmpdir() }
    Object.defineProperty(runtime, 'setupCompletionTokenByPtyId', { value: replacement })
    Object.defineProperty(runtime, 'store', { value: { ...store, getSettings: () => settings } })
    host.recordSetupCompletionToken?.('startup-pty', 'late-token')
    expect(replacement.get('startup-pty')).toBe('late-token')
    expect(original.has('startup-pty')).toBe(false)
    expect(host.getSettings()).toBe(settings)
  })
})
