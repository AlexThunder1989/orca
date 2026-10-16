// The one layout client (design 3.1): the `layout.subscribe` stream over the same transport-agnostic
// RPC path for the local runtime and a remote server. It holds no layout; frames go to the caller's
// read-only cache. Unused until the switch.

import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  readWorkspaceLayoutStreamFrame,
  type WorkspaceLayoutChangeFrame,
  type WorkspaceLayoutStreamFrame
} from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

/** `lost`: the stream ended without a refusal and the client stopped. `refused`: the host answered
 *  that it will never serve this stream, so the client stopped. */
export type RuntimeLayoutStreamStatus =
  | { state: 'connecting' | 'live' | 'lost' | 'closed' }
  | { state: 'refused'; code: string }

// An older host without the method, or a caller scope denied it: a retry gets the same answer.
const REFUSAL_CODES = ['method_not_found', 'forbidden'] as const

/**
 * Opens the stream once; `onFrame` gets a snapshot first, then that stream's changes. A local
 * stream ends only on close, document retirement or a refusal, so nothing reopens it. A remote
 * stream that drops reports `lost`; reopening it belongs to the connection's reconnect.
 */
export function subscribeRuntimeLayout(
  target: RuntimeClientTarget,
  params: { workspaces?: 'all' | string[] },
  onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
  onStatus: (status: RuntimeLayoutStreamStatus) => void
): { close: () => void } {
  // Bumped whenever a stream is given up, so its late callbacks change nothing.
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let state: RuntimeLayoutStreamStatus['state'] = 'connecting'

  const setStatus = (status: RuntimeLayoutStreamStatus): void => {
    state = status.state
    onStatus(status)
  }

  const release = (): void => {
    generation += 1
    handle?.unsubscribe()
    handle = null
  }

  const stop = (status: RuntimeLayoutStreamStatus): void => {
    release()
    setStatus(status)
  }

  const lose = (streamGeneration: number, error?: unknown): void => {
    if (streamGeneration !== generation) {
      return
    }
    if (error !== undefined) {
      console.warn('[workspace-layout] layout stream lost:', error)
    }
    const refusal = REFUSAL_CODES.find((code) => hasRuntimeRpcErrorCode(error, code))
    stop(refusal ? { state: 'refused', code: refusal } : { state: 'lost' })
  }

  const receive = (streamGeneration: number, frame: WorkspaceLayoutStreamFrame | null): void => {
    // Null: a newer host's frame type or an unreadable frame; neither may change the cache.
    if (streamGeneration !== generation || !frame) {
      return
    }
    if (frame.type === 'end') {
      lose(streamGeneration)
      return
    }
    if (frame.type === 'snapshot') {
      setStatus({ state: 'live' })
    } else if (state !== 'live') {
      // The host sends the snapshot first; a change before it has nothing to replace.
      return
    }
    onFrame(frame)
  }

  const open = async (): Promise<void> => {
    const streamGeneration = ++generation
    setStatus({ state: 'connecting' })
    try {
      const opened = await subscribeRuntimeRpc(target, 'layout.subscribe', params, {
        onEvent: (result) => receive(streamGeneration, readWorkspaceLayoutStreamFrame(result)),
        onError: (error) => lose(streamGeneration, error),
        onClose: () => lose(streamGeneration)
      })
      if (streamGeneration !== generation) {
        opened.unsubscribe()
        return
      }
      handle = opened
    } catch (error) {
      lose(streamGeneration, error)
    }
  }

  void open()
  return {
    close: () => {
      if (state === 'connecting' || state === 'live') {
        stop({ state: 'closed' })
      }
    }
  }
}
