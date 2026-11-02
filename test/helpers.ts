/**
 * Shared fixtures for the test suite: scratch directories under the gitignored
 * `.tmp` tree, plugin configuration resolved from the real schema, and a
 * service instance wired to the workspace list the test provides.
 * @module cyberself/test/helpers
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Config, type CyberSelfConfig } from '../src/host/config.ts'
import { CyberSelf, type ServiceDeps } from '../src/host/service.ts'
import { readEmbeddingSettings, writeEmbeddingSettings } from '../src/host/settings.ts'
import type { WorkspaceChoice } from '../src/shared/protocol.ts'

/** Repository root; the suite runs from here. */
export const ROOT = resolve(import.meta.dirname, '..')

/** Unsaved configuration input accepted by {@link makeConfig}. */
export type ConfigPatch = Parameters<typeof Config>[0]

/** A fresh scratch directory under the gitignored `.tmp` tree. */
export function tempDir(label: string): string {
  const base = join(ROOT, '.tmp', 'tests')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, `${label}-`))
}

/** Settings written by the plugin land in this throwaway DSH home. */
export const TEST_HOME = tempDir('home')
process.env.DSH_HOME = TEST_HOME

/** The plugin defaults, with the given fields overridden. */
export function makeConfig(patch: ConfigPatch = {}): CyberSelfConfig {
  return Config(patch)
}

/** A service whose only workspace is the given directory. */
export function makeService(
  dir: string,
  config: CyberSelfConfig = makeConfig(),
  overrides: Partial<ServiceDeps> = {},
): CyberSelf {
  const workspaces: Omit<WorkspaceChoice, 'library' | 'scope'>[] = [{ id: 'ws-test', path: realpathSync(dir), title: '测试工作区' }]
  return new CyberSelf({
    config: () => config,
    listWorkspaces: () => workspaces,
    llm: null,
    attachments: null,
    route: () => ({ provider: 'test', model: 'test' }),
    readEmbeddingSettings,
    writeEmbeddingSettings,
    ...overrides,
  })
}
