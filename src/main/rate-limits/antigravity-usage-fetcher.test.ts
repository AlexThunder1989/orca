import { describe, expect, it } from 'vitest'
import { mapQuotaSummary } from './antigravity-usage-fetcher'

// Captured from RetrieveUserQuotaSummary on a Google AI Pro account.
const RESPONSE = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 0.20240954,
            resetTime: '2026-09-10T18:26:27Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 0.7737272,
            resetTime: '2026-09-07T23:07:06Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-weekly',
            window: 'weekly',
            remainingFraction: 1,
            resetTime: '2026-09-14T22:50:12Z'
          },
          {
            bucketId: '3p-5h',
            window: '5h',
            remainingFraction: 1,
            resetTime: '2026-09-08T03:50:12Z'
          }
        ]
      }
    ]
  }
}

describe('mapQuotaSummary', () => {
  it('names a bucket per pool and window', () => {
    expect(mapQuotaSummary(RESPONSE).buckets).toEqual([
      {
        name: 'Gemini Weekly',
        usedPercent: 80,
        windowMinutes: 10080,
        resetsAt: Date.parse('2026-09-10T18:26:27Z'),
        resetDescription: null
      },
      {
        name: 'Gemini 5h',
        usedPercent: 23,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-09-07T23:07:06Z'),
        resetDescription: null
      },
      {
        name: 'Claude and GPT Weekly',
        usedPercent: 0,
        windowMinutes: 10080,
        resetsAt: Date.parse('2026-09-14T22:50:12Z'),
        resetDescription: null
      },
      {
        name: 'Claude and GPT 5h',
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-09-08T03:50:12Z'),
        resetDescription: null
      }
    ])
  })

  it('summarises each window with its most constrained pool', () => {
    const { session, weekly } = mapQuotaSummary(RESPONSE)
    expect(session?.usedPercent).toBe(23)
    expect(session?.windowMinutes).toBe(300)
    expect(weekly?.usedPercent).toBe(80)
    expect(weekly?.windowMinutes).toBe(10080)
  })

  it('skips buckets with an unknown window', () => {
    const { session, weekly, buckets } = mapQuotaSummary({
      response: {
        groups: [
          { displayName: 'Gemini Models', buckets: [{ window: 'daily', remainingFraction: 0.5 }] }
        ]
      }
    })
    expect(buckets).toEqual([])
    expect(session).toBeNull()
    expect(weekly).toBeNull()
  })
})
