// Host-held drafts as this pane acts on them: the card list, Send-now (Steer),
// Delete, in-place Edit, the Cmd/Ctrl+Enter steer chord, and a held queue's Resume and Clear all.
// Everything durable lives on the host; an open editor holds only its own typing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { mapSettledWithConcurrency } from '../../../../shared/map-with-concurrency'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionQueuePause,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  useStructuredAgentSessionQueuedEdit,
  type QueuedEditTransport,
  type QueuedMessageInlineEditor
} from './use-structured-agent-session-queued-edit'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import {
  newestSteerableQueuedMessageCard,
  projectQueuedMessageCards,
  pendingQueueSendsOnTheirWay,
  queuedMessagesQueuePause,
  sendingQueuedMessageCards,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

export type StructuredAgentSessionQueuedMessagesController = {
  cards: QueuedMessageCard[]
  /** The host queues sends. Without it a card can still show — a message the host kept unsent —
   *  but queueing settings and the steer chord would do nothing. */
  queueCapable: boolean
  clearCapable: boolean
  /** Why the queue holds cards Resume would send: the header row above them. A string reason: a
   *  newer host may name one this build does not know. */
  pause: { reason: string } | null
  /** Whether the host lifted the pause; a failure is a toast, and Resume is the retry. */
  resume: () => Promise<boolean>
  /** A Resume is in flight. */
  resuming: boolean
  /** Delete every card shown; false when one could not be (already a toast). */
  clear: () => Promise<boolean>
  /** Send-now into the running turn; the transcript shows it at delivery position. */
  steer: (messageId: string) => Promise<void>
  remove: (messageId: string) => Promise<void>
  /** The host edits cards in place; without it a card offers no Edit. */
  editCapable: boolean
  /** The card being edited in this pane, at most one. */
  editor: QueuedMessageInlineEditor | undefined
  /** Opens the card's inline editor. */
  edit: (messageId: string) => Promise<void>
  /** Cmd/Ctrl+Enter: Send-now the newest card. False when there is none to steer. */
  steerNewest: () => boolean
}

const NO_SENDS: readonly StructuredAgentSessionPendingSend[] = []
const CLEAR_DELETE_CONCURRENCY = 8

function alreadySentNotice(): void {
  toast.error(
    translate('components.native-chat.queuedMessages.alreadySent', 'This message was already sent.')
  )
}

export function useStructuredAgentSessionQueuedMessages(args: {
  /** Host advertises `agent-session.queued-messages.v1` and the transport has a fence. */
  enabled: boolean
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  queuePause: AgentSessionQueuePause | null
  submissions: readonly AgentJournalSubmission[]
  hasPendingPrompt: boolean
  /** A turn is running, whoever started it, or the queue is about to send its next card. */
  isWorking: boolean
  /** This pane's sends without a host record yet show as sending cards. */
  sending?: readonly StructuredAgentSessionPendingSend[]
  composerScopeKey: string | undefined
  mutate: StructuredAgentSessionMutate
  editTransport: QueuedEditTransport
}): StructuredAgentSessionQueuedMessagesController {
  const { composerScopeKey, enabled, hasPendingPrompt, mutate, queuedMessages, submissions } = args
  const { isWorking, queuePause } = args
  const sending = args.sending ?? NO_SENDS

  const cards = useMemo(
    () => [
      ...projectQueuedMessageCards(queuedMessages, submissions, {
        // A command card offers no send while the agent works.
        agentWorking: isWorking,
        queuePaused: queuePause !== null
      }),
      ...sendingQueuedMessageCards(
        pendingQueueSendsOnTheirWay(
          sending,
          (queuedMessages ?? []).map((message) => message.messageId),
          isWorking,
          submissions
        )
      )
    ],
    [isWorking, sending, queuePause, queuedMessages, submissions]
  )
  const cardsRef = useRef(cards)
  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  // One action per card at a time: a double-click or a chord repeat is not a second request.
  const actingOnRef = useRef(new Set<string>())
  const actOnce = useCallback(
    async (messageId: string, action: () => Promise<void>): Promise<void> => {
      if (actingOnRef.current.has(messageId)) {
        return
      }
      actingOnRef.current.add(messageId)
      try {
        await action()
      } finally {
        actingOnRef.current.delete(messageId)
      }
    },
    []
  )

  const steer = useCallback(
    (messageId: string): Promise<void> =>
      actOnce(messageId, async () => {
        await mutate<AgentSessionSendResult>(
          'agentSession.queuedMessageSend',
          'agentSession.queuedMessageSend',
          { messageId }
        )
      }),
    [actOnce, mutate]
  )

  /** True once the card has left the queue, deleted or already sent; a failure is a toast. */
  const removeCard = useCallback(
    async (messageId: string): Promise<boolean> => {
      let removed = false
      await actOnce(messageId, async () => {
        const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
          'agentSession.queuedMessageDelete',
          'agentSession.queuedMessageDelete',
          { messageId }
        )
        if (result && !result.deleted && result.disposition === 'dispatched') {
          alreadySentNotice()
        }
        removed = result !== null
      })
      return removed
    },
    [actOnce, mutate]
  )
  const remove = useCallback(
    async (messageId: string): Promise<void> => {
      await removeCard(messageId)
    },
    [removeCard]
  )

  const editing = useStructuredAgentSessionQueuedEdit({
    transport: args.editTransport,
    messages: queuedMessages,
    cards,
    submissions,
    composerScopeKey,
    promptOpen: hasPendingPrompt
  })

  const steerNewest = useCallback((): boolean => {
    if (!enabled) {
      return false
    }
    const newest = newestSteerableQueuedMessageCard(cardsRef.current)
    if (!newest) {
      return false
    }
    void steer(newest.messageId)
    return true
  }, [enabled, steer])

  const resumingRef = useRef(false)
  const [resuming, setResuming] = useState(false)
  const resume = useCallback(async (): Promise<boolean> => {
    if (resumingRef.current) {
      return false
    }
    resumingRef.current = true
    setResuming(true)
    try {
      const result = await mutate<AgentSessionQueuedMessagesResumeResult>(
        'agentSession.queuedMessagesResume',
        'agentSession.queuedMessagesResume',
        {}
      )
      return result?.resumed === true
    } finally {
      resumingRef.current = false
      setResuming(false)
    }
  }, [mutate])
  const pause = useMemo(() => queuedMessagesQueuePause(cards, queuePause), [cards, queuePause])

  const clearCapable = !cards.some((card) => card.hold === 'sending')
  const clearingRef = useRef<Promise<boolean> | null>(null)
  const clearCards = useCallback(async (): Promise<boolean> => {
    if (!clearCapable) {
      return false
    }
    const messageIds = cardsRef.current
      .filter((card) => card.hold !== 'sending')
      .map((card) => card.messageId)
    if (messageIds.length === 0) {
      return false
    }
    const results = await mapSettledWithConcurrency(
      messageIds,
      CLEAR_DELETE_CONCURRENCY,
      (messageId) =>
        args.editTransport.write<AgentSessionQueuedMessageDeleteResult>(
          'agentSession.queuedMessageDelete',
          'agentSession.queuedMessageDelete',
          { messageId }
        )
    )
    const dispatched = results.some(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.kind === 'done' &&
        !result.value.value.deleted &&
        result.value.value.disposition === 'dispatched'
    )
    const failure = results.find(
      (result) => result.status === 'fulfilled' && result.value.kind === 'not-done'
    )
    if (failure?.status === 'fulfilled' && failure.value.kind === 'not-done') {
      toast.error(failure.value.notice)
    }
    if (dispatched) {
      alreadySentNotice()
    }
    return (
      !dispatched &&
      results.every((result) => result.status === 'fulfilled' && result.value.kind === 'done')
    )
  }, [args.editTransport, clearCapable])
  const clear = useCallback((): Promise<boolean> => {
    const pending =
      clearingRef.current ??
      clearCards().finally(() => {
        clearingRef.current = null
      })
    clearingRef.current = pending
    return pending
  }, [clearCards])

  return {
    cards,
    queueCapable: enabled,
    clearCapable,
    pause,
    resume,
    resuming,
    clear,
    steer,
    remove,
    edit: editing.begin,
    editCapable: editing.capable,
    editor: editing.editor,
    steerNewest
  }
}
