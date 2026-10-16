import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ OS: 'ios' }))
const pageScroller = vi.hoisted(() => ({ scrollHeight: 0 }))

vi.mock('react-native', async () => {
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
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native-gesture-handler', () => {
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
})

vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))

vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

// Stand-in composer: exposes the view's `handleSend` through a pressable, which is
// the only composer behaviour these banner tests exercise.
vi.mock('./MobileNativeChatComposer', async () => {
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
})

export type Overrides = {
  messages?: Parameters<typeof MobileNativeChatView>[0]['messages']
  folded?: Parameters<typeof MobileNativeChatView>[0]['folded']
  streaming?: string | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  inputLockReason?: 'disconnected' | 'waiting' | null
  onSend?: (text: string) => Promise<boolean>
  pending?: Parameters<typeof MobileNativeChatView>[0]['pending']
  structuredActivityUi?: boolean
  turnIndicator?: Parameters<typeof MobileNativeChatView>[0]['turnIndicator']
  agentWorking?: boolean
  canStop?: boolean
  ask?: Parameters<typeof MobileNativeChatView>[0]['ask']
  question?: Parameters<typeof MobileNativeChatView>[0]['question']
  permission?: Parameters<typeof MobileNativeChatView>[0]['permission']
  sendSurfaceId?: string
  keyboardInset?: number
  hasMore?: boolean
  onLoadEarlier?: () => void
  status?: Parameters<typeof MobileNativeChatView>[0]['status']
  error?: string
  readFailedFinally?: boolean
  actionablePromptIds?: readonly string[]
}

export function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, {
    messages: [],
    folded: [],
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    ...overrides
  })
}

let renderer: ReactTestRenderer | null = null

// Stubs the frame clock and tears down the mounted view; call once at the top of a test file.
export function installChatViewHooks(): void {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle)
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
    pageScroller.scrollHeight = 0
    vi.unstubAllGlobals()
  })
}

export function root(): ReactTestInstance {
  return renderer!.root
}

// Mocked react-native components are string tags that ReactTestInstance's ElementType omits.
export function hostType(node: ReactTestInstance): unknown {
  return node.type
}

export async function render(overrides: Overrides = {}): Promise<void> {
  await act(async () => {
    renderer = create(chatViewElement(overrides))
  })
}

export async function update(overrides: Overrides = {}): Promise<void> {
  await act(async () => {
    renderer?.update(chatViewElement(overrides))
  })
}

// Ids of the rows the list is currently rendering.
export function listIds(): string[] {
  return (list().props.data as { id: string }[]).map((row) => row.id)
}

export function list(): ReactTestInstance {
  return renderer!.root.find((node) => hostType(node) === 'FlatList')
}

export function renderedRow(id: string): ReactElement<Record<string, unknown>> {
  const listNode = list()
  const data = listNode.props.data as NativeChatMessage[]
  const index = data.findIndex((row) => row.id === id)
  return listNode.props.renderItem({ item: data[index], index })
}

export function banners(): ReactTestInstance[] {
  return renderer!.root.findAll((node) => node.props.accessibilityRole === 'alert')
}

export function composer(): ReactTestInstance {
  return renderer!.root.find((node) => hostType(node) === 'Composer')
}

export function bannerText(): string {
  const [alert, ...rest] = banners()
  expect(rest).toHaveLength(0)
  return alert
    .findAll((node) => hostType(node) === 'Text')
    .map((node) => node.props.children)
    .join('')
}

export async function pressSend(): Promise<void> {
  const composer = renderer!.root.find((node) => hostType(node) === 'Composer')
  await act(async () => {
    await composer.props.onPress()
  })
}

export async function scrollAwayFromTail(): Promise<void> {
  await act(async () => {
    list().props.onScrollBeginDrag?.({})
    list().props.onScroll({
      nativeEvent: {
        contentOffset: { y: 200 },
        contentSize: { height: 1_200 },
        layoutMeasurement: { height: 500 }
      }
    })
  })
}

// Vitest rejects exporting vi.hoisted bindings directly, so they are exported by name here.
export { scrollToEnd, scrollToOffset, platform, pageScroller }
