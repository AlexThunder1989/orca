import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const installed = vi.hoisted(() => {
  const state: {
    deps: Record<string, unknown> | null
    logger: StructuredAgentSessionLogger | null
  } = { deps: null, logger: null }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(
    async (deps: Record<string, unknown> & { logger: StructuredAgentSessionLogger }) => {
      installed.deps = deps
      installed.logger = deps.logger
    }
  )
}))

import { OrcaRuntimeService } from './orca-runtime'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import * as structuredMailTarget from './orchestration/structured-session-mail-target'
import { OrcaRuntimeWithRuntimeId } from './construction/runtime-identity-state'

describe('structured status sink wiring', () => {
  afterEach(() => {
    _resetTracerForTests()
    vi.restoreAllMocks()
  })

  it('hands the host the sink the runtime was constructed with', async () => {
    installed.deps = null
    const sink: StructuredAgentSessionStatusSink = { publish: vi.fn(), forget: vi.fn() }
    const runtime = new OrcaRuntimeService(null, undefined, { structuredAgentStatusSink: sink })

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps?.['statusSink']).toBe(sink)
  })

  it('hands the host the trace-file logger', async () => {
    installed.logger = null
    const push = vi.fn()
    setActiveSink({ push, flush: () => {}, close: () => {} })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()
    const installedLogger = (): StructuredAgentSessionLogger | null => installed.logger
    installedLogger()?.warn('renewing a chat lease failed', {
      scope: 'lease-renewal',
      sessionId: 'session-1',
      error: new Error('database is locked')
    })

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agentSession.lease-renewal',
        attributes: expect.objectContaining({ sessionId: 'session-1' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
  })

  it('installs without a sink when none was provided', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps).not.toBeNull()
    expect('statusSink' in (installed.deps ?? {})).toBe(false)
  })
})

describe('mail dispatch through the current runtime', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses runtime journal and delivery overrides on the idle edge', () => {
    const target = new OrcaRuntimeService()
    vi.spyOn(structuredMailTarget, 'structuredSessionIdleEdgeMailboxes').mockReturnValue([
      'term_mailbox'
    ])
    const events: string[] = []
    Object.defineProperties(target, {
      notifyStructuredSessionJournalActivity: {
        value: function (this: OrcaRuntimeService, sessionId: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          events.push(`journal:${sessionId}`)
        }
      },
      deliverPendingMessagesForHandle: {
        value: function (this: OrcaRuntimeService, handle: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          events.push(`delivery:${handle}`)
        }
      }
    })

    target.onStructuredSessionStatusForMail({ sessionId: 'session-mailbox', status: 'working' })
    expect(events).toEqual([])
    target.onStructuredSessionStatusForMail({ sessionId: 'session-mailbox', status: 'idle' })
    expect(events).toEqual(['journal:session-mailbox', 'delivery:term_mailbox'])
  })

  it('uses the runtime delivery override during repoint repair', () => {
    const target = new OrcaRuntimeService()
    const delivery = vi.fn(function (this: OrcaRuntimeService, handle: string) {
      expect(this).toBe(target)
      expect(arguments.length).toBe(1)
      expect(handle).toBe('term_mailbox')
    })
    Object.defineProperty(target, 'deliverPendingMessagesForHandle', { value: delivery })

    target['repointPendingMessagesForHandle']('term_mailbox')
    expect(delivery).toHaveBeenCalledOnce()
  })

  it('uses runtime coordinator and direct worker target overrides', () => {
    const target = new OrcaRuntimeService()
    Object.defineProperties(target, {
      resolveStructuredCoordinatorMailboxTarget: {
        value: function (this: OrcaRuntimeService, runId: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          expect(runId).toBe('run-mailbox')
          return { sessionId: 'coordinator-session', dispatchId: null }
        }
      },
      resolveStructuredWorkerDirectMailboxTarget: {
        value: function (this: OrcaRuntimeService, handle: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          expect(handle).toBe('term_mailbox')
          return { sessionId: 'worker-session', dispatchId: null }
        }
      }
    })

    expect(target['resolveStructuredMailboxTarget']('run:run-mailbox')).toEqual({
      sessionId: 'coordinator-session',
      dispatchId: null
    })
    expect(target['resolveStructuredMailboxTarget']('term_mailbox')).toEqual({
      sessionId: 'worker-session',
      dispatchId: null
    })
  })
})

abstract class MailSchedulerPhaseProbe extends OrcaRuntimeWithRuntimeId {
  readonly pendingMailDuringConstruction = this.mailPointerRepointScheduler.pendingCount
}

class ConstructorMailStatusProbe extends OrcaRuntimeService {
  protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
    this.onStructuredSessionStatusForMail({ sessionId: 'construction', status: 'working' })
    return super.canonicalFetchKeyCache
  }
}

describe('input state before later runtime layers initialize', () => {
  it('makes the scheduler available immediately after the original base layer', () => {
    expect(
      Object.getOwnPropertyDescriptor(
        Reflect.construct(MailSchedulerPhaseProbe, []),
        'pendingMailDuringConstruction'
      )?.value
    ).toBe(0)
  })

  it('preserves mail method reentry from the original constructor getter seam', () => {
    expect(() => new ConstructorMailStatusProbe()).not.toThrow()
  })
})

describe('checked runtime construction', () => {
  it('reads the existing fetch resource during construction through virtual getters', () => {
    const reads: string[] = []
    class FetchResourceProbe extends OrcaRuntimeService {
      protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        reads.push('key')
        expect(this.store).toBeNull()
        expect(this.skillCommands).toBeDefined()
        expect(this.stopRequestedPtyIds).toBeInstanceOf(Set)
        return super.canonicalFetchKeyCache
      }
      protected get fetchLastCompletedAt(): ReadonlyMap<string, number> {
        reads.push('time')
        expect(this.getAgentStatusSnapshotFn).toBeUndefined()
        return super.fetchLastCompletedAt
      }
      get maps() {
        return [super.canonicalFetchKeyCache, super.fetchLastCompletedAt]
      }
    }
    const first = new FetchResourceProbe(null)
    const second = new FetchResourceProbe()
    expect(reads).toEqual(['key', 'time', 'key', 'time'])
    expect(first.getAgentStatusSnapshotFn).toBeNull()
    expect(second.getAgentStatusSnapshotFn).toBeNull()
    expect(first.maps).toEqual([new Map(), new Map()])
    expect(first.maps[0]).not.toBe(second.maps[0])
    expect(first.maps[1]).not.toBe(second.maps[1])
  })

  it('installs subscription callbacks on the runtime with their real registry receiver', () => {
    const runtime = new OrcaRuntimeService()
    const cleanup = vi.fn()
    runtime.registerSubscriptionCleanup('construction-subscription', cleanup)
    runtime.cleanupSubscription('construction-subscription')
    expect(cleanup).toHaveBeenCalledOnce()
    runtime.cleanupSubscription('construction-subscription')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('keeps constructor callbacks lazy and the canonical status producer identity', () => {
    const snapshot = vi.fn(() => [])
    const stopped = vi.fn()
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentStatusSnapshot: snapshot,
      onPtyStopped: stopped
    })
    expect(runtime.getAgentStatusSnapshotFn).toBe(snapshot)
    expect(runtime['onPtyStopped']).toBe(stopped)
    expect(snapshot).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
  })
})
