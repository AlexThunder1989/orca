import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { scheduleNextFrame } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Focus attempts per reveal, including recovery from delayed programmatic restoration. */
const REVEAL_FOCUS_FRAMES = 6

const revealedComposerReclaims = new Map<string, () => void>()

/** Re-clicking a chat's active tab claims its composer again, as a terminal tab refocuses xterm. */
export function requestNativeChatComposerFocus(tabId: string): void {
  revealedComposerReclaims.get(tabId)?.()
}

export type NativeChatComposerRevealFocusArgs = {
  /** The tab whose activation re-runs the claim (the terminal tab for a chat view over a TUI). */
  tabId: string
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  isVisible: boolean
  /** This pane's split group is the focused one; false keeps a revealed sibling from fighting. */
  isFocusedGroup: boolean
  /** A composer is mounted and enabled — false while a prompt/question card owns the region. */
  composerReady: boolean
  /** Override the frame scheduler (tests). */
  scheduleFrame?: (callback: () => void) => void
}

/**
 * Focus the composer whenever this pane reveals it, so a chat you just opened —
 * or switched back to — is ready to type into. Retained panes never unmount, so
 * the reveal edge, not mount, is the signal.
 */
export function useNativeChatComposerRevealFocus({
  tabId,
  rootRef,
  composerRef,
  isVisible,
  isFocusedGroup,
  composerReady,
  scheduleFrame = scheduleNextFrame
}: NativeChatComposerRevealFocusArgs): void {
  const revealed = isVisible && isFocusedGroup
  const claimedRef = useRef(false)
  // An explicit tab activation takes focus from inside the pane too, short of a text field.
  const explicitRef = useRef(false)
  const [reclaimCount, setReclaimCount] = useState(0)

  useEffect(() => {
    if (!revealed || !composerReady) {
      return
    }
    const reclaim = (): void => {
      claimedRef.current = false
      explicitRef.current = true
      setReclaimCount((count) => count + 1)
    }
    revealedComposerReclaims.set(tabId, reclaim)
    return () => {
      if (revealedComposerReclaims.get(tabId) === reclaim) {
        revealedComposerReclaims.delete(tabId)
      }
    }
  }, [composerReady, revealed, tabId])

  useEffect(() => {
    if (!revealed || !composerReady) {
      claimedRef.current = false
      explicitRef.current = false
      return
    }
    if (claimedRef.current) {
      return
    }
    let cancelled = false
    let userInteracted = false
    let attempts = 0
    const ownerDocument = rootRef.current?.ownerDocument
    const cancelForPointer = (): void => {
      userInteracted = true
    }
    const cancelForFocusNavigation = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        userInteracted = true
      }
    }
    const stopWatchingUserIntent = (): void => {
      ownerDocument?.removeEventListener('pointerdown', cancelForPointer, true)
      ownerDocument?.removeEventListener('keydown', cancelForFocusNavigation, true)
    }
    const finish = (): void => {
      claimedRef.current = true
      explicitRef.current = false
      stopWatchingUserIntent()
    }
    ownerDocument?.addEventListener('pointerdown', cancelForPointer, true)
    ownerDocument?.addEventListener('keydown', cancelForFocusNavigation, true)
    const claim = (): void => {
      if (cancelled) {
        return
      }
      if (userInteracted) {
        finish()
        return
      }
      const active = rootRef.current?.ownerDocument.activeElement ?? null
      // Focus already inside this pane is our own take landing or the user's click; either ends it.
      // A just-collapsed card is hidden and inert, so focus left in it is about to drop to body.
      if (
        !explicitRef.current &&
        rootRef.current?.contains(active) === true &&
        !active?.closest('[hidden], [inert]')
      ) {
        finish()
        return
      }
      // Why: a live text field is a user edit — a batch worktree-create keeps its next name
      // field open behind the pane we just revealed, and the find bar keeps its query.
      if (shouldPreserveEditableFocus(active)) {
        finish()
        return
      }
      composerRef.current?.focus()
      attempts += 1
      if (attempts < REVEAL_FOCUS_FRAMES) {
        scheduleFrame(claim)
        return
      }
      finish()
    }
    // Why: Radix restores the dialog trigger in a setTimeout(0) on close, which beats a
    // same-tick take; a frame lands after it.
    scheduleFrame(claim)
    return () => {
      cancelled = true
      stopWatchingUserIntent()
    }
  }, [composerReady, composerRef, reclaimCount, revealed, rootRef, scheduleFrame])
}
