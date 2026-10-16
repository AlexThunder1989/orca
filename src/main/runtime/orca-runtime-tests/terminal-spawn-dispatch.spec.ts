import { describe, expect, it, vi, afterEach } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'
import { OrcaRuntimeWithRuntimeId } from '../construction/runtime-identity-state'
import { OrcaRuntimeWithStateFields } from '../construction/runtime-construction'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'

// `agent.launch` settles a launch as failed only when its create threw before this hook ran.
describe('OrcaRuntimeService createTerminal spawn dispatch', () => {
  it('reports the spawn request before it leaves for the pty controller', async () => {
    const dispatched = vi.fn()
    const spawn = vi.fn(async () => {
      expect(dispatched).toHaveBeenCalledOnce()
      return { id: 'pty-dispatch' }
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      onPtySpawnDispatched: dispatched
    })

    expect(spawn).toHaveBeenCalledOnce()
  })

  it('reports it even when the spawn itself then fails', async () => {
    const dispatched = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        throw new Error('ssh_channel_closed')
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        onPtySpawnDispatched: dispatched
      })
    ).rejects.toThrow('ssh_channel_closed')
    expect(dispatched).toHaveBeenCalledOnce()
  })

  it('does not report it when the create fails before any spawn request', async () => {
    const dispatched = vi.fn()
    const spawn = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal('path:/no/such/workspace', {
        command: 'codex',
        onPtySpawnDispatched: dispatched
      })
    ).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
    expect(dispatched).not.toHaveBeenCalled()
  })
})

