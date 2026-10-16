/**
 * A move onto a server another desktop on the same login already uses. A project this desktop moves
 * that the server already holds at the same host path is the same checkout, so the move links it
 * to the server's project instead of importing a second row the server refuses. The server's row
 * and state stay as they are; this desktop's own rows stay in its retained source, as moved ones do.
 *
 * Linking rewrites the journal under the same migration id, and only after the server proves it
 * holds nothing of the earlier manifest, so no row ever lands twice.
 */
import { getAutomationRunRepoId } from '../../shared/automation-run-identity'
import type { Automation } from '../../shared/automations-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import type { SshManagedServerLinkedProject } from '../../shared/ssh-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { Store } from '../persistence'
import {
  abortOrcadMigrationCutover,
  type OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import { writeOrcadMigrationSourceCutover } from './orcad-migration-cutover-journal'
import { orcadSourceStoreWithout, type OrcadDeltaSourceStore } from './orcad-migration-delta-plan'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import type { OrcadMigrationSourceCutoverPort } from './orcad-migration-source'
import { sshRelayMigrationCutoverPort } from './orcad-migration-ssh-relay-source'
import { orcadCatalogFingerprint } from './orcad-retained-source'
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'

export type OrcadServerRepository = Pick<Repo, 'id' | 'path'>

/** Incoming projects the server holds at the same host path under another id. */
export function repositoriesHeldByServer(
  incoming: readonly OrcadServerRepository[],
  server: readonly OrcadServerRepository[]
): string[] {
  const serverIdsByPath = new Map<string, Set<string>>()
  for (const repo of server) {
    const key = normalizeRuntimePathForComparison(repo.path)
    serverIdsByPath.set(key, (serverIdsByPath.get(key) ?? new Set()).add(repo.id))
  }
  return incoming
    .filter((repo) => {
      const ids = serverIdsByPath.get(normalizeRuntimePathForComparison(repo.path))
      // The same id is the same row, which the import already accepts as it is.
      return ids !== undefined && !ids.has(repo.id)
    })
    .map((repo) => repo.id)
}

/** The source the cutover was cut from: the real store less any project it linked. */
export function linkedOrcadMigrationSource(
  store: Store,
  cutover: Pick<
    OrcadMigrationSourceCutover,
    'sshTargetId' | 'destinationEnvironmentId' | 'linkedRepositoryIds'
  >
): (() => OrcadDeltaSourceStore) | undefined {
  const linked = cutover.linkedRepositoryIds ?? []
  if (linked.length === 0) {
    return undefined
  }
  return () => {
    const target = store.getSshTarget(cutover.sshTargetId)
    if (!target) {
      throw new Error('orcad_migration_source_fence_lost')
    }
    return orcadSourceStoreWithout(
      store,
      target,
      {
        repositoryIds: new Set(linked),
        folderWorkspaceIds: new Set(),
        projectGroupIds: new Set()
      },
      cutover.destinationEnvironmentId
    )
  }
}

export function linkedOrcadMigrationCutoverPort(args: {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  cutover: OrcadMigrationSourceCutover
}): OrcadMigrationSourceCutoverPort {
  return sshRelayMigrationCutoverPort({
    userDataPath: args.userDataPath,
    store: args.store,
    claims: args.claims,
    freshSource: linkedOrcadMigrationSource(args.store, args.cutover)
  })
}

/**
 * A relay terminal the bridge still serves reattaches only into its own tab, which a linked
 * project never sends to the server: linking now would strand it out of sight, still running.
 */
function assertNoRelayTerminalsIn(
  store: Pick<Store, 'getSshRemotePtyLeases'>,
  cutover: OrcadMigrationSourceCutover,
  linked: readonly string[]
): void {
  const bridged = new Set(cutover.bridgedPtyIds ?? [])
  const owners = store
    .getSshRemotePtyLeases(cutover.sshTargetId)
    .filter((lease) => bridged.has(lease.ptyId) && lease.state !== 'terminated')
    .map((lease) => (lease.worktreeId ? splitWorktreeId(lease.worktreeId)?.repoId : undefined))
  if (owners.length === 0) {
    return
  }
  const { repositories, folderWorkspaces } = cutover.manifest.payload
  const linkedRepos = repositories.filter((repo) => linked.includes(repo.id))
  const blocked = linkedRepos.find((repo) => owners.includes(repo.id))
  if (blocked) {
    throw new Error(`orcad_migration_linked_project_terminals:${blocked.path}`)
  }
  const moving = new Set([...repositories, ...folderWorkspaces].map((row) => row.id))
  // A lease whose project can't be told, or isn't moving, may be one a link would strand.
  if (owners.some((owner) => owner === undefined || !moving.has(owner))) {
    throw new Error(
      `orcad_migration_linked_project_unowned_terminals:${linkedRepos.map((repo) => repo.path).join(', ')}`
    )
  }
}

/** What each linked project leaves behind on this desktop, so the connect can say so. */
export function linkedOrcadMigrationProjects(
  store: {
    getRepos(): OrcadServerRepository[]
    listAutomations(): Pick<Automation, 'projectId' | 'runContext'>[]
  },
  cutover: Pick<OrcadMigrationSourceCutover, 'linkedRepositoryIds'>
): SshManagedServerLinkedProject[] {
  const linked = new Set(cutover.linkedRepositoryIds ?? [])
  if (linked.size === 0) {
    return []
  }
  const automations = store.listAutomations()
  return store
    .getRepos()
    .filter((repo) => linked.has(repo.id))
    .map((repo) => ({
      path: repo.path,
      automations: automations.filter((entry) => getAutomationRunRepoId(entry) === repo.id).length
    }))
}

/** Returns the cutover to commit: the same one, or one re-journaled without the linked projects. */
export async function linkServerHeldRepositories(args: {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  cutover: OrcadMigrationSourceCutover
  destination: OrcadMigrationDestinationCatalog
  serverRepositories: () => Promise<OrcadServerRepository[]>
  now?: () => Date
}): Promise<OrcadMigrationSourceCutover> {
  const { cutover, userDataPath } = args
  if (cutover.phase !== 'source-fenced' && cutover.phase !== 'destination-staged') {
    return cutover
  }
  const linked = repositoriesHeldByServer(
    cutover.manifest.payload.repositories,
    await args.serverRepositories()
  )
  if (linked.length === 0) {
    return cutover
  }
  assertNoRelayTerminalsIn(args.store, cutover, linked)
  const source = linkedOrcadMigrationCutoverPort(args)
  // The relinked manifest is cut from the source as fenced, so it must still be that source.
  source.verifyFence(cutover)
  const linkedRepositoryIds = [...new Set([...(cutover.linkedRepositoryIds ?? []), ...linked])]
  const view = linkedOrcadMigrationSource(args.store, { ...cutover, linkedRepositoryIds })?.()
  const target = args.store.getSshTarget(cutover.sshTargetId)
  if (!view || !target) {
    throw new Error('orcad_migration_source_fence_lost')
  }
  const manifest = createOrcadMigrationManifest(view, target, {
    migrationId: cutover.migrationId,
    destinationEnvironmentId: cutover.destinationEnvironmentId,
    now: () => new Date(cutover.manifest.createdAt)
  })
  const relinked: OrcadMigrationSourceCutover = {
    ...cutover,
    phase: 'source-fenced',
    updatedAt: (args.now ?? (() => new Date()))().toISOString(),
    manifestSha256: manifest.manifestSha256,
    manifest,
    linkedRepositoryIds,
    // The retained rows still hold the linked projects, so the baseline is the whole fenced source.
    sourceBaselineFingerprint:
      cutover.sourceBaselineFingerprint ?? orcadCatalogFingerprint(cutover.manifest.payload)
  }
  const aborted = await abortOrcadMigrationCutover(
    { userDataPath, store: args.store, claims: args.claims, destination: args.destination, source },
    cutover.migrationId,
    // Why keep the fence: the move goes on to the same server, now without the linked projects.
    async () => writeOrcadMigrationSourceCutover(userDataPath, relinked)
  )
  if (aborted.outcome !== 'released') {
    throw new Error(aborted.code)
  }
  return relinked
}
