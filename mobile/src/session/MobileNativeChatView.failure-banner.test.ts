import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  assistantTurn,
  banners,
  bannerText,
  hostType,
  listIds,
  pressSend,
  render,
  root,
  update
} from './MobileNativeChatView.harness.test-fixture'

describe('MobileNativeChatView: send and read failure banners', () => {
  installChatViewHooks()

  // A read no retry gets past takes the whole pane, even over a transcript already on screen: its
  // words alone, and nothing that could only be refused again.
  it('leaves only the words of a read that failed for good, over a loaded transcript', async () => {
    const loaded = [assistantTurn('m1', 'earlier reply')]
    const words = 'This chat was saved by a newer Orca. Update Orca to open it.'
    const shown = (text: string) =>
      root().findAll((node) => hostType(node) === 'Text' && node.props.children === text)
    const composers = () => root().findAll((node) => hostType(node) === 'Composer')
    const lists = () => root().findAll((node) => hostType(node) === 'FlatList')
    const failure = {
      messages: loaded,
      folded: loaded,
      status: 'error' as const,
      error: words,
      canStop: true,
      permission: { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] },
      // A resend answered unknown says nothing beside the read's words.
      sendErrorMessage: 'Message unconfirmed — check chat before retrying'
    }
    await render({ ...failure, readFailedFinally: true })
    expect(shown(words)).toHaveLength(1)
    expect(composers()).toHaveLength(0)
    expect(lists()).toHaveLength(0)
    expect(banners()).toHaveLength(0)
    expect(root().findAllByProps({ accessibilityLabel: 'Stop the agent' })).toHaveLength(0)

    // A failure that can clear keeps the transcript and the composer.
    await update({ ...failure, error: "Orca couldn't open this chat's history right now." })
    expect(listIds()).toEqual(['m1'])
    expect(composers()).toHaveLength(1)
    expect(banners()).toHaveLength(1)
  })

  it('renders the route-reported failure verbatim', async () => {
    await render({ sendErrorMessage: 'Permission reply failed' })

    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Permission reply failed')
  })

  it('does not duplicate the route banner when the composer rejects', async () => {
    const onClearSendError = vi.fn()
    await render({
      onSend: vi.fn().mockResolvedValue(false),
      inputLockReason: 'disconnected',
      sendErrorMessage: 'Stop failed',
      onClearSendError
    })
    await pressSend()

    expect(onClearSendError).not.toHaveBeenCalled()
    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Stop failed')
    expect(bannerText()).toBe('Stop failed')
  })

  it('retires the route-owned banner once a send is accepted', async () => {
    const onClearSendError = vi.fn()
    await render({ sendErrorMessage: 'Stop failed', onClearSendError })

    await pressSend()

    expect(onClearSendError).toHaveBeenCalledOnce()
  })
})
