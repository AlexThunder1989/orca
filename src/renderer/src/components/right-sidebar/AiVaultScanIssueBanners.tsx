import type React from 'react'
import type { AiVaultListResult, AiVaultScanIssue } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  aiVaultScanNoticeIssues,
  blockingAiVaultScanIssue,
  skippedAiVaultTranscriptCount,
  skippedAiVaultTranscriptReasons
} from './ai-vault-scan-issue-state'
import { translate } from '@/i18n/i18n'

// Messages are scanner-authored (host name, remote path, cap), so they render raw
// rather than through a catalog key.
export function AiVaultScanIssueBanners({
  scanResult,
  localScanStopShown = false
}: {
  scanResult: AiVaultListResult | null
  /** The progress strip already says this computer's scan stopped; say it in one place. */
  localScanStopShown?: boolean
}): React.JSX.Element {
  const shown = (issue: AiVaultScanIssue | null): issue is AiVaultScanIssue =>
    issue !== null &&
    !(
      localScanStopShown &&
      issue.kind === 'host' &&
      issue.executionHostId === LOCAL_EXECUTION_HOST_ID
    )
  const blocking = blockingAiVaultScanIssue(scanResult)
  const skippedTranscriptCount = skippedAiVaultTranscriptCount(scanResult)

  return (
    <>
      {shown(blocking) ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {blocking.message}
        </div>
      ) : null}
      {aiVaultScanNoticeIssues(scanResult)
        .filter(shown)
        .map((issue) => (
          <div
            // Message is part of the key: one host can report several distinct
            // messages for the same path, and a colliding key drops those rows.
            key={`${issue.executionHostId ?? 'local'}:${issue.kind}:${issue.agent}:${issue.path}:${issue.message}`}
            className={`border-b border-sidebar-border px-3 py-1.5 text-[11px] ${
              issue.kind === 'host' ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {issue.message}
          </div>
        ))}
      {skippedTranscriptCount > 0 ? (
        <div className="border-b border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultPanel.transcriptsSkipped',
            '{{count}} transcript skipped',
            { count: skippedTranscriptCount }
          )}
        </div>
      ) : null}
      {skippedAiVaultTranscriptReasons(scanResult).map((reason) => (
        <div
          key={reason}
          className="border-b border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          {reason}
        </div>
      ))}
    </>
  )
}
