import { beforeEach, expect, it, vi } from 'vitest'
import { preparePendingSplitClose } from './pending-split-close-test-fixture'
import type { sendPaneCommandToLayoutOwner } from './terminal-pane-layout-owner-commands'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: false,
  commitTerminalSurfaceClose: vi.fn(),
  sendPaneCommandToLayoutOwner: vi.fn<typeof sendPaneCommandToLayoutOwner>()
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('./terminal-pane-layout-owner-commands', () => ({
  sendPaneCommandToLayoutOwner: mocks.sendPaneCommandToLayoutOwner
}))
vi.mock('@/store/terminals/terminal-surface-close-intent', () => ({
  commitTerminalSurfaceClose: mocks.commitTerminalSurfaceClose
}))

const LEAF = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  mocks.layoutOwnerIsMain = false
  mocks.commitTerminalSurfaceClose.mockReset()
  mocks.sendPaneCommandToLayoutOwner.mockReset()
  mocks.sendPaneCommandToLayoutOwner.mockReturnValue(true)
})

it('a window-owned build closes the pane at once and reports it to main', async () => {
  const p = await preparePendingSplitClose()

  p.actions.executeClosePane(1)

  expect(mocks.sendPaneCommandToLayoutOwner).not.toHaveBeenCalled()
  expect(mocks.commitTerminalSurfaceClose).toHaveBeenCalledWith('workspace', {
    kind: 'pane',
    tabId: 'tab-parent',
    leafId: LEAF
  })
  expect(p.transports.has(1)).toBe(false)
})

it('a layout-owner build removes the pane only once main has closed it', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()

  p.actions.executeClosePane(1)

  expect(mocks.sendPaneCommandToLayoutOwner).toHaveBeenCalledWith(
    'workspace',
    { type: 'closePane', tabId: 'tab-parent', leafId: LEAF },
    { apply: expect.any(Function), asToday: expect.any(Function), refused: expect.any(Function) }
  )
  expect(p.transports.has(1)).toBe(true)

  mocks.sendPaneCommandToLayoutOwner.mock.calls[0]?.[2].apply({})

  expect(p.transports.has(1)).toBe(false)
  expect(mocks.commitTerminalSurfaceClose).not.toHaveBeenCalled()
})

it('a layout-owner build closes as today when a paired server holds the tab', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()

  p.actions.executeClosePane(1)
  mocks.sendPaneCommandToLayoutOwner.mock.calls[0]?.[2].asToday()

  expect(mocks.commitTerminalSurfaceClose).toHaveBeenCalledOnce()
  expect(p.transports.has(1)).toBe(false)
})

it('a layout-owner build closes the tab when main refuses a second close as the last pane', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)
  p.actions.executeClosePane(2)
  const [first, second] = mocks.sendPaneCommandToLayoutOwner.mock.calls.map(([, , on]) => on)

  first?.apply({})
  second?.refused?.('last_pane')

  expect(p.controller.onCloseTab).toHaveBeenCalledOnce()
})

it('a layout-owner build closes the tab when main’s answer finds the pane alone', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)
  p.actions.executeClosePane(2)
  const [first, second] = mocks.sendPaneCommandToLayoutOwner.mock.calls.map(([, , on]) => on)

  first?.apply({})
  second?.apply({})

  expect(p.controller.onCloseTab).toHaveBeenCalledOnce()
  expect(p.controller.managerRef.current?.getPanes()).toHaveLength(1)
})

it('a layout-owner build leaves an unmounted tab alone when main refuses its last pane', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)
  p.controller.managerRef.current = null

  mocks.sendPaneCommandToLayoutOwner.mock.calls[0]?.[2].refused?.('last_pane')

  expect(p.controller.onCloseTab).not.toHaveBeenCalled()
})
