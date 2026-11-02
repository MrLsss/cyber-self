/**
 * Per-session prompt contribution: a session working inside a library learns
 * the answering rules before its first turn, and learns them again whenever
 * the library or its answer scope changed since the last time it was told.
 * @module cyberself/policy
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AnswerScope } from '../shared/protocol.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    cyberself: { kind: 'cyberself'; form: 'instructions' }
  }
}

/** Counts that describe the library a session is bound to. */
export interface LibrarySummary {
  documents: number
  chunks: number
  embedded: number
}

/** What the policy needs from the plugin service. */
export interface LibraryLookup {
  /** Counts of the library in this directory, or null when it is not a library. */
  librarySummary(dir: string): LibrarySummary | null
  /** How far the model may reach beyond the library in this directory. */
  scopeOf(dir: string): AnswerScope
}

/** Rules for a library that answers from its own documents alone. */
const LIBRARY_RULES = [
  '当前工作区是一个个人资料库，回答必须遵守下面的规则：',
  '1. 回答资料相关的问题之前，先用 knowledge_search 取得原文依据；问题涉及具体条款、数字或名称时，再用 knowledge_read 核对上下文。',
  '2. 只能依据工具返回的资料原文回答。不要用其他工具去读取资料库以外的内容，不要补充资料以外的知识，不要凭印象推断或猜测。',
  '3. 每条论断后面用方括号标注依据编号，例如 [1]，编号只能取自本次工具返回的结果。',
  '4. 资料库里没有的内容，直接说明缺少这部分资料，并说明需要补充哪一类资料。',
  '5. 引用原文时保持原样，不改写数字、日期和专有名词。',
]

/** Rules for a library that allows material from outside it as a supplement. */
const OPEN_RULES = [
  '当前工作区是一个个人资料库，回答遵守下面的规则：',
  '1. 回答资料相关的问题之前，先用 knowledge_search 取得原文依据；问题涉及具体条款、数字或名称时，再用 knowledge_read 核对上下文。',
  '2. 资料库里有依据时，以资料原文为准。',
  '3. 资料库没有覆盖的部分，可以用其他方式查找或用自己的知识补充，补充的内容单独成句并注明"（资料库外）"，不要和带编号的依据混在一起。',
  '4. 来自资料库的论断后面用方括号标注依据编号，例如 [1]，编号只能取自本次工具返回的结果。',
  '5. 引用原文时保持原样，不改写数字、日期和专有名词。',
]

/** Rules the model is told to follow inside a library workspace. */
export function libraryPolicyText(summary: LibrarySummary, scope: AnswerScope): string {
  const rules = scope === 'open' ? OPEN_RULES : LIBRARY_RULES
  return [
    ...rules,
    `资料库现状：${summary.documents} 份资料，${summary.chunks} 段，已向量化 ${summary.embedded} 段。`,
  ].join('\n')
}

/**
 * Tell every session that works inside a library what the answering rules are.
 *
 * The contribution is a user-role context message admitted by the pre-step
 * waterfall, the same channel first-party instruction plugins use. It is
 * repeated only when the library or its answer scope changed since the session
 * was last told, so a long conversation does not accumulate copies while an
 * import still refreshes the counts the model sees.
 *
 * @param ctx - plugin scope; the listener is disposed with it.
 * @param lookup - resolves the library counts and answer scope of a directory.
 */
export function registerLibraryPolicy(ctx: Context, lookup: LibraryLookup): void {
  const told = new Map<string, string>()

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    const header = payload.agent.session.header
    const cwd = header.cwd
    if (cwd === undefined) return decision
    const summary = lookup.librarySummary(cwd)
    if (summary === null) return decision
    const scope = lookup.scopeOf(cwd)
    const signature = `${scope}/${summary.documents}/${summary.chunks}/${summary.embedded}`
    if (told.get(header.id) === signature) return decision
    told.set(header.id, signature)
    const text = libraryPolicyText(summary, scope)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'cyberself', form: 'instructions' },
        }),
      ],
    }
  }, { prepend: true })
}
