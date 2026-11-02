/**
 * Host half of the plugin: keeps one knowledge base per library workspace,
 * serves the HTTP API, registers the retrieval tools, and tells every session
 * inside a library what the answering rules are.
 * @module cyberself
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { Config, type CyberSelfConfig } from './config.ts'
import { registerLibraryPolicy } from './policy.ts'
import { createRoutes } from './routes.ts'
import { CyberSelf } from './service.ts'
import { readEmbeddingSettings, writeEmbeddingSettings } from './settings.ts'
import { createTools } from './tools.ts'
import type { ModelRoute } from './answer/qa.ts'

/** Plugin name used by the loader and the patch file. */
export const name = 'cyberself'

/** Host services this plugin needs before it applies. */
export const inject = ['webServer', 'llm', 'attachments', 'workspaceRegistry', 'agentDefaultModel', 'tools']

export { Config }

/**
 * Compose the service from the Host, mount the routes, register the tools, and
 * add the per-session library policy.
 * @param ctx - plugin scope.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: CyberSelfConfig | undefined): void {
  const settings = Config(config ?? {})
  const route = (): ModelRoute => {
    const selection = ctx.agentDefaultModel.currentSelection()
    const configured = settings.answer
    const overridden = configured.provider !== '' && configured.model !== ''
    return {
      provider: overridden ? configured.provider : selection.provider,
      model: overridden ? configured.model : selection.model,
      ...(overridden || selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }

  const service = new CyberSelf({
    config: () => settings,
    listWorkspaces: () => ctx.workspaceRegistry.list().map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
    })),
    llm: ctx.llm,
    attachments: ctx.attachments,
    route,
    readEmbeddingSettings,
    writeEmbeddingSettings,
  })

  ctx.effect(() => () => service.dispose())

  const routes = createRoutes({
    service,
    report: (error: unknown) => ctx.logger.warn(error),
  })
  for (const webRoute of routes) {
    ctx.effect(() => ctx.webServer.register(webRoute))
  }

  for (const tool of createTools(service)) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  registerLibraryPolicy(ctx, service)
}
