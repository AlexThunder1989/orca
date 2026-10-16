import { vi } from 'vitest'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ OS: 'ios' }))
const pageScroller = vi.hoisted(() => ({ scrollHeight: 0 }))

export async function reactNativeStub() {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      const handle = { scrollToEnd, scrollToOffset, getScrollableNode: () => pageScroller }
      React.useImperativeHandle(ref, () => handle, [])
      return React.createElement('FlatList', props)
    }),
    Platform: platform,
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
}

export function gestureHandlerStub() {
  const chain = {
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain
  }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
}

export async function composerStub() {
  const React = await import('react')
  return {
    MobileNativeChatComposer: (props: {
      onSend: (text: string) => Promise<boolean>
      disabled?: boolean
      placeholder?: string
    }) =>
      React.createElement('Composer', {
        ...props,
        accessibilityLabel: 'Send message',
        onPress: () => props.onSend('hi')
      })
  }
}

export { scrollToEnd, scrollToOffset, platform, pageScroller }
