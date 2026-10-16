import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../shared/constants'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { publishWorkspaceViewChanges } from './runtime-workspace-view-change-events'

function fakeStore() {
  let ui: PersistedUIState = getDefaultUIState()
  const listeners: ((ui: PersistedUIState) => void)[] = []
  return {
    getUI: () => ui,
    onUIChanged: (listener: (ui: PersistedUIState) => void) => {
      listeners.push(listener)
      return () => {}
    },
    update(updates: Partial<PersistedUIState>) {
      ui = { ...ui, ...updates }
      for (const listener of listeners) {
        listener(ui)
      }
    }
  }
}

describe('publishWorkspaceViewChanges', () => {
  it('announces a Workspace options change once, and ignores unrelated UI edits', () => {
    const store = fakeStore()
    const emit = vi.fn()
    publishWorkspaceViewChanges(store, emit)

    store.update({ sidebarWidth: 300 })
    expect(emit).not.toHaveBeenCalled()

    store.update({ hideWorkspacesFromOtherDevices: true })
    store.update({ hideWorkspacesFromOtherDevices: true })
    store.update({ filterRepoIds: ['repo-1'] })
    expect(emit.mock.calls).toEqual([
      [{ type: 'workspaceViewChanged' }],
      [{ type: 'workspaceViewChanged' }]
    ])
  })
})
