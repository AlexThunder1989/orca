import { describe, expect, it } from 'vitest'
import {
  installChatViewHooks,
  assistantTurn,
  listIds,
  render,
  renderedRow,
  update
} from './MobileNativeChatView.harness.test-fixture'

describe('MobileNativeChatView: rows and the streaming bubble', () => {
  installChatViewHooks()

  // The gate that decides `streaming` lives in MobileNativeChatOverlay, which
  // outlives this view; see MobileNativeChatOverlay.test.ts.
  it('appends the gated streaming bubble after the folded transcript', async () => {
    const folded = [assistantTurn('a1', 'The tests pass.')]
    await render({ folded })
    expect(listIds()).toEqual(['a1'])

    await update({ folded, streaming: 'The tests' })

    expect(listIds()).toEqual(['a1', 'streaming'])
  })

  it('tells a row whether the host still waits on the prompt it stands for', async () => {
    const rows = [assistantTurn('asked', 'Tea or coffee?'), assistantTurn('open', 'Which branch?')]
    await render({ messages: rows, folded: rows, actionablePromptIds: ['open'] })
    expect(renderedRow('asked').props.awaiting).toBe(false)
    expect(renderedRow('open').props.awaiting).toBe(true)
  })

  it('renders an accepted optimistic image send without a queued state', async () => {
    await render({
      pending: [{ id: 'pending-1', text: 'look', images: ['file:///phone-photo.jpg'] }]
    })

    expect(listIds()).toEqual(['pending-1'])
    expect(renderedRow('pending-1').props).not.toHaveProperty('queued')
  })
})