describe('PTY registration dispatch characterization', () => {
  type PtyRegistrationBinding = NonNullable<Parameters<OrcaRuntimeService['registerPty']>[3]>
  const TAB_ID = '11111111-1111-4111-8111-111111111111'
  const LEAF_ID = '22222222-2222-4222-8222-222222222222'
  const PTY_ID = 'pty-dispatch'
  const WORKTREE_ID = 'repo::/tmp/dispatch'
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  class DispatchRuntime extends OrcaRuntimeService {
    constructor() {
      super(null)
      this.ensurePtyBackedMobileSurfaceForRendererTab = () => null
      this.touchMobileSessionSnapshotsForPty = () => {}
    }

    replaceAdmission(assertion: (ptyId: string, incarnationId?: string) => void): void {
      this.assertPtyDidNotExitBeforeRegistration = assertion
    }

    replaceHostScope(
      resolve: () => { kind: 'local'; hostId: 'local'; toJSON(): { kind: 'local' } } | null
    ): void {
      this.getOrchestrationCompatibilityHostScope = resolve
    }

    setDatabase(db: OrchestrationDb | null): void {
      this._orchestrationDb = db
    }

    get record() {
      return this.recordPtyWorktree
    }

    set record(value: typeof this.recordPtyWorktree) {
      this.recordPtyWorktree = value
    }

    get pendingCreates() {
      return this.pendingMobileTerminalCreatesByKey
    }

    get replacementFences() {
      return this.pendingPtyHandleReplacementFences
    }
  }

  function binding(): PtyRegistrationBinding {
    return { tabId: TAB_ID, leafId: LEAF_ID, incarnationId: 'dispatch-incarnation' }
  }

  function register(runtime: DispatchRuntime, tab: PtyRegistrationBinding): void {
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, tab)
  }

  describe('PTY runtime dispatch', () => {
    it('constructs supported early layers and keeps lifecycle cells available to the full runtime', () => {
      // Earlier constructors already require this browser callback.
      abstract class EarlyStateRuntime extends OrcaRuntimeWithStateFields {
        protected markHeadlessBrowserSessionTabActive(): void {}
      }
      const cells: boolean[] = []
      class ConstructorRuntime extends OrcaRuntimeService {
        protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
          cells.push(
            this.stopRequestedPtyIds instanceof Set,
            this.ptyExitListenersByPtyId instanceof Map
          )
          return super.canonicalFetchKeyCache
        }
      }
      const runtimes: unknown[] = [
        Reflect.construct(OrcaRuntimeWithRuntimeId, []),
        new ConstructorRuntime(),
        new ConstructorRuntime(null),
        Reflect.construct(EarlyStateRuntime, [null])
      ]
      expect(runtimes).toHaveLength(4)
      expect(cells).toEqual([true, true, true, true])
    })

    it('captures the admission method before reading the incarnation', () => {
      const runtime = new DispatchRuntime()
      runtime.replaceAdmission(function (this: DispatchRuntime) {
        expect(this).toBe(runtime)
        throw new Error('captured admission')
      })
      const tab = binding()
      Object.defineProperty(tab, 'incarnationId', {
        get() {
          runtime.replaceAdmission(() => {
            throw new Error('late admission')
          })
          return 'dispatch-incarnation'
        }
      })
      expect(() => register(runtime, tab)).toThrow('captured admission')
    })

    it('captures the record method before evaluating its state object', () => {
      const runtime = new DispatchRuntime()
      let reads = 0
      runtime.record = function (this: DispatchRuntime) {
        expect(this).toBe(runtime)
        throw new Error('captured record')
      }
      const tab = binding()
      Object.defineProperty(tab, 'tabId', {
        get() {
          if (++reads === 3) {
            runtime.record = () => {
              throw new Error('late record')
            }
          }
          return TAB_ID
        }
      })
      expect(() => register(runtime, tab)).toThrow('captured record')
    })

    it('skips database payload serialization when no database exists', () => {
      const runtime = new DispatchRuntime()
      let serializations = 0
      runtime.replaceHostScope(() => ({
        kind: 'local',
        hostId: 'local',
        toJSON() {
          serializations++
          return { kind: 'local' }
        }
      }))
      register(runtime, binding())
      expect(serializations).toBe(0)
    })

    it('skips a throwing database payload when no database exists', () => {
      const runtime = new DispatchRuntime()
      runtime.replaceHostScope(() => ({
        kind: 'local',
        hostId: 'local',
        toJSON() {
          throw new Error('absent database payload')
        }
      }))
      expect(() => register(runtime, binding())).not.toThrow()
    })

    it('keeps the database method and receiver captured before its payload', () => {
      const runtime = new DispatchRuntime()
      const captured = new OrchestrationDb(':memory:')
      const replacement = new OrchestrationDb(':memory:')
      databases.push(captured, replacement)
      const calls: string[] = []
      captured.retainReplacedWorkerTerminalResources = function () {
        expect(this).toBe(captured)
        calls.push('captured database')
        return 0
      }
      replacement.retainReplacedWorkerTerminalResources = () => calls.push('late database')
      runtime.setDatabase(captured)
      runtime.replaceHostScope(() => ({
        kind: 'local',
        hostId: 'local',
        toJSON() {
          runtime.setDatabase(replacement)
          return { kind: 'local' }
        }
      }))
      register(runtime, binding())
      expect(calls).toEqual(['captured database'])
    })

    it('captures the canonical map method before a binding getter changes it', () => {
      const runtime = new DispatchRuntime()
      let reads = 0
      const calls: string[] = []
      const map = runtime.pendingCreates
      map.has = () => {
        calls.push('captured map')
        return true
      }
      const tab = binding()
      Object.defineProperty(tab, 'tabId', {
        get() {
          if (++reads === 3) {
            map.has = () => {
              calls.push('late map')
              return false
            }
          }
          return TAB_ID
        }
      })
      runtime.replaceHostScope(() => null)
      register(runtime, tab)
      expect(calls).toEqual(['captured map'])
    })

    it('completes the captured replacement fence without another map lookup', () => {
      const runtime = new DispatchRuntime()
      let recorded = false
      let captured = false
      let reads = 0
      const map = runtime.replacementFences
      const originalGet = map.get.bind(map)
      const first = {
        incarnationId: 'first',
        staleHandles: new Set<string>(),
        pendingRegistration: false
      }
      const replacement = {
        incarnationId: 'second',
        staleHandles: new Set<string>(),
        pendingRegistration: true
      }
      map.set(PTY_ID, first)
      map.get = function (id) {
        reads++
        const value = originalGet(id)
        if (recorded) {
          captured = true
        }
        return value
      }
      const record = runtime.record
      runtime.record = function (...args) {
        const value = record.apply(runtime, args)
        recorded = true
        return value
      }
      runtime.replaceHostScope(() => null)
      const tab = binding()
      Object.defineProperty(tab, 'incarnationId', {
        get() {
          if (captured) {
            map.set(PTY_ID, replacement)
          }
          return undefined
        }
      })
      register(runtime, tab)
      expect(reads).toBe(2)
      expect(replacement.pendingRegistration).toBe(true)
    })

    it('initializes original lifecycle state before the base constructor getter', () => {
      const observations: boolean[] = []
      class ConstructorRuntime extends OrcaRuntimeService {
        protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
          observations.push(
            this.earlyExitedPtyIncarnations instanceof Map,
            this.pendingPtyRegistrationIncarnations instanceof Map,
            this.ptyLivenessVerdictByPtyId instanceof Map,
            this.ptyExitListenersByPtyId instanceof Map,
            this.stopRequestedPtyIds instanceof Set,
            this.ptyControllerInventoryGenerationByProvider instanceof Map,
            this.ptyLivenessObservationSequence === 0,
            this.ptyControllerInventorySequence === 0,
            this.ptyControllerAggregateInventoryGeneration === 0
          )
          this.markPtyStopRequested(PTY_ID)
          expect(this.isPtyStopRequested(PTY_ID)).toBe(true)
          return new Map()
        }
      }
      expect(() => new ConstructorRuntime(null)).not.toThrow()
      expect(observations).toEqual(Array<boolean>(9).fill(true))
    })
  })
})

