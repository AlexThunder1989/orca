import { z } from 'zod'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import {
  parseOrcadMigrationCatalogAbortResult,
  parseOrcadMigrationCatalogState
} from '../../shared/orcad-migration-catalog-state'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import {
  parseOrcadMigrationSnapshotChunkResult,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration-scrollback'
import {
  findUnsupportedMigrationBlobKind,
  orcadMigrationBlobKindUnsupportedBlocker,
  parseOrcadMigrationBlobChunkResult,
  type OrcadMigrationBlobChunkRequest,
  type OrcadMigrationBlobChunkResult,
  type OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration-blob-transfer'
import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { requiredOrcadMigrationSourceCapability } from '../../shared/orcad-migration-source-kind'

type OrcadCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

/**
 * A destination that does not offer catalog migration: an older orcad without the capability or
 * the method. This is a definite refusal; any other failure, including a lost answer, is not, and
 * the caller re-reads the catalog state before deciding anything.
 */
export const ORCAD_MIGRATION_DESTINATION_UNSUPPORTED = 'orcad_migration_destination_unsupported'
/** An older destination would strip automations' extra agent arguments, so the move is refused. */
export const ORCAD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED =
  'orcad_migration_destination_extra_agent_args_unsupported:Update Orca on this host to use extra arguments.'
/** The destination does not parse this manifest's source kind; nothing was sent, so nothing staged. */
export const ORCAD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED =
  'orcad_migration_destination_source_kind_unsupported:Update Orca on this host to move this project to it.'

type CatalogRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  expectedRuntimeId?: string
}

const METHOD_BY_OPERATION: Record<OrcadCatalogMigrationOperation, string> = {
  abort: 'orcad.migration.abortCatalog',
  commit: 'orcad.migration.commitCatalog',
  stage: 'orcad.migration.stageCatalog',
  state: 'orcad.migration.catalogState'
}

export function stageRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'stage', manifest, options)
}

/** `expectedBlobs` names what was moved so the destination refuses a commit missing any. */
export async function commitRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions & {
    expectedBlobs?: readonly OrcadMigrationBlobDescriptor[]
  } = {}
): Promise<OrcadMigrationCatalogState> {
  const result = await request(pairingCode, 'commit', manifest, options, options.expectedBlobs)
  return parseOrcadMigrationCatalogState(result, manifest)
}

export function readRemoteOrcadMigrationCatalogState(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'state', manifest, options)
}

export async function abortRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogAbortResult> {
  const result = await request(pairingCode, 'abort', manifest, options)
  const parsed = parseOrcadMigrationCatalogAbortResult(result, manifest)
  // Older hosts flush real aborts, but their already-absent responses prove no persistence.
  if (parsed.state === 'absent' && !parsed.aborted && parsed.durableAbsent !== true) {
    throw new Error('orcad_migration_abort_durability_unverifiable:destination_update_required')
  }
  return parsed
}

export async function stageRemoteOrcadMigrationSnapshotChunk(
  pairingCode: string,
  request: OrcadMigrationSnapshotChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'orcad.migration.stageSnapshotChunk',
    request,
    options
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_snapshot_failed:${response.error.message}`)
  }
  return parseOrcadMigrationSnapshotChunkResult(response.result, request)
}

export async function stageRemoteOrcadMigrationBlobChunk(
  pairingCode: string,
  request: OrcadMigrationBlobChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationBlobChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'orcad.migration.stageBlobChunk',
    request,
    options,
    false,
    null,
    // Per request: a downgraded destination must refuse the kind, never stage what it can't install.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind([request.blob], capabilities)
      if (unsupported) {
        throw new Error(orcadMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_blob_failed:${response.error.message}`)
  }
  return parseOrcadMigrationBlobChunkResult(response.result, request)
}

const ServerRepositoriesSchema = z.object({
  repos: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }))
})

/** The projects the destination already holds, as ids and host paths, through the same preflight. */
export async function listRemoteOrcadRepositories(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<{ id: string; path: string }[]> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(pairing, 'repo.list', undefined, options)
  if (!response.ok) {
    throw new Error(`orcad_migration_repositories_failed:${response.error.message}`)
  }
  return ServerRepositoriesSchema.parse(response.result).repos.map(({ id, path }) => ({ id, path }))
}

async function requestCatalogState(
  pairingCode: string,
  operation: Exclude<OrcadCatalogMigrationOperation, 'abort'>,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions
): Promise<OrcadMigrationCatalogState> {
  const result = await request(pairingCode, operation, manifest, options)
  return parseOrcadMigrationCatalogState(result, manifest)
}

async function request(
  pairingCode: string,
  operation: OrcadCatalogMigrationOperation,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions,
  expectedBlobs: readonly OrcadMigrationBlobDescriptor[] = []
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const carriesExtraAgentArgs =
    (operation === 'stage' || operation === 'commit') &&
    (manifest.payload.dormantState?.automations ?? []).some((automation) =>
      hasExtraAgentArgs(automation.extraAgentArgs)
    )
  const response = await sendSupportedMigrationRequest(
    pairing,
    METHOD_BY_OPERATION[operation],
    // Only with blobs: SSH and blob-free moves keep sending exactly `{ manifest }`.
    expectedBlobs.length > 0 ? { manifest, expectedBlobs } : { manifest },
    options,
    carriesExtraAgentArgs,
    // Every operation: an older destination would parse a non-SSH source as malformed or as SSH.
    requiredOrcadMigrationSourceCapability(manifest.source),
    // A destination without the blob channel would strip the field and commit unchecked.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind(expectedBlobs, capabilities)
      if (unsupported) {
        throw new Error(orcadMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_${operation}_failed:${response.error.message}`)
  }
  return response.result
}

async function sendSupportedMigrationRequest(
  pairing: NonNullable<ReturnType<typeof parsePairingCode>>,
  method: string,
  params: unknown,
  options: CatalogRequestOptions,
  requiresExtraAgentArgs = false,
  requiredSourceCapability: string | null = null,
  assertCapabilities: (capabilities: readonly string[]) => void = () => {}
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    pairedRuntimeConnectionFromOffer(pairing),
    method,
    params,
    options.timeoutMs ?? 15_000,
    (status) => {
      if (!status.ok) {
        throw new Error(`orcad_migration_status_failed:${status.error.message}`)
      }
      if (
        options.expectedRuntimeId !== undefined &&
        status._meta?.runtimeId !== options.expectedRuntimeId
      ) {
        throw new Error('orcad_migration_destination_runtime_mismatch')
      }
      if (!status.result.capabilities?.includes(ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY)) {
        throw new Error(ORCAD_MIGRATION_DESTINATION_UNSUPPORTED)
      }
      if (
        requiresExtraAgentArgs &&
        !status.result.capabilities?.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
      ) {
        throw new Error(ORCAD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED)
      }
      if (
        requiredSourceCapability !== null &&
        !status.result.capabilities?.includes(requiredSourceCapability)
      ) {
        throw new Error(ORCAD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED)
      }
      assertCapabilities(status.result.capabilities ?? [])
    },
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    options.signal
  )
  if (!response.ok && response.error.code === 'method_not_found') {
    throw new Error(ORCAD_MIGRATION_DESTINATION_UNSUPPORTED)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('orcad_migration_destination_runtime_mismatch')
  }
  return response
}
