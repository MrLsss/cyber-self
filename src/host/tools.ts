/**
 * Tools the model may call. Every tool answers from the knowledge base of the
 * session's own working directory, and nothing else.
 * @module cyberself/tools
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CyberSelfError, type Citation, type DocumentView } from '../shared/protocol.ts'
import type { CyberSelf } from './service.ts'

/** Where a tool finds the knowledge base: the session's validated cwd. */
function sessionDirectory(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new CyberSelfError(400, '当前会话没有工作目录，无法确定资料库位置')
  return cwd
}

function formatCitation(citation: Citation): string {
  const place = [
    citation.page === null ? null : `第 ${citation.page} 页`,
    citation.heading,
  ].filter((part): part is string => part !== null && part !== '')
  const suffix = place.length === 0 ? '' : ` · ${place.join(' · ')}`
  return `[${citation.index}]《${citation.title}》${suffix}\n${citation.text}`
}

function formatDocument(document: DocumentView): string {
  const size = document.bytes < 1024
    ? `${document.bytes} 字节`
    : `${Math.round(document.bytes / 1024)} KB`
  return `- ${document.title}（${document.kind}，${size}，${document.chunkCount} 段，已向量化 ${document.embeddedChunks} 段）id=${document.id}`
}

function formatChunk(chunk: { ordinal: number; page: number; heading: string; text: string }): string {
  const place = [chunk.page === 0 ? null : `第 ${chunk.page} 页`, chunk.heading === '' ? null : chunk.heading]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return `#${chunk.ordinal}${place === '' ? '' : `（${place}）`}\n${chunk.text}`
}

/** Tools registered by the plugin. */
export function createTools(service: CyberSelf) {
  return [
    defineTool({
      name: 'cyberself_search',
      description: '在当前工作区的个人知识库里检索资料片段。回答用户关于资料的问题之前先用它取得原文依据，引用时使用返回的编号。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '检索用的自然语言问题或关键词，使用用户问题里的原词效果最好。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            note: { type: 'string', required: true },
            citations: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'integer', required: true },
                  title: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  page: { type: 'integer', required: true },
                  heading: { type: 'string', required: true },
                  text: { type: 'string', required: true },
                  score: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.citations.length === 0) {
            return [{ type: 'text', text: value.note === '' ? '资料库里没有匹配的内容。' : value.note }]
          }
          const body = value.citations.map((citation) => formatCitation({
            index: citation.index,
            chunkId: '',
            documentId: '',
            title: citation.title,
            path: citation.path,
            page: citation.page,
            heading: citation.heading,
            text: citation.text,
            score: citation.score,
          })).join('\n\n')
          const note = value.note === '' ? '' : `${value.note}\n\n`
          return [{ type: 'text', text: `${note}${body}` }]
        },
      },
      async execute(args, exec) {
        const dir = sessionDirectory(exec)
        const found = await service.search(dir, args.query)
        return {
          query: found.query,
          note: found.note ?? '',
          citations: found.citations.map((citation) => ({
            index: citation.index,
            title: citation.title,
            path: citation.path,
            page: citation.page ?? 0,
            heading: citation.heading ?? '',
            text: citation.text,
            score: citation.score,
          })),
        }
      },
    }),

    defineTool({
      name: 'cyberself_documents',
      description: '列出当前工作区个人知识库里的全部资料，包含标题、类型、段落数与向量化进度。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            documents: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  bytes: { type: 'integer', required: true },
                  chunkCount: { type: 'integer', required: true },
                  embeddedChunks: { type: 'integer', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.documents.length === 0) return [{ type: 'text', text: '资料库还是空的。' }]
          return [{
            type: 'text',
            text: value.documents.map((document) => formatDocument({
              id: document.id,
              title: document.title,
              path: '',
              kind: document.kind,
              bytes: document.bytes,
              importedAt: 0,
              chunkCount: document.chunkCount,
              embeddedChunks: document.embeddedChunks,
            })).join('\n'),
          }]
        },
      },
      async execute(_args, exec) {
        const library = await service.library(sessionDirectory(exec))
        return {
          documents: library.documents.map((document) => ({
            id: document.id,
            title: document.title,
            kind: document.kind,
            bytes: document.bytes,
            chunkCount: document.chunkCount,
            embeddedChunks: document.embeddedChunks,
          })),
        }
      },
    }),

    defineTool({
      name: 'cyberself_read',
      description: '按文档 id 读取资料原文，用于核对检索片段之外的上下文。',
      parameters: {
        documentId: { type: 'string', required: true, description: '资料 id，来自 cyberself_documents 或 cyberself_search 的结果。' },
        offset: { type: 'integer', description: '从第几段开始，默认 0。' },
        limit: { type: 'integer', description: '读取多少段，默认 20，最多 100。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            chunks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ordinal: { type: 'integer', required: true },
                  page: { type: 'integer', required: true },
                  heading: { type: 'string', required: true },
                  text: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const heading = `《${value.title}》共 ${value.total} 段，本次 ${value.chunks.length} 段`
          return [{ type: 'text', text: `${heading}\n\n${value.chunks.map(formatChunk).join('\n\n')}` }]
        },
      },
      async execute(args, exec) {
        const detail = await service.detail(sessionDirectory(exec), args.documentId)
        const offset = Math.max(0, args.offset ?? 0)
        const limit = Math.min(100, Math.max(1, args.limit ?? 20))
        const chunks = detail.chunks.slice(offset, offset + limit)
        return {
          title: detail.document.title,
          total: detail.document.chunkCount,
          chunks: chunks.map((chunk) => ({
            ordinal: chunk.ordinal,
            page: chunk.page ?? 0,
            heading: chunk.heading ?? '',
            text: chunk.text,
          })),
        }
      },
    }),
  ]
}
