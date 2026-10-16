import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration-manifest'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { planOrcadDeltaMove } from './orcad-migration-delta-plan'
import {
  linkedOrcadMigrationProjects,
  repositoriesHeldByServer
} from './orcad-migration-repository-link'
import { reconcileManagedOrcadSshTargets, visibleRepos } from './orcad-retained-source'
import { SshConnectionStore } from './ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore
}))
vi.mock('./orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('./orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  closeOrcadManagedTunnel: async () => {}
}))

const { convertSshTargetToManagedOrcad } = await import('./orcad-runtime-conversion')

const TARGET: SshTarget = {
  id: 'ssh-shared',
  label: 'Shared box',
  host: 'box.example.com',
  port: 22,
  username: 'root',
  generation: 2
}

function repo(id: string, path: string, connectionId: string | null = TARGET.id): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...(connectionId ? { connectionId } : {})
  }
}

let userDataPath: string
// This desktop's profile, which still holds the host's relay-era projects.
let store: Store
// The host's managed server, which another desktop on the same login already uses.
let server: Store
let destination: OrcadMigrationDestinationCatalog & { stage: ReturnType<typeof vi.fn> }

/** The real server-side import behind the T6-9 calls, as orcad runs it. */
function serverDestination(): typeof destination {
  return {
    readState: async (manifest: OrcadMigrationManifest) =>
      server.getOrcadMigrationCatalogState(manifest),
    stage: vi.fn(async (manifest: OrcadMigrationManifest) =>
      server.stageOrcadMigrationCatalog(manifest)
    ),
    commit: async (manifest) => server.commitStagedOrcadMigrationCatalog(manifest),
    abort: async (manifest) => {
      const result = server.abortStagedOrcadMigrationCatalog(manifest)
      return result.aborted ? result : { ...result, durableAbsent: true as const }
    },
    stageChunk: async (request) => server.stageOrcadMigrationSnapshotChunk(request)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-repository-link-'))
  store = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'desktop', 'orca-data.json')
  })
  server = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'server', 'orca-data.json')
  })
  store.addSshTarget(TARGET)
  store.addRepo(repo('desktop-repo', '/root/migrepo'))
  store.addRepo(repo('desktop-only', '/root/tool'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  mocks.state.targetStore = new SshConnectionStore(store as never)
  destination = serverDestination()
  mocks.ensureTunnel.mockResolvedValue(undefined)
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const owner = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))
    if (!owner) {
      throw new Error('deploy without a fence')
    }
    if (!listEnvironments(path).some((entry) => entry.id === owner)) {
      addManagedOrcadEnvironment(path, {
        id: owner,
        name: args.name,
        pairingCode: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:46768/',
          deviceToken: 'device-token',
          publicKeyB64: 'public-key'
        }),
        orcadDeployment: {
          sshTargetId: TARGET.id,
          sshTargetGeneration: 2,
          localPort: 46_768,
          remotePort: 6_768
        }
      })
    }
    // The running server of another Orca version, adopted as it is.
    return { outcome: 'already-current', environment: {}, activeVersion: '1.0.0' }
  })
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

const convert = (link = true, census: 'exited' | 'unverifiable' = 'exited') =>
  convertSshTargetToManagedOrcad(userDataPath, {
    sshTargetId: TARGET.id,
    name: 'Managed',
    censusHost: async () => ({ verdict: census, count: 0 }),
    destinationFor: () => destination,
    ...(link ? { serverRepositoriesFor: async () => server.getRepos() } : {}),
    now: () => new Date('2026-10-14T00:00:00.000Z')
  })

const serverRepoIds = () =>
  server
    .getRepos()
    .map((entry) => entry.id)
    .sort()

// Desktop A, on the same Unix login, added the same checkout.
const otherDesktopAddsSameCheckout = () =>
  server.addRepo(repo('server-repo', '/root/migrepo', null))

