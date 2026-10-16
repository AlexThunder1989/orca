import type { ProjectSectionEntry } from '../../../../../../shared/project-section-grouping'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'

export type OrderedGroupEntry = [string, WorktreeGroupEntry]

export type WorktreeGroupEntry = ProjectSectionEntry<Worktree> & {
  /** Folder workspaces bucketed into this lane under non-repo grouping. Carries
   *  the owning group because FolderWorkspaceRow requires a non-optional one. */
  folderWorkspaces?: RenderableFolderWorkspace[]
}
