import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import { notificationPaneTab } from './notification-pane-tab'
import { useNotificationPaneNavigation } from './use-notification-pane-navigation'
import type { MobileSessionTab } from './mobile-session-route-types'
const route = vi.hoisted(() => ({ paneKey: '', setParams: vi.fn() }))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ paneKey: route.paneKey }),
  useRouter: () => ({ setParams: route.setParams })
}))
const leaf = '11111111-1111-4111-8111-111111111111'
const tabs: MobileSessionTab[] = [
  {
    type: 'terminal',
    id: 'first',
    parentTabId: 'tab-a',
    leafId: leaf,
    title: 'first',
    terminal: 'pty-a',
    isActive: true
  },
  {
    type: 'terminal',
    id: 'second',
    parentTabId: 'tab-b',
    leafId: leaf,
    title: 'agent',
    terminal: 'pty-b',
    isActive: false
  }
]
function Probe(props: Parameters<typeof useNotificationPaneNavigation>[0]) {
  useNotificationPaneNavigation(props)
  return null
}
it('selects the originating split pane, not the first tab; closed and invalid panes fall back', () => {
  expect(notificationPaneTab(tabs, `tab-b:${leaf}`)).toBe(tabs[1])
  expect(notificationPaneTab(tabs, `closed:${leaf}`)).toBeUndefined()
  expect(notificationPaneTab(tabs, 'invalid')).toBeUndefined()
})
it('waits for tabs, switches through the existing action, and consumes the navigation request', async () => {
  route.paneKey = `tab-b:${leaf}`
  const switchSessionTab = vi.fn()
  const props = { sessionTabs: tabs, terminalsLoaded: true, switchSessionTab }
  let renderer: ReturnType<typeof create>
  await act(async () => {
    renderer = create(createElement(Probe, { ...props, sessionTabs: [], terminalsLoaded: false }))
  })
  expect(switchSessionTab).not.toHaveBeenCalled()
  await act(async () => {
    renderer.update(createElement(Probe, props))
  })
  expect(switchSessionTab).toHaveBeenCalledExactlyOnceWith(tabs[1])
  expect(route.setParams).toHaveBeenCalledWith({ paneKey: '' })
  route.paneKey = ''
  await act(async () => {
    renderer.update(createElement(Probe, props))
  })
  expect(switchSessionTab).toHaveBeenCalledOnce()
  await act(async () => renderer.unmount())
})
it('targets published native parents by session and consumes absent targets without switching', async () => {
  const nativeTabs = ['restored', 'reserved', 'headless'].map((sessionId) => ({
    type: 'agent-session' as const,
    id: sessionId === 'headless' ? `agent-session:${sessionId}` : `${sessionId}-tab`,
    sessionId,
    agent: 'codex' as const,
    title: 'Review',
    isActive: false
  }))
  const paneKey = (sessionId: string) =>
    structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
  const switchSessionTab = vi.fn()
  const props = { sessionTabs: [...tabs], terminalsLoaded: true, switchSessionTab }
  route.setParams.mockClear()
  route.paneKey = paneKey('reserved')
  let renderer: ReturnType<typeof create>
  await act(async () => {
    renderer = create(createElement(Probe, props))
  })
  expect(switchSessionTab).not.toHaveBeenCalled()
  expect(route.setParams).toHaveBeenCalledExactlyOnceWith({ paneKey: '' })
  route.paneKey = ''
  props.sessionTabs = [...tabs, ...nativeTabs]
  await act(async () => renderer.update(createElement(Probe, props)))
  expect(switchSessionTab).not.toHaveBeenCalled()
  for (const tab of nativeTabs) {
    route.paneKey = paneKey(tab.sessionId)
    await act(async () => renderer.update(createElement(Probe, props)))
    expect(switchSessionTab).toHaveBeenLastCalledWith(tab)
  }
  route.paneKey = paneKey('absent')
  await act(async () => renderer.update(createElement(Probe, props)))
  expect(switchSessionTab).toHaveBeenLastCalledWith(nativeTabs[2])
  expect(switchSessionTab).toHaveBeenCalledTimes(3)
  expect(route.setParams).toHaveBeenCalledTimes(5)
  await act(async () => renderer.unmount())
})
