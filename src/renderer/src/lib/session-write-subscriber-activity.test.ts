import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { isWindowSessionWriteBusy } from './window-session-write-activity'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

describe('session write activity in a layout-owner build', () => {
  let initial: AppState
  let dispose: (() => void) | undefined
  beforeEach(() => {
    initial = useAppStore.getState()
    vi.useFakeTimers()
  })
  afterEach(() => {
    dispose?.()
    dispose = undefined
    vi.useRealTimers()
    useAppStore.setState(initial, true)
  })

  it('is busy from a change until main acknowledges its write', async () => {
    let acknowledge!: () => void
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve
        })
    )
    dispose = createSessionWriteSubscriber({ store: useAppStore, persist })
    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    // The first write after the gate opens.
    await vi.advanceTimersByTimeAsync(200)
    acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect(isWindowSessionWriteBusy()).toBe(false)

    useAppStore.setState({ activeTabId: 'tab-2' })
    expect(isWindowSessionWriteBusy()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(isWindowSessionWriteBusy()).toBe(true)
    acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect(isWindowSessionWriteBusy()).toBe(false)
  })

  it('is busy before the window may save, and after a failed write until it resends', async () => {
    const persist = vi.fn(() => Promise.reject(new Error('main unavailable')))
    dispose = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      onPersistError: () => {}
    })
    expect(isWindowSessionWriteBusy()).toBe(true)
    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(isWindowSessionWriteBusy()).toBe(true)
  })

  it('is idle once disposed', () => {
    dispose = createSessionWriteSubscriber({ store: useAppStore, persist: vi.fn() })
    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    expect(isWindowSessionWriteBusy()).toBe(true)
    dispose()
    dispose = undefined
    expect(isWindowSessionWriteBusy()).toBe(false)
  })
})
