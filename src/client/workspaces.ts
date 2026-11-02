/**
 * Directory of the workspace that owns one session, read from the client
 * Workspace state. The Host is not asked about the session, so a session the
 * Host has not loaded yet still resolves to its workspace.
 * @module cyberself/client/workspaces
 */
import { useSyncExternalStore } from 'react'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'

let source: WorkspaceSource | undefined

/** Point this module at the client Workspace state once the plugin applies. */
export function setWorkspaceSource(next: WorkspaceSource): void {
  source = next
}

function subscribe(listener: () => void): () => void {
  if (source === undefined) return () => {}
  return source.subscribe(listener)
}

function directoryOf(sessionId: string): string | undefined {
  if (source === undefined) return undefined
  const owner = source.getSnapshot().items.find((item) => item.sessionIds.some((id) => String(id) === sessionId))
  return owner?.path
}

/** Directory of the workspace that owns the session, once the workspace list knows it. */
export function useSessionDirectory(sessionId: string | undefined): string | undefined {
  return useSyncExternalStore(subscribe, () => sessionId === undefined ? undefined : directoryOf(sessionId))
}
