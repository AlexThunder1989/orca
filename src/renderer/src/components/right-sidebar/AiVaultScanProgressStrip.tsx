import { useState } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useNow } from '@/hooks/use-now'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type {
  AiVaultScanAgentProgress,
  AiVaultScanProgress
} from '../../../../shared/ai-vault-scan-progress'
import { agentLabel } from './ai-vault-session-filters'
import { formatTimeAgo } from './ai-vault-session-time'

// Why: interpolated so locales place the emphasized count; U+0000 never appears in copy.
const EMPHASIS_TOKEN = '\u0000'

function formatCount(value: number): string {
  return value.toLocaleString(getIntlLocale())
}

function fileCountLabel(count: number): string {
  const value0 = formatCount(count)
  return count === 1
    ? translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.fileCount_one',
        '{{value0}} file',
        { value0 }
      )
    : translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.fileCount_other',
        '{{value0}} files',
        { value0 }
      )
}

function databaseCountLabel(count: number): string {
  const value0 = formatCount(count)
  return count === 1
    ? translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.databaseCount_one',
        '{{value0}} database',
        { value0 }
      )
    : translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.databaseCount_other',
        '{{value0}} databases',
        { value0 }
      )
}

function stripSentence(progress: AiVaultScanProgress): string {
  const value0 = EMPHASIS_TOKEN
  switch (progress.stage) {
    case 'finding':
      return translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.scanning',
        'Scanning {{value0}}',
        { value0 }
      )
    case 'reading':
      return translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.reading',
        'Reading {{value0}} files',
        { value0 }
      )
    case 'finished':
      return translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.scanned',
        'Scanned {{value0}}',
        { value0 }
      )
  }
}

function foundCount(agent: AiVaultScanAgentProgress): number {
  return agent.files + agent.databases
}

function StripText({ progress }: { progress: AiVaultScanProgress }): React.JSX.Element {
  const emphasis =
    progress.stage === 'reading'
      ? `${formatCount(progress.read.done)} / ${formatCount(progress.read.total)}`
      : fileCountLabel(progress.agents.reduce((sum, agent) => sum + foundCount(agent), 0))
  const [before, after] = stripSentence(progress).split(EMPHASIS_TOKEN)
  return (
    <span className="min-w-0 truncate">
      {before}
      <span className="font-medium text-foreground">{emphasis}</span>
      {after}
    </span>
  )
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// The strip stays muted; status colour lives only in the per-agent rows.
function StripMark({ progress }: { progress: AiVaultScanProgress }): React.JSX.Element {
  if (progress.settledAt === null) {
    return <LoaderCircle className="size-3 shrink-0 animate-spin" />
  }
  return <Check className="size-3 shrink-0" />
}

function agentDetail(agent: AiVaultScanAgentProgress): string {
  if (agent.databases > 0) {
    const databases = databaseCountLabel(agent.databases)
    return agent.files > 0 ? `${fileCountLabel(agent.files)} · ${databases}` : databases
  }
  return fileCountLabel(agent.files)
}

function AgentRow({ agent }: { agent: AiVaultScanAgentProgress }): React.JSX.Element {
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-xs">
      {!agent.walking ? (
        <Check className="size-3.5 shrink-0 text-status-success" />
      ) : (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <AgentIcon agent={agent.agent} size={14} />
      <span className="min-w-0 truncate text-foreground">{agentLabel(agent.agent)}</span>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {agentDetail(agent)}
      </span>
    </div>
  )
}

/** One line under the search box naming what this computer's scan is doing; opens to one row per agent. */
export function AiVaultScanProgressStrip({
  progress
}: {
  progress: AiVaultScanProgress
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const now = useNow(progress.settledAt === null ? 1_000 : 30_000)
  return (
    <div className={cn('shrink-0 border-b border-sidebar-border', open && 'bg-sidebar-accent/35')}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex h-8 w-full cursor-pointer items-center gap-1.5 pl-3 pr-2 text-left text-[11px] text-muted-foreground tabular-nums outline-none hover:bg-sidebar-accent/50 focus-visible:ring-[2px] focus-visible:ring-sidebar-ring/30"
          >
            <StripMark progress={progress} />
            <StripText progress={progress} />
            <span className="ml-auto shrink-0">
              {progress.settledAt === null
                ? formatElapsed(now - progress.startedAt)
                : formatTimeAgo(progress.settledAt)}
            </span>
            <ChevronDown
              className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="py-1">
            {progress.agents.map((agent) => (
              <AgentRow key={agent.agent} agent={agent} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
