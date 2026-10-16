import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalStreamOpcode } from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitSnapshot,
  emitSnapshotFrame,
  inputFrameTexts,
  subscribeFrameCount,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

beforeEach(() => {
  resetRemoteRuntimeTransport()
  runtimeSubscribe.mockImplementation(
    async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
      subscriptionCallbacks = callbacks
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
    }
  )
})

function acknowledgeSubscribe(streamId: number): void {
  subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
}

/** Connects, drops the link, and waits for the recovery resubscribe to go out. */
async function recoveringTransport() {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  await transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  const first = latestSubscribePayload().streamId
  acknowledgeSubscribe(first)
  emitSnapshot(first, 'prompt$ ')
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  subscriptionCallbacks?.onError?.({
    code: 'remote_runtime_unavailable',
    message: 'Remote runtime connection closed.'
  })
  await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
  return { transport, streamId: latestSubscribePayload().streamId }
}

describe('remote recovery input at the subscribed ack', () => {
  it('sends held typing once the host acks the subscribe, before its snapshot finishes', async () => {
    const { transport, streamId } = await recoveringTransport()
    expect(transport.sendInput('held-', 'driving')).toBe(true)
    expect(inputFrameTexts()).toEqual([])

    acknowledgeSubscribe(streamId)
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['held-']))
    // Typing during a large snapshot transfer goes straight out, after the held bytes.
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotStart, new Uint8Array())
    expect(transport.sendInput('live', 'driving')).toBe(true)
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('held-live'))
    expect(transport.isConnected()).toBe(false)

    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    expect(inputFrameTexts().join('')).toBe('held-live')
    transport.destroy?.()
  })

  it('holds typing again when the acked stream drops before its snapshot ends', async () => {
    const { transport, streamId } = await recoveringTransport()
    acknowledgeSubscribe(streamId)
    subscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote runtime connection closed.'
    })
    expect(transport.sendInput('after-drop', 'driving')).toBe(true)
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(3))
    expect(inputFrameTexts()).toEqual([])
    const next = latestSubscribePayload().streamId
    acknowledgeSubscribe(next)
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['after-drop']))
    transport.destroy?.()
  })

  it('holds typing again when recovery backs off while the acked stream stays installed', async () => {
    const { transport, streamId } = await recoveringTransport()
    acknowledgeSubscribe(streamId)
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId, message: 'Remote runtime call queue is full.' }
    })
    expect(transport.sendInput('during-backoff', 'driving')).toBe(true)
    // Outlasts the input debounce, so an unheld key would have reached the stream.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(inputFrameTexts()).toEqual([])
    transport.destroy?.()
  })
})
