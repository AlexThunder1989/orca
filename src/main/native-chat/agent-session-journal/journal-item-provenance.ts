// Execution provenance: the generation whose execution produced an item (`JournalItemRow.ownerFence`),
// kept apart from each row's writer fence. The write that creates an item states it; every revision
// keeps it.

import type { JournalReducerState } from './journal-reducer'

/** An existing item keeps its owner whoever revises it: a newer run's start revises the newest saved
 *  turn. Creation states the writer's claim (an observation, carried history), else its fence. */
export function journalItemOwnerFence(
  state: Pick<JournalReducerState, 'itemFences' | 'items'>,
  resolvedItemId: string,
  write: { fence: number; ownerFence?: number }
): number {
  const kept = state.items.has(resolvedItemId) ? state.itemFences.get(resolvedItemId) : undefined
  return kept ?? write.ownerFence ?? write.fence
}
