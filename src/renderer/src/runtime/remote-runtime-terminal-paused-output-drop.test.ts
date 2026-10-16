import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './remote-runtime-terminal-multiplexer'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
}

type HostCapabilities = { outputPause?: 1; outputPauseDropNotice?: 1 }

describe('remote terminal paused-output drop notice', () => {
  let callbacks: SubscribeCallbacks
  let streamId = 0
  let cursor = 0
  let hostCapabilities: HostCapabilities
  let subscribeCapabilities: Record<string, unknown> | undefined
  let snapshotRequests: { requestId?: number }[]

  const send = (opcode: TerminalStreamOpcode, payload: Uint8Array, seq = 0): void =>
    callbacks.onBinary?.(encodeTerminalStreamFrame({ opcode, streamId, seq, payload }))
  const output = (text: string): void => {
    cursor += text.length
    send(TerminalStreamOpcode.Output, encodeTerminalStreamText(text), cursor)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    cursor = 0
    snapshotRequests = []
    const subscribe = vi.fn(async (_args: unknown, next: SubscribeCallbacks) => {
      callbacks = next
      queueMicrotask(() => next.onResponse({ ok: true, result: { type: 'ready' } }))
      return {
        unsubscribe: vi.fn(),
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (frame?.opcode === TerminalStreamOpcode.Subscribe) {
            const payload = decodeTerminalStreamJson<{
              streamId: number
              capabilities?: Record<string, unknown>
            }>(frame.payload)
            streamId = payload?.streamId ?? 0
            subscribeCapabilities = payload?.capabilities
            next.onResponse({
              ok: true,
              result: { type: 'subscribed', streamId, capabilities: hostCapabilities }
            })
            send(TerminalStreamOpcode.SnapshotStart, encodeTerminalStreamJson({ seq: cursor }))
            send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
          } else if (frame?.opcode === TerminalStreamOpcode.SnapshotRequest) {
            snapshotRequests.push(decodeTerminalStreamJson(frame.payload) ?? {})
          }
        }
      }
    })
    stubRuntimeEnvironmentBridge({ subscribe })
  })

  async function subscribeClient() {
    const data: string[] = []
    const onPausedOutputDropped = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: {
        onData: (chunk) => data.push(chunk),
        onSnapshot: () => {},
        onPausedOutputDropped
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    return { data, onPausedOutputDropped, stream }
  }

  /** Paused host discards `dropped`, optionally announcing it, then resumes with `live`. */
  function pauseDropAndResume(
    stream: { setOutputPaused: (paused: boolean) => boolean },
    announce: boolean
  ): void {
    stream.setOutputPaused(true)
    cursor += 'dropped-while-hidden'.length
    if (announce) {
      send(TerminalStreamOpcode.PausedOutputDropped, new Uint8Array())
    }
    stream.setOutputPaused(false)
    output('live')
  }

  it('offers the capability and treats the announced pause gap as covered, not a resync', async () => {
    hostCapabilities = { outputPause: 1, outputPauseDropNotice: 1 }
    const { data, onPausedOutputDropped, stream } = await subscribeClient()
    expect(subscribeCapabilities).toMatchObject({ outputPause: 1, outputPauseDropNotice: 1 })
    expect(stream.reportsPausedOutputDrops?.()).toBe(true)

    output('before')
    pauseDropAndResume(stream, true)

    expect(onPausedOutputDropped).toHaveBeenCalledTimes(1)
    expect(data).toEqual(['before', 'live'])
    expect(snapshotRequests).toEqual([])

    // The exemption covers only that pause: a later unannounced gap still resyncs.
    cursor += 5
    output('after-real-gap')
    expect(snapshotRequests).toHaveLength(1)
    expect(snapshotRequests[0]?.requestId).toBeUndefined()
  })

  it('keeps the resync for an older host that does not negotiate drop notices', async () => {
    hostCapabilities = { outputPause: 1 }
    const { data, onPausedOutputDropped, stream } = await subscribeClient()
    expect(stream.reportsPausedOutputDrops?.()).toBe(false)

    // An unnegotiated frame is ignored rather than trusted.
    pauseDropAndResume(stream, true)

    expect(onPausedOutputDropped).not.toHaveBeenCalled()
    expect(data).toEqual([])
    expect(snapshotRequests).toHaveLength(1)
  })
})