describe('moving onto a server another desktop already added the same project to', () => {
  it('is refused by the server when nothing links the project', async () => {
    otherDesktopAddsSameCheckout()
    await expect(convert(false)).rejects.toThrow(
      'orcad_migration_repository_path_conflict:/root/migrepo'
    )
  })

  it('links it to the server’s project and moves only what the server lacks', async () => {
    otherDesktopAddsSameCheckout()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })

    expect(serverRepoIds()).toEqual(['desktop-only', 'server-repo'])
    const [journal] = listOrcadMigrationSourceCutovers(userDataPath)
    expect(journal).toMatchObject({
      phase: 'destination-committed',
      linkedRepositoryIds: ['desktop-repo'],
      sourceRetainedAt: '2026-10-14T00:00:00.000Z'
    })
    expect(journal?.manifest.payload.repositories.map((entry) => entry.id)).toEqual([
      'desktop-only'
    ])
    // Both rows stay for a downgraded build; this build shows the server's projects instead.
    expect(
      store
        .getRepos()
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['desktop-only', 'desktop-repo'])
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
  })

  it('tells the connect which projects it linked', async () => {
    otherDesktopAddsSameCheckout()
    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      linkedProjects: [{ path: '/root/migrepo', automations: 0 }]
    })
  })

  it('says nothing was linked when the server held none of the projects', async () => {
    const result = await convert()
    expect(result.outcome).toBe('converted')
    expect(result).not.toHaveProperty('linkedProjects')
  })

  it('leaves the linked project’s saved state to the server, moving only the rest', async () => {
    otherDesktopAddsSameCheckout()
    store.setWorktreeMeta('desktop-repo::/root/migrepo', { comment: 'from this desktop' })
    store.setWorktreeMeta('desktop-only::/root/tool', { comment: 'moves' })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(server.getWorktreeMeta('desktop-only::/root/tool')?.comment).toBe('moves')
    expect(server.getWorktreeMeta('desktop-repo::/root/migrepo')).toBeUndefined()
    // Kept in this desktop's retained rows for a downgraded build.
    expect(store.getWorktreeMeta('desktop-repo::/root/migrepo')?.comment).toBe('from this desktop')
  })

  // COMPAT(legacy-relay-bridge): the bridge reattaches a relay pane only into its own tab.
  describe('with a relay terminal the bridge still serves', () => {
    const lease = (worktreeId: string) => ({
      targetId: TARGET.id,
      ptyId: 'relay-pty',
      state: 'detached' as const,
      tabId: 'tab-1',
      worktreeId,
      createdAt: 1,
      updatedAt: 1
    })

    it('refuses to link the project the terminal runs in, naming it, and moves nothing', async () => {
      otherDesktopAddsSameCheckout()
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([
        lease('desktop-repo::/root/migrepo')
      ])
      await expect(convert(true, 'unverifiable')).rejects.toThrow(
        'orcad_migration_linked_project_terminals:/root/migrepo'
      )
      expect(serverRepoIds()).toEqual(['server-repo'])
      expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.linkedRepositoryIds).toBeUndefined()
    })

    it.each([
      ['no project', undefined],
      ['a project this desktop removed', 'removed-repo::/root/old']
    ])('refuses a terminal in %s without blaming the linked project', async (_case, worktreeId) => {
      otherDesktopAddsSameCheckout()
      const { worktreeId: _omit, ...unowned } = lease('')
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([
        worktreeId ? { ...unowned, worktreeId } : unowned
      ])
      await expect(convert(true, 'unverifiable')).rejects.toThrow(
        'orcad_migration_linked_project_unowned_terminals:/root/migrepo'
      )
      expect(serverRepoIds()).toEqual(['server-repo'])
    })

    it('still links when the terminal runs in a project that moves', async () => {
      otherDesktopAddsSameCheckout()
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([lease('desktop-only::/root/tool')])
      await expect(convert(true, 'unverifiable')).resolves.toMatchObject({ outcome: 'converted' })
      expect(serverRepoIds()).toEqual(['desktop-only', 'server-repo'])
    })
  })

  it('stays managed across a restart: the linked rows are not an older build’s change', async () => {
    otherDesktopAddsSameCheckout()
    await convert()
    reconcileManagedOrcadSshTargets(userDataPath, store)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })

  it('never offers the linked project again in a later delta move', async () => {
    otherDesktopAddsSameCheckout()
    await convert()
    store.addRepo(repo('added-later', '/root/later'))
    reconcileManagedOrcadSshTargets(userDataPath, store)
    const target = store.getSshTarget(TARGET.id)!
    expect(target.orcadFence?.sourceChangedAt).toBeDefined()
    const plan = planOrcadDeltaMove(userDataPath, store, target)
    expect(plan.added.map((row) => row.id)).toEqual(['added-later'])
  })

  it('re-journals a move the server already staged, after proving the stage is gone', async () => {
    destination.commit = async () => {
      throw new Error('socket closed')
    }
    await expect(convert()).rejects.toThrow('socket closed')
    const [staged] = listOrcadMigrationSourceCutovers(userDataPath)
    expect(staged?.phase).toBe('destination-staged')
    // Desktop A adds the same checkout while this move waits.
    otherDesktopAddsSameCheckout()
    destination = serverDestination()

    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      migrationId: staged?.migrationId
    })
    expect(serverRepoIds()).toEqual(['desktop-only', 'server-repo'])
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
  })

  it('keeps refusing a source edited after the fence instead of linking over it', async () => {
    destination.stage.mockImplementationOnce(async () => {
      throw new Error('socket closed')
    })
    await expect(convert()).rejects.toThrow('socket closed')
    otherDesktopAddsSameCheckout()
    store.updateRepo('desktop-only', { displayName: 'Renamed' })
    await expect(convert()).rejects.toThrow('orcad_migration_source_changed')
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.linkedRepositoryIds).toBeUndefined()
  })
})

describe('what a linked project leaves behind', () => {
  it('counts this desktop’s automations on each linked project only', () => {
    const runIn = (repoId: string) => ({
      kind: 'workspace-run' as const,
      projectId: repoId,
      hostId: 'local' as const,
      projectHostSetupId: repoId,
      repoId,
      path: '/'
    })
    const fake = {
      getRepos: () => [repo('linked', '/root/app'), repo('moved', '/root/tool')],
      listAutomations: () => [
        { projectId: 'linked' },
        { projectId: 'linked', runContext: runIn('moved') },
        { projectId: 'moved' },
        { projectId: 'other', runContext: runIn('linked') }
      ]
    }
    expect(linkedOrcadMigrationProjects(fake, { linkedRepositoryIds: ['linked'] })).toEqual([
      { path: '/root/app', automations: 2 }
    ])
    expect(linkedOrcadMigrationProjects(fake, {})).toEqual([])
  })
})

describe('which projects are the same checkout', () => {
  const incoming = [{ id: 'mine', path: '/root/app' }]

  it('links the same absolute path on the host, spelled with a trailing slash', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'theirs', path: '/root/app/' }])).toEqual([
      'mine'
    ])
  })

  it('keeps a POSIX path that differs only in case apart', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'theirs', path: '/root/App' }])).toEqual([])
  })

  it('folds case on a Windows host', () => {
    expect(
      repositoriesHeldByServer(
        [{ id: 'mine', path: 'C:\\src\\app' }],
        [{ id: 'theirs', path: 'c:/src/app' }]
      )
    ).toEqual(['mine'])
  })

  it('leaves a project the server holds under the same id to the import', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'mine', path: '/root/app' }])).toEqual([])
  })

  it('does not link a different path', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'theirs', path: '/root/app2' }])).toEqual([])
  })
})
