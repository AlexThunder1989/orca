import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  getOrcaProfileBrowserDefaultPartition,
  getOrcaProfileBrowserSessionPartition
} from '../../../shared/orca-profiles'
import { isOrcaProfileBrowserDefaultPartition } from './orcad-source-left-behind-session-rows'

describe('isOrcaProfileBrowserDefaultPartition', () => {
  it('recognizes every Orca profile default partition', () => {
    for (const profileId of [DEFAULT_LOCAL_ORCA_PROFILE_ID, 'work-profile']) {
      expect(
        isOrcaProfileBrowserDefaultPartition(getOrcaProfileBrowserDefaultPartition(profileId))
      ).toBe(true)
    }
  })

  it('rejects session-profile partitions, even one named like a default', () => {
    for (const profileId of [DEFAULT_LOCAL_ORCA_PROFILE_ID, 'work-profile']) {
      for (const sessionId of ['isolated-1', 'x-browser-default']) {
        expect(
          isOrcaProfileBrowserDefaultPartition(
            getOrcaProfileBrowserSessionPartition(profileId, sessionId)
          )
        ).toBe(false)
      }
    }
  })
})
