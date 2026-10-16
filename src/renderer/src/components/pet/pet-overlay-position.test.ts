import { describe, expect, it, afterEach, vi } from 'vitest'
import { clampPositionToViewport } from './PetOverlay'

describe('clampPositionToViewport', () => {
  it('keeps the overlay inside the viewport bounds', () => {
    expect(
      clampPositionToViewport({ x: 900, y: -20 }, 180, {
        width: 800,
        height: 600
      })
    ).toEqual({ x: 620, y: 0 })
  })

  it('pins to the origin when the overlay is larger than the viewport', () => {
    expect(
      clampPositionToViewport({ x: 80, y: 40 }, 500, {
        width: 320,
        height: 240
      })
    ).toEqual({ x: 0, y: 0 })
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
