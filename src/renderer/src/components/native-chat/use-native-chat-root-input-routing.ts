import {
  useCallback,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import { shouldFocusNativeChatPaneFromPointerTarget } from './native-chat-typing-redirect'
import {
  useNativeChatComposerRevealFocus,
  type NativeChatComposerRevealFocusArgs
} from './use-native-chat-composer-reveal-focus'

// Revealed chat roots in this window: a floating panel can reveal one beside the workspace's.
const revealedChatRoots = new Set<HTMLElement>()

/** Brings focus to the chat's input when it is revealed, and sends keys typed in the chat, or
 *  with nothing focused around it, to that input. */
export function useNativeChatRootInputRouting(
  args: Omit<NativeChatComposerRevealFocusArgs, 'scheduleFrame'> & {
    questionAnswerInputRef: RefObject<HTMLInputElement | null>
  }
): {
  onPointerDownCapture: (event: ReactPointerEvent) => void
  onKeyDownCapture: (event: ReactKeyboardEvent) => void
} {
  const { rootRef, composerRef, questionAnswerInputRef } = args
  useNativeChatComposerRevealFocus(args)
  // The one chat visible in the focused group takes keys typed with nothing focused.
  const revealed = args.isVisible && args.isFocusedGroup
  useEffect(() => {
    const root = rootRef.current
    if (!revealed || !root) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Focus on <body> or the pane's own cover (a click on blank chrome) has no key owner;
      // with two chats revealed it has no clear target either.
      if (
        !(event.target instanceof Node) ||
        event.target === root ||
        !event.target.contains(root) ||
        revealedChatRoots.size !== 1 ||
        hasVisibleOverlay({ ignoreDismissed: true })
      ) {
        return
      }
      routeNativeChatRootKeyToInput(event, composerRef.current, questionAnswerInputRef.current)
    }
    revealedChatRoots.add(root)
    root.ownerDocument.addEventListener('keydown', onKeyDown)
    return () => {
      revealedChatRoots.delete(root)
      root.ownerDocument.removeEventListener('keydown', onKeyDown)
    }
  }, [composerRef, questionAnswerInputRef, revealed, rootRef])

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button === 0 && shouldFocusNativeChatPaneFromPointerTarget(event.target)) {
        rootRef.current?.focus({ preventScroll: true })
      }
    },
    [rootRef]
  )
  const onKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent) => {
      // Menus and dialogs the chat portals out still bubble through its React tree.
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        routeNativeChatRootKeyToInput(event, composerRef.current, questionAnswerInputRef.current)
      }
    },
    [composerRef, questionAnswerInputRef, rootRef]
  )
  return { onPointerDownCapture, onKeyDownCapture }
}