describe('PTY inventory construction characterization', () => {
  const PTY_ID = 'pty-constructor-probe'

  describe('PTY methods during runtime construction', () => {
    it('keeps registration fences and liveness on the original canonical state', async () => {
      const pending: Promise<unknown>[] = []
      let seamCalls = 0
      class ConstructorRuntime extends OrcaRuntimeService {
        protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
          seamCalls++
          this.beginPtyRegistration(PTY_ID, 'incarnation')
          expect(this.pendingPtyRegistrationIncarnations.get(PTY_ID)).toBe('incarnation')
          this.cancelPendingPtyRegistration(PTY_ID, 'incarnation')
          expect(this.pendingPtyRegistrationIncarnations.has(PTY_ID)).toBe(false)
          this.assertPtyRegistrationAllowed(PTY_ID, 'incarnation')
          this.releaseRejectedPtyRegistrationFence(PTY_ID, 'incarnation')
          this.acceptPtyIncarnationForExit(PTY_ID, 'incarnation')
          this.markPtyStopRequested(PTY_ID)
          expect(this.isPtyStopRequested(PTY_ID)).toBe(true)
          this.markPtyLivenessLive(PTY_ID)
          expect(this.getPtyLivenessVerdict(PTY_ID)).toEqual({ status: 'live', ptyIds: [PTY_ID] })
          this.markPtyLivenessUnverifiable(PTY_ID, 'host unavailable')
          expect(this.getPtyLivenessVerdict(PTY_ID)).toEqual({
            status: 'unverifiable',
            reason: 'host unavailable'
          })
          this.forgetPtyLivenessVerdict(PTY_ID)
          expect(this.getPtyLivenessVerdict(PTY_ID)).toBeNull()
          expect(this.getTerminalPtyIdForHandle('missing')).toBeNull()
          expect(this.getAgentProviderSessionRows()).toEqual([])
          expect(this.getAgentStatusRowsForPane('missing')).toEqual([])
          pending.push(
            this.confirmTerminalShellAlone(PTY_ID).then((value) => expect(value).toBe(false))
          )
          pending.push(
            this.refreshPtyWorktreeRecordsFromController([]).then((value) =>
              expect(value).toBeNull()
            )
          )
          pending.push(
            this.refreshPtyWorktreeRecordsWithControllerInventory([]).then((value) =>
              expect(value).toBeNull()
            )
          )
          this.invalidatePtyControllerInventoryForLifecycle(PTY_ID)
          expect(this.ptyControllerInventorySequence).toBe(1)
          return super.canonicalFetchKeyCache
        }
      }
      expect(() => new ConstructorRuntime(null)).not.toThrow()
      expect(seamCalls).toBe(1)
      await Promise.all(pending)
    })
  })
})
