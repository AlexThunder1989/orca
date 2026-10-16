// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultScanProgress } from '../../../../shared/ai-vault-scan-progress'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { aiVaultLocalScanKey } from '../../../../shared/ai-vault-local-scan-key'
import { AiVaultScanProgressStrip } from './AiVaultScanProgressStrip'
import { resetAiVaultSessionResultCacheForTest } from './ai-vault-session-result-cache'
import { currentAiVaultScanIssueResult } from './ai-vault-scan-issue-state'
import {
  resetAiVaultScanProgressStoreForTests,
  useAiVaultScanProgress
} from './ai-vault-scan-progress-store'

afterEach(() => {
  cleanup()
  resetAiVaultScanProgressStoreForTests()
  resetAiVaultSessionResultCacheForTest()
  vi.unstubAllGlobals()
})

const FINISHED: AiVaultScanProgress = {
  scanId: 'scan-a',
  stage: 'finished',
  agents: [
    { agent: 'claude', files: 24_968, databases: 0, walking: false },
    { agent: 'codex', files: 77_483, databases: 0, walking: false },
    { agent: 'opencode', files: 0, databases: 1, walking: false }
  ],
  read: { done: 2_000, total: 2_000 },
  startedAt: 0,
  settledAt: 90_000
}

it('says the finished total in the strip and opens to one row per agent', async () => {
  render(<AiVaultScanProgressStrip progress={FINISHED} />)
  expect(screen.getByText('102,452 files').parentElement?.textContent).toBe(
    'Scanned 102,452 files'
  )
  expect(screen.queryByText('Codex')).toBeNull()

  await userEvent.setup().click(screen.getByRole('button'))
  expect(screen.getByText('77,483 files')).toBeTruthy()
  expect(screen.getByText('1 database')).toBeTruthy()
})

it('keeps a narrower cached panel off the broader key while a late matching panel loads it', async () => {
  const lowerDepth = { scopePaths: ['/project'], includeAntigravityIdeSessions: true, limit: 100 }
  const broader = aiVaultLocalScanKey({ ...lowerDepth, limit: 1000 })
  const narrower = aiVaultLocalScanKey(lowerDepth)
  expect(broader).not.toBe(narrower)
  const cachedProgress = FINISHED
  let push: (update: { scanKey: string; progress: AiVaultScanProgress | null }) => void = () =>
    undefined
  vi.stubGlobal('api', {
    aiVault: {
      getScanProgress: (scanKey: string) =>
        Promise.resolve(scanKey === broader ? cachedProgress : null),
      onScanProgress: (callback: typeof push) => {
        push = callback
        return () => undefined
      }
    }
  })
  const local = renderHook(() => useAiVaultScanProgress('local', broader, cachedProgress.scanId))
  const narrowerPanel = renderHook(() => useAiVaultScanProgress('local', narrower, undefined))
  const remote = renderHook(() =>
    useAiVaultScanProgress('runtime:server-1', broader, cachedProgress.scanId)
  )
  await waitFor(() => expect(local.result.current).toBe(cachedProgress))
  act(() => push({ scanKey: broader, progress: cachedProgress }))

  expect(local.result.current).toBe(cachedProgress)
  expect(narrowerPanel.result.current).toBeNull()
  act(() =>
    push({ scanKey: broader, progress: { ...cachedProgress, scanId: 'later', stage: 'finding' } })
  )
  expect(narrowerPanel.result.current).toBeNull()
  // A remote host has no progress stream yet; its panel keeps today's spinner and error line.
  expect(remote.result.current).toBeNull()
})

it('hides an old issue only while this panel is refreshing', () => {
  const oldIssue: AiVaultListResult = {
    sessions: [],
    issues: [],
    scannedAt: new Date(1_000).toISOString()
  }
  expect(currentAiVaultScanIssueResult(oldIssue, true)).toBeNull()
  expect(currentAiVaultScanIssueResult(oldIssue)).toBe(oldIssue)
})

it('shows a running scan at once but a finished one only with the list it produced', () => {
  let push: (update: { scanKey: string; progress: AiVaultScanProgress | null }) => void = () =>
    undefined
  vi.stubGlobal('api', {
    aiVault: {
      getScanProgress: () => Promise.resolve(null),
      onScanProgress: (callback: typeof push) => {
        push = callback
        return () => undefined
      }
    }
  })
  const applied = (scanId: string): AiVaultListResult => ({
    sessions: [],
    issues: [],
    scannedAt: new Date(1_000).toISOString(),
    scanId
  })
  function Panel({ scanKey, result }: { scanKey: string; result: AiVaultListResult | null }) {
    const progress = useAiVaultScanProgress('local', scanKey, result?.scanId)
    return progress ? <AiVaultScanProgressStrip progress={progress} /> : null
  }
  const a = render(<Panel scanKey="scope-a" result={applied('scan-a')} />)
  const b = render(<Panel scanKey="scope-b" result={null} />)
  const aView = within(a.container)
  const bView = within(b.container)

  act(() => push({ scanKey: 'scope-a', progress: FINISHED }))
  expect(aView.getByText('Scanned', { exact: false })).toBeTruthy()
  act(() => push({ scanKey: 'scope-b', progress: { ...FINISHED, scanId: 'scan-b', stage: 'finding', settledAt: null } }))
  expect(bView.getByText('Scanning', { exact: false })).toBeTruthy()
  expect(aView.getByText('Scanned', { exact: false })).toBeTruthy()

  const next = { ...FINISHED, scanId: 'scan-a-next' }
  act(() => push({ scanKey: 'scope-a', progress: { ...next, stage: 'reading', settledAt: null } }))
  expect(aView.getByText('Reading', { exact: false })).toBeTruthy()
  // Finished before its list is applied: the strip must not claim a total the list does not show yet.
  act(() => push({ scanKey: 'scope-a', progress: next }))
  expect(aView.queryByText('Scanned', { exact: false })).toBeNull()
  a.rerender(<Panel scanKey="scope-a" result={applied(next.scanId)} />)
  expect(aView.getByText('Scanned', { exact: false })).toBeTruthy()
})
