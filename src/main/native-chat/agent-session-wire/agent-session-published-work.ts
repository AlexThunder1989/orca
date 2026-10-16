// What a page or frame publishes of the host's current-work projection
// (`structuredAgentSessionCurrentWork`), laid over the page the journal reads.

import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { snapshotLatestTurn } from './agent-session-history-page'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

/** The newest turn record as clients are told it, and the prompts still waiting on the person.
 *  Absent, a page states the raw record and no prompt ids, as an older host did. */
export type AgentSessionPublishedWork = Pick<
  StructuredAgentSessionCurrentWork,
  'publishedLatestTurn' | 'actionablePromptIds' | 'working'
>

type PublishedWorkFields = Pick<
  AgentSessionHistoryPage,
  'latestTurn' | 'actionablePromptIds' | 'working'
>

function publishedWorkFields(
  latestTurn: AgentSessionHistoryPage['latestTurn'],
  work: AgentSessionPublishedWork
): PublishedWorkFields {
  return {
    latestTurn: work.publishedLatestTurn(latestTurn ?? null),
    actionablePromptIds: work.actionablePromptIds(),
    working: work.working()
  }
}

/** The current-work fields a page carries, for a frame that carries no page. */
export function agentSessionPublishedWorkFields(
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork
): PublishedWorkFields {
  return publishedWorkFields(snapshotLatestTurn(journal.snapshot()), work)
}

/** A page as the host publishes it: its turn record scoped by the projection, an ended
 *  generation's turn running nowhere. */
export function withPublishedWork(
  page: AgentSessionHistoryPage,
  work: AgentSessionPublishedWork | undefined
): AgentSessionHistoryPage {
  return work ? { ...page, ...publishedWorkFields(page.latestTurn, work) } : page
}

export function withPublishedWorkResult(
  result: AgentSessionHistoryResult,
  work: AgentSessionPublishedWork | undefined
): AgentSessionHistoryResult {
  return work ? { ...result, page: withPublishedWork(result.page, work) } : result
}
