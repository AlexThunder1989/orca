// Where the conversation stood when the reader last looked away from it: the "New" marker draws
// above the first row that came, or kept growing, while they were away.

import { useCallback, useMemo, useState } from 'react'
import { useOrcaWindowForegroundFocused } from '@/hooks/use-orca-window-foreground-focused'
import { compareAgentJournalPositions } from '../../../../shared/agent-session-journal-position'
import type { AgentJournalPosition } from '../../../../shared/agent-session-journal-types'
import {
  nativeChatSlotIndexOf,
  nativeChatSlotKey,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

/** A drawn row of the conversation itself, as the journal places it. A terminal-backed chat's
 *  rows carry no position, so it marks nothing. */
function rowPosition(slot: NativeChatTranscriptSlot): AgentJournalPosition | undefined {
  return slot.kind === 'message' && slot.depth === 0 && slot.drawsMessage
    ? slot.message.journalPosition
    : undefined
}

/** Before every row the journal places: what the reader has read to when no row precedes. */
const BEFORE_EVERY_ROW: AgentJournalPosition = { sequence: -1, index: 0 }

/** Where a reader who looks away now has read to, and the reply the agent is still writing. */
type NativeChatLeftAt = {
  /** The newest row there was, as a position: that row may have folded away by the return. */
  position: AgentJournalPosition
  /** The reply still being written. Grown by the return, it counts as new, and the marker
   *  draws from the row `before` it. */
  writing: { key: string; size: number; before: AgentJournalPosition } | null
}

function rowSize(slot: NativeChatTranscriptSlot): number {
  return slot.kind === 'message'
    ? JSON.stringify((slot.workRun ?? [slot.message]).map((message) => message.blocks)).length
    : 0
}

/** The newest row's position, among those placed before `limit` when one is given. */
function newestRowPosition(
  slots: readonly NativeChatTranscriptSlot[],
  limit?: AgentJournalPosition
): AgentJournalPosition {
  let newest = BEFORE_EVERY_ROW
  for (const slot of slots) {
    const at = rowPosition(slot)
    if (
      at &&
      (!limit || compareAgentJournalPositions(at, limit) < 0) &&
      compareAgentJournalPositions(at, newest) > 0
    ) {
      newest = at
    }
  }
  return newest
}

function nativeChatLeftAt(
  slots: readonly NativeChatTranscriptSlot[],
  waitingSlots: readonly NativeChatTranscriptSlot[]
): NativeChatLeftAt {
  const all = [...slots, ...waitingSlots]
  // The working turn's latest row of the agent's own, wherever the reader's prompts sit: one
  // delivered into the turn or held behind it comes after the reply and does not stop it growing.
  const writer = slots.findLast(
    (slot) =>
      slot.kind === 'message' &&
      slot.activeTurnIsWorking &&
      slot.message.role !== 'user' &&
      rowPosition(slot) !== undefined
  )
  const at = writer && rowPosition(writer)
  const writing = at
    ? { key: nativeChatSlotKey(writer), size: rowSize(writer), before: newestRowPosition(all, at) }
    : null
  return { position: newestRowPosition(all), writing }
}

/** Key of the first row that came, or kept growing, while the reader was away and that they
 *  did not write, or null. The row, not a position: a queued message is placed again when it
 *  is handed over. */
function nativeChatFirstNewRow(
  slots: readonly NativeChatTranscriptSlot[],
  { position, writing }: NativeChatLeftAt
): string | null {
  const row = writing && slots.find((slot) => nativeChatSlotKey(slot) === writing.key)
  const readTo = writing && !(row && rowSize(row) === writing.size) ? writing.before : position
  const first = slots.find((slot) => {
    const at = rowPosition(slot)
    return (
      at !== undefined &&
      compareAgentJournalPositions(at, readTo) > 0 &&
      (slot.kind !== 'message' || slot.message.role !== 'user' || slot.message.from !== undefined)
    )
  })
  return first ? nativeChatSlotKey(first) : null
}

export type NativeChatNewRowsMarkerPlacement = {
  /** Key of the row the marker draws in. */
  key: string
  place: 'above-row' | 'above-turn-bar'
}

/** What the row that draws the marker is handed. */
export type NativeChatNewRowsMarkerState = NativeChatNewRowsMarkerPlacement & {
  /** The reader has just come back: bring the marker into view, once. */
  arriving: boolean
  onArrived: () => void
  onDismiss: () => void
}

/** Above the row `firstNew` names, or above the turn bar when that bar is all that parts the
 *  row from the reader's prompt: the two lines would touch. */
export function nativeChatNewRowsMarkerPlacement(
  slots: readonly NativeChatTranscriptSlot[],
  firstNew: string | null
): NativeChatNewRowsMarkerPlacement | undefined {
  if (firstNew === null) {
    return undefined
  }
  const index = nativeChatSlotIndexOf(slots, firstNew)
  const first = slots[index]
  if (!first) {
    return undefined
  }
  const before = slots[index - 1]
  return before?.kind === 'message' && before.status && !before.statusAbove && !before.turnDiff
    ? { key: nativeChatSlotKey(before), place: 'above-turn-bar' }
    : { key: nativeChatSlotKey(first), place: 'above-row' }
}

export function useNativeChatNewRowsMarker(
  slots: readonly NativeChatTranscriptSlot[],
  /** Rows held behind the running turn: seen and missed like any other, drawn outside `slots`. */
  waitingSlots: readonly NativeChatTranscriptSlot[],
  /** The pane is the one showing, and shows what the host holds now. */
  isShowingLatest: boolean
): {
  marker: NativeChatNewRowsMarkerState | undefined
  /** The reader answered the conversation, so nothing in it is news to them. */
  dismiss: () => void
} {
  const watching = useOrcaWindowForegroundFocused(isShowingLatest)
  const [seen, setSeen] = useState<{
    watching: boolean
    /** While the reader is away: where they had read to. */
    left: NativeChatLeftAt | null
    /** Key of the first row that came while the reader was away. It stands until they answer. */
    firstNew: string | null
    arriving: boolean
  }>({ watching, left: null, firstNew: null, arriving: false })
  if (seen.watching !== watching) {
    const all = [...slots, ...waitingSlots]
    if (watching) {
      const firstNew = seen.left ? nativeChatFirstNewRow(all, seen.left) : seen.firstNew
      setSeen({ watching, left: null, firstNew, arriving: seen.left !== null && firstNew !== null })
    } else {
      // An unanswered marker whose row still stands is kept: the reader may be midway through it.
      const marked = seen.firstNew !== null && nativeChatSlotIndexOf(all, seen.firstNew) >= 0
      setSeen({ ...seen, watching, left: marked ? null : nativeChatLeftAt(slots, waitingSlots) })
    }
  }
  const { firstNew } = seen
  const placement = useMemo(
    () => nativeChatNewRowsMarkerPlacement(slots, firstNew),
    [slots, firstNew]
  )
  const dismiss = useCallback(() => {
    // Where they left as well: an answer sent before the chat has caught up settles that too.
    setSeen((held) =>
      held.firstNew === null && held.left === null ? held : { ...held, firstNew: null, left: null }
    )
  }, [])
  const onArrived = useCallback(() => {
    setSeen((held) => (held.arriving ? { ...held, arriving: false } : held))
  }, [])
  const { key, place } = placement ?? {}
  const marker = useMemo(
    () =>
      key && place
        ? { key, place, arriving: seen.arriving, onArrived, onDismiss: dismiss }
        : undefined,
    [key, place, seen.arriving, onArrived, dismiss]
  )
  return { marker, dismiss }
}
