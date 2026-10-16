import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  composer,
  render,
  update
} from './MobileNativeChatView.harness.test-fixture'

describe('MobileNativeChatView: composer lock and prompt cards', () => {
  installChatViewHooks()

  it('keeps a visible lock through a subscribed-end lease blip', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(composer().props.disabled).toBe(true)

      await update({ inputLockReason: null })
      expect(composer().props.disabled).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      await update({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })

      expect(composer().props.disabled).toBe(true)
      expect(composer().props.placeholder).toBe('Waiting for terminal…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('unlocks after the lease stays ready', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      await update({ inputLockReason: null })
      await act(async () => {
        vi.advanceTimersByTime(599)
      })
      expect(composer().props.disabled).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(1)
      })

      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a terminal-backed send types into the agent's prompt and could answer it; drafting cannot.
  describe('a prompt card owns Send in terminal-backed chat', () => {
    const permission = { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] }

    it('blocks only Send while the card shows, and frees it when the card clears', async () => {
      await render({ permission })
      expect(composer().props.sendDisabled).toBe(true)
      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')

      await update({ permission: null })
      expect(composer().props.sendDisabled).toBe(false)
    })

    it('blocks Send for an ask and a heuristic question too', async () => {
      await render({
        ask: {
          questions: [{ question: 'Tabs?', multiSelect: false, options: [{ label: 'Tabs' }] }]
        }
      })
      expect(composer().props.sendDisabled).toBe(true)
      await update({
        question: { question: 'Name?', options: [], multiSelect: false, optionTokens: [] }
      })
      expect(composer().props.sendDisabled).toBe(true)
    })

    it('leaves a structured chat composer open: its host queues the send behind the prompt', async () => {
      await render({ permission, structuredActivityUi: true })
      expect(composer().props.sendDisabled).toBe(false)
    })
  })
})
