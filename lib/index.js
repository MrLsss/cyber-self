import Schema from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { convertToMarkdown, images } from "mammoth";
import { load } from "cheerio";
import { isTag } from "domhandler";
import { extractText, renderPageAsImage } from "unpdf";
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/host/config.ts
/** Configuration schema; cordis resolves it before {@link apply} runs. */
const Config = Schema.object({
	embedding: Schema.object({
		baseURL: Schema.string().default("http://127.0.0.1:11434").description("Ollama 服务地址"),
		model: Schema.string().default("bge-m3:latest").description("Ollama 嵌入模型"),
		timeoutMs: Schema.natural().default(12e4).description("单次嵌入请求的超时（毫秒）"),
		batchSize: Schema.natural().default(8).description("每次请求发送的文本条数"),
		maxChars: Schema.natural().default(0).description("送进模型的每块字符上限，0 表示不截断"),
		dedupeNumbers: Schema.boolean().default(true).description("表格里只有数字不同的分块共用一份向量")
	}).description("嵌入模型设置"),
	chunking: Schema.object({
		targetChars: Schema.natural().default(1200).description("分块目标长度（字符）"),
		overlapChars: Schema.natural().default(120).description("长段落切分时的重叠长度"),
		minChars: Schema.natural().default(80).description("最小块长度")
	}).description("分块设置"),
	retrieval: Schema.object({
		topK: Schema.natural().default(8).description("引用条数"),
		perDocument: Schema.natural().default(3).description("单文档最多引用的条数"),
		minScore: Schema.number().default(.4).description("向量余弦相似度下限"),
		maxEvidenceChars: Schema.natural().default(12e3).description("证据总字数上限")
	}).description("检索设置"),
	answer: Schema.object({
		provider: Schema.string().default("").description("回答使用的 provider，留空跟随默认模型"),
		model: Schema.string().default("").description("回答使用的模型，留空跟随默认模型"),
		temperature: Schema.number().default(.2).description("采样温度"),
		maxTokens: Schema.natural().default(2048).description("回答长度上限"),
		verify: Schema.boolean().default(true).description("回答没有引用时追加一次核验")
	}).description("回答设置"),
	ocr: Schema.object({
		enabled: Schema.boolean().default(true).description("对扫描页与图片做视觉转写"),
		provider: Schema.string().default("").description("转写使用的 provider，留空跟随默认模型"),
		model: Schema.string().default("").description("转写使用的模型，留空跟随默认模型"),
		pdfDpi: Schema.natural().default(160).description("扫描页渲染分辨率"),
		maxPages: Schema.natural().default(40).description("单文档最多转写的页数"),
		concurrency: Schema.natural().default(3).description("同时转写的页数或图片数")
	}).description("视觉转写设置")
});

//#endregion
//#region src/host/policy.ts
/** Rules for a library that answers from its own documents alone. */
const LIBRARY_RULES = [
	"当前工作区是一个个人资料库，回答必须遵守下面的规则：",
	"1. 回答资料相关的问题之前，先用 cyberself_search 取得原文依据；问题涉及具体条款、数字或名称时，再用 cyberself_read 核对上下文。",
	"2. 只能依据工具返回的资料原文回答。不要用其他工具去读取资料库以外的内容，不要补充资料以外的知识，不要凭印象推断或猜测。",
	"3. 每条论断后面用方括号标注依据编号，例如 [1]，编号只能取自本次工具返回的结果。",
	"4. 资料库里没有的内容，直接说明缺少这部分资料，并说明需要补充哪一类资料。",
	"5. 引用原文时保持原样，不改写数字、日期和专有名词。"
];
/** Rules for a library that allows material from outside it as a supplement. */
const OPEN_RULES = [
	"当前工作区是一个个人资料库，回答遵守下面的规则：",
	"1. 回答资料相关的问题之前，先用 cyberself_search 取得原文依据；问题涉及具体条款、数字或名称时，再用 cyberself_read 核对上下文。",
	"2. 资料库里有依据时，以资料原文为准。",
	"3. 资料库没有覆盖的部分，可以用其他方式查找或用自己的知识补充，补充的内容单独成句并注明\"（资料库外）\"，不要和带编号的依据混在一起。",
	"4. 来自资料库的论断后面用方括号标注依据编号，例如 [1]，编号只能取自本次工具返回的结果。",
	"5. 引用原文时保持原样，不改写数字、日期和专有名词。"
];
/** Rules the model is told to follow inside a library workspace. */
function libraryPolicyText(summary, scope) {
	return [...scope === "open" ? OPEN_RULES : LIBRARY_RULES, `资料库现状：${summary.documents} 份资料，${summary.chunks} 段，已向量化 ${summary.embedded} 段。`].join("\n");
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
function registerLibraryPolicy(ctx, lookup) {
	const told = /* @__PURE__ */ new Map();
	ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		if (decision.kind === "reject" || payload.signal.aborted) return decision;
		const header = payload.agent.session.header;
		const cwd = header.cwd;
		if (cwd === void 0) return decision;
		const summary = lookup.librarySummary(cwd);
		if (summary === null) return decision;
		const scope = lookup.scopeOf(cwd);
		const signature = `${scope}/${summary.documents}/${summary.chunks}/${summary.embedded}`;
		if (told.get(header.id) === signature) return decision;
		told.set(header.id, signature);
		const text = libraryPolicyText(summary, scope);
		return {
			...decision,
			messages: [...decision.messages, createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "cyberself",
					form: "instructions"
				}
			})]
		};
	}, { prepend: true });
}

//#endregion
//#region src/shared/protocol.ts
/**
* Wire contract shared by the Host routes and the browser client.
* @module cyberself/protocol
*/
/** Directory, relative to a workspace root, that holds the knowledge base. */
const KB_DIRECTORY = ".cyberself";
/** Base path of the HTTP API. */
const API_PREFIX = "/cyberself/api";
/** Path of the streaming answer endpoint. */
const ASK_PATH = "/cyberself/api/ask";
/** Path of the cancel endpoint that stops a running answer. */
const CANCEL_PATH = "/cyberself/api/cancel";
/** Path of the endpoint that reads and writes plugin settings. */
const SETTINGS_PATH = "/cyberself/api/settings";
/** Path of the endpoint that turns a workspace into a library, or back. */
const MARK_PATH = "/cyberself/api/mark";
/** Path of the plugin-wide report of what is stored on disk. */
const STORAGE_PATH = "/cyberself/api/storage";
/** Path of the endpoint that removes every document of one library. */
const PURGE_PATH = "/cyberself/api/purge";
/** Path of the endpoint that deletes one library together with its files. */
const FORGET_PATH = "/cyberself/api/forget";
/** Failure carrying the HTTP status the route should report. */
var CyberSelfError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.name = "CyberSelfError";
		this.status = status;
	}
};

//#endregion
//#region src/host/answer/vision.ts
const TRANSCRIPTION_PROMPT = [
	"把这张图片里的所有文字按原来的阅读顺序转写出来。",
	"保留标题层级、列表和表格的行列关系；表格用 Markdown 表格。",
	"不要描述图片，不要补充图中没有的内容。图片里没有文字时返回空字符串。"
].join("\n");
const TRANSCRIPTION_MAX_TOKENS = 16384;
async function readTranscription(llm, options, label) {
	const chunks = llm.stream(options);
	let text = "";
	let failure$1 = null;
	for await (const chunk of chunks) {
		if (chunk.type === "text-delta") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "finish" && chunk.reason.kind === "aborted") failure$1 = "转写被中止";
		else if (chunk.type === "finish" && chunk.reason.kind === "error") failure$1 = "模型调用失败";
	}
	if (failure$1 !== null) throw new CyberSelfError(502, `${label} 转写失败：${failure$1}`);
	return text.trim();
}
/** Build a transcriber bound to the live model route and OCR settings. */
function createVisionTranscriber(llm, attachments, resolveRoute, settings) {
	return { async transcribe(request) {
		const config = settings();
		const route = resolveRoute();
		const provider = config.provider === "" ? route.provider : config.provider;
		const model = config.model === "" ? route.model : config.model;
		const [reference] = await attachments.saveImages([{
			data: request.bytes,
			mediaType: request.mime,
			name: request.label
		}]);
		if (reference === void 0) throw new CyberSelfError(502, `无法保存 ${request.label} 用于转写`);
		const options = {
			provider,
			model,
			system: TRANSCRIPTION_PROMPT,
			messages: [{
				role: "user",
				content: [{
					type: "image",
					attachment: reference
				}, {
					type: "text",
					text: "请转写这张图片。"
				}]
			}],
			temperature: 0,
			maxTokens: TRANSCRIPTION_MAX_TOKENS,
			...request.signal === void 0 ? {} : { signal: request.signal }
		};
		const first = await readTranscription(llm, options, request.label);
		if (first !== "" || request.signal?.aborted === true) return first;
		return await readTranscription(llm, options, request.label);
	} };
}

//#endregion
//#region src/host/answer/prompt.ts
/** Instruction block that fixes the answer format. */
const ANSWER_SYSTEM_PROMPT = [
	"你是资料库问答助手。你只能依据这次给出的资料片段回答，不能使用片段之外的知识。",
	"",
	"规则：",
	"1. 每个论断后面用方括号编号标注来源，例如 [1]；同一句依据多条资料时写作 [1][3]。",
	"2. 只允许使用这次给出的编号，未给出的编号不能出现。",
	"3. 资料不足以回答时，直接说明缺少哪一类资料，不要猜测。",
	"4. 先给结论，再给依据；用自己的话概括，不要整段抄写原文。"
].join("\n");
/** Instruction sent when the first answer cited nothing. */
const VERIFY_INSTRUCTION = "你刚才的回答没有标注任何引用。请重新回答这个问题，每个论断都必须带上资料片段编号，例如 [1]。";
/** Keep the evidence block within the configured character budget. */
function selectEvidence(citations, maxChars) {
	const selected = [];
	let used = 0;
	for (const citation of citations) {
		const cost = citation.text.length + 80;
		if (selected.length > 0 && used + cost > maxChars) break;
		selected.push(citation);
		used += cost;
	}
	return selected;
}
/** Render the numbered evidence block handed to the model. */
function buildEvidencePrompt(question, evidence) {
	const parts = [
		`问题：${question}`,
		"",
		"资料片段："
	];
	for (const citation of evidence) {
		const location = citation.page === null ? "" : ` 第 ${citation.page} 页`;
		const section = citation.heading === null ? "" : ` · ${citation.heading}`;
		parts.push("", `[${citation.index}]《${citation.title}》${location}${section}`, citation.text);
	}
	parts.push("", "请依据以上片段回答问题。");
	return parts.join("\n");
}
/** Every citation number written in the answer, in order, without duplicates. */
function parseCitationIndexes(answer) {
	const found = [];
	const seen = /* @__PURE__ */ new Set();
	for (const match of answer.matchAll(/[[【](\d{1,3})[\]】]/gu)) {
		const value = Number(match[1]);
		if (!Number.isInteger(value) || seen.has(value)) continue;
		seen.add(value);
		found.push(value);
	}
	return found;
}

//#endregion
//#region src/host/answer/qa.ts
async function streamAnswer(llm, route, input, prompt, onToken) {
	const options = {
		provider: input.settings.provider === "" ? route.provider : input.settings.provider,
		model: input.settings.model === "" ? route.model : input.settings.model,
		system: ANSWER_SYSTEM_PROMPT,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: prompt
			}]
		}],
		temperature: input.settings.temperature,
		maxTokens: input.settings.maxTokens,
		signal: input.signal,
		...route.reasoningEffort === void 0 ? {} : { reasoningEffort: route.reasoningEffort }
	};
	const chunks = llm.stream(options);
	let text = "";
	let failure$1 = null;
	for await (const chunk of chunks) {
		if (chunk.type === "text-delta") {
			text += chunk.text;
			onToken?.(chunk.text);
			continue;
		}
		if (chunk.type !== "finish") continue;
		const reason = chunk.reason;
		if (reason.kind === "error") failure$1 = `模型调用失败：${describeFailure(reason.failure)}`;
		else if (reason.kind === "aborted") failure$1 = "模型调用被中止";
		else if (reason.kind === "tool-calls") failure$1 = "模型返回了工具调用，本次回答已丢弃";
	}
	return {
		text: text.trim(),
		failure: failure$1
	};
}
function describeFailure(failure$1) {
	if (failure$1 !== null && typeof failure$1 === "object") {
		const record = failure$1;
		const parts = [typeof record.code === "string" ? record.code : "", typeof record.message === "string" ? record.message : ""].filter((part) => part !== "");
		if (parts.length > 0) return parts.join(" · ");
	}
	return String(failure$1);
}
/**
* Answer one question from numbered evidence.
*
* When the answer cites nothing, and verification is enabled, the model is
* asked once more with the first attempt in view; the cited attempt wins.
*/
async function answerQuestion(llm, route, input) {
	const evidence = selectEvidence(input.citations, input.maxEvidenceChars);
	if (evidence.length === 0) throw new CyberSelfError(422, "这次检索没有可用的资料片段");
	const modelLabel = `${input.settings.provider === "" ? route.provider : input.settings.provider}/${input.settings.model === "" ? route.model : input.settings.model}`;
	const first = await streamAnswer(llm, route, input, buildEvidencePrompt(input.question, evidence), input.onToken);
	if (first.failure !== null) throw new CyberSelfError(502, first.failure);
	if (first.text === "") throw new CyberSelfError(502, "模型没有返回任何内容");
	const numbers = parseCitationIndexes(first.text);
	const valid = numbers.filter((index) => index >= 1 && index <= evidence.length);
	const invalid = numbers.filter((index) => index < 1 || index > evidence.length);
	if (valid.length > 0) return {
		question: input.question,
		answer: first.text,
		citations: evidence,
		model: modelLabel,
		warning: invalid.length === 0 ? null : `回答引用了不存在的编号：${invalid.join("、")}`
	};
	if (!input.settings.verify) return {
		question: input.question,
		answer: first.text,
		citations: evidence,
		model: modelLabel,
		warning: "回答没有引用任何资料片段"
	};
	const second = await streamAnswer(llm, route, input, [
		buildEvidencePrompt(input.question, evidence),
		"",
		VERIFY_INSTRUCTION,
		"",
		`上一次的回答是：${first.text}`
	].join("\n"), input.onToken);
	if (second.failure !== null) throw new CyberSelfError(502, second.failure);
	if (parseCitationIndexes(second.text).filter((index) => index >= 1 && index <= evidence.length).length > 0) return {
		question: input.question,
		answer: second.text,
		citations: evidence,
		model: modelLabel,
		warning: null
	};
	return {
		question: input.question,
		answer: second.text === "" ? first.text : second.text,
		citations: evidence,
		model: modelLabel,
		warning: "回答没有引用任何资料片段"
	};
}

//#endregion
//#region src/host/kb/db.ts
const SCHEMA_VERSION = 1;
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  page INTEGER,
  heading TEXT,
  embedding BLOB,
  embedding_dim INTEGER
);
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;
/** Resolve the knowledge base location of a workspace without touching disk. */
function locateKb(dir) {
	const root = join(dir, KB_DIRECTORY);
	return {
		dir,
		root,
		file: join(root, "kb.db")
	};
}
/** Open (creating on first use) the knowledge base of a workspace. */
function openKb(dir) {
	const location = locateKb(dir);
	mkdirSync(location.root, { recursive: true });
	const db = new DatabaseSync(location.file);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(DDL);
	if (db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") === void 0) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
	return {
		...location,
		db,
		savepoints: 0
	};
}
/** Close an open knowledge base. */
function closeKb(handle) {
	handle.db.close();
}
/**
* Run `work` inside one transaction, nesting safely: a savepoint is used so a
* caller that already opened a transaction (importing a file writes the document
* and its chunks together) keeps its own boundary.
*/
function withTransaction(handle, work) {
	const savepoint = `cyberself_${handle.savepoints += 1}`;
	handle.db.exec(`SAVEPOINT ${savepoint}`);
	try {
		const value = work();
		handle.db.exec(`RELEASE ${savepoint}`);
		return value;
	} catch (error) {
		handle.db.exec(`ROLLBACK TO ${savepoint}`);
		handle.db.exec(`RELEASE ${savepoint}`);
		throw error;
	}
}
/** Encode a vector as the little-endian float32 blob stored in SQLite. */
function encodeVector(vector) {
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength).slice();
}
/** Decode a float32 blob back into a vector. */
function decodeVector(blob) {
	const copy = new Uint8Array(blob.byteLength);
	copy.set(blob);
	return new Float32Array(copy.buffer);
}

//#endregion
//#region src/host/kb/store.ts
function toDocumentView(row) {
	return {
		id: row.id,
		title: row.title,
		path: row.path,
		kind: row.kind,
		bytes: row.bytes,
		importedAt: row.imported_at,
		chunkCount: row.chunk_count,
		embeddedChunks: row.embedded_chunks
	};
}
/** Read one meta value. */
function readMeta(handle, key) {
	const row = handle.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
	return row === void 0 ? null : row.value;
}
/** Write one meta value. */
function writeMeta(handle, key, value) {
	handle.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
/** Every document, newest import first, with chunk counts. */
function listDocuments(handle) {
	return handle.db.prepare(`
    SELECT d.id, d.title, d.path, d.kind, d.bytes, d.imported_at,
           COUNT(c.id) AS chunk_count,
           COALESCE(SUM(CASE WHEN c.embedding IS NULL THEN 0 ELSE 1 END), 0) AS embedded_chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id
    ORDER BY d.imported_at DESC, d.title ASC
  `).all().map(toDocumentView);
}
/** One document, or null when the id is unknown. */
function getDocument(handle, id) {
	const row = handle.db.prepare(`
    SELECT d.id, d.title, d.path, d.kind, d.bytes, d.imported_at,
           COUNT(c.id) AS chunk_count,
           COALESCE(SUM(CASE WHEN c.embedding IS NULL THEN 0 ELSE 1 END), 0) AS embedded_chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    WHERE d.id = ?
    GROUP BY d.id
  `).get(id);
	return row === void 0 ? null : toDocumentView(row);
}
/** Id of the document whose file bytes hash to `sha256`, if any. */
function findDocumentByHash(handle, sha256) {
	const row = handle.db.prepare("SELECT id FROM documents WHERE sha256 = ?").get(sha256);
	return row === void 0 ? null : row.id;
}
/** Insert a document row. */
function insertDocument(handle, document) {
	handle.db.prepare(`
    INSERT INTO documents (id, title, path, kind, bytes, sha256, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(document.id, document.title, document.path, document.kind, document.bytes, document.sha256, document.importedAt);
}
/** Chunk ids looked up in one statement; keeps every `IN` list well under the SQLite variable limit. */
const LOOKUP_BATCH = 400;
/** Which of `hashes` are already stored, used to drop repeated passages before writing. */
function findChunkHashes(handle, hashes) {
	const found = /* @__PURE__ */ new Set();
	for (let start = 0; start < hashes.length; start += LOOKUP_BATCH) {
		const slice = hashes.slice(start, start + LOOKUP_BATCH);
		const placeholders = slice.map(() => "?").join(", ");
		const rows = handle.db.prepare(`SELECT hash FROM chunks WHERE hash IN (${placeholders})`).all(...slice);
		for (const row of rows) found.add(row.hash);
	}
	return found;
}
/** Identifier of one chunk row inside its document. */
function chunkId(documentId, ordinal) {
	return `${documentId}-${ordinal.toString().padStart(5, "0")}`;
}
/** Insert chunks; a null vector leaves the chunk pending embedding. */
function insertChunks(handle, documentId, chunks, vectors) {
	const statement = handle.db.prepare(`
    INSERT INTO chunks (id, document_id, ordinal, text, hash, page, heading, embedding, embedding_dim)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	withTransaction(handle, () => {
		chunks.forEach((chunk, index) => {
			const vector = vectors[index] ?? null;
			statement.run(chunkId(documentId, chunk.ordinal), documentId, chunk.ordinal, chunk.text, chunk.hash, chunk.page, chunk.heading, vector === null ? null : encodeVector(vector), vector === null ? null : vector.length);
		});
	});
}
/** Remove a document and, by cascade, its chunks. */
function deleteDocument(handle, id) {
	return handle.db.prepare("DELETE FROM documents WHERE id = ?").run(id).changes > 0;
}
/** Remove every document, and with them every chunk and vector. */
function purgeDocuments(handle) {
	const result = withTransaction(handle, () => handle.db.prepare("DELETE FROM documents").run());
	handle.db.prepare("DELETE FROM meta WHERE key IN ('embedding_model', 'embedding_dim')").run();
	return Number(result.changes);
}
/** Return freed pages to the filesystem, so the database file really shrinks. */
function reclaimSpace(handle) {
	handle.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	handle.db.exec("VACUUM");
	handle.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
/** Counts for the library header. */
function libraryStats(handle) {
	const row = handle.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents) AS documents,
      (SELECT COUNT(*) FROM chunks) AS chunks,
      (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded
  `).get();
	return row === void 0 ? {
		documents: 0,
		chunks: 0,
		embedded: 0
	} : row;
}
/** Chunks of one document in reading order. */
function listChunks(handle, documentId, limit) {
	return handle.db.prepare(`
    SELECT id, ordinal, page, heading, text FROM chunks
    WHERE document_id = ? ORDER BY ordinal ASC LIMIT ?
  `).all(documentId, limit);
}
/** Chunks that still need a vector, oldest document first, without reading their text. */
function pendingChunkIds(handle) {
	return handle.db.prepare(`
    SELECT c.id, c.document_id AS documentId, d.kind FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.embedding IS NULL
    ORDER BY d.imported_at ASC, c.ordinal ASC
  `).all();
}
/** Text of the named chunks, keyed by id; chunks deleted meanwhile are simply absent. */
function chunkTexts(handle, ids) {
	const texts = /* @__PURE__ */ new Map();
	for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
		const slice = ids.slice(start, start + LOOKUP_BATCH);
		const placeholders = slice.map(() => "?").join(", ");
		const rows = handle.db.prepare(`SELECT id, text FROM chunks WHERE id IN (${placeholders})`).all(...slice);
		for (const row of rows) texts.set(row.id, row.text);
	}
	return texts;
}
/** How many chunks are waiting for a vector. */
function countPendingChunks(handle) {
	const row = handle.db.prepare("SELECT COUNT(*) AS total FROM chunks WHERE embedding IS NULL").get();
	return row === void 0 ? 0 : row.total;
}
/** Store one vector. */
function setChunkEmbedding(handle, id, vector) {
	handle.db.prepare("UPDATE chunks SET embedding = ?, embedding_dim = ? WHERE id = ?").run(encodeVector(vector), vector.length, id);
}
/** Record which model produced the stored vectors. */
function recordEmbeddingModel(handle, model, dimensions) {
	writeMeta(handle, "embedding_model", model);
	writeMeta(handle, "embedding_dim", String(dimensions));
}
/** Drop every vector so the base can be re-embedded with a different model. */
function clearEmbeddings(handle) {
	const result = handle.db.prepare("UPDATE chunks SET embedding = NULL, embedding_dim = NULL WHERE embedding IS NOT NULL").run();
	handle.db.prepare("DELETE FROM meta WHERE key IN ('embedding_model', 'embedding_dim')").run();
	return Number(result.changes);
}

//#endregion
//#region src/host/embed/pipeline.ts
/** Kinds whose chunks are table rows. */
const SPREADSHEET_KINDS = new Set([
	"xlsx",
	"xls",
	"csv"
]);
/** How many reused vectors one run keeps in memory. */
const CACHE_LIMIT = 4096;
/**
* Text handed to the model: numbers of a table row become `#`, then the text is
* cut to `maxChars`. A chunk of prose keeps its numbers — there they are meaning.
*/
function embeddingKey(text, kind, options) {
	const masked = options.dedupeNumbers === true && SPREADSHEET_KINDS.has(kind) ? text.replace(/\d+/gu, "#") : text;
	const limit = options.maxChars ?? 0;
	return limit > 0 && masked.length > limit ? masked.slice(0, limit) : masked;
}
/**
* Embed the given chunks, sending one text per distinct key and writing that
* one vector to every chunk that shares the key.
*/
async function embedChunks(handle, embedder, items, options) {
	if (items.length === 0) return {
		embedded: 0,
		dimensions: 0
	};
	const keys = [];
	const slots = /* @__PURE__ */ new Map();
	const slotOf = [];
	const known = [];
	for (const item of items) {
		const key = embeddingKey(item.text, item.kind, options);
		let slot = slots.get(key);
		if (slot === void 0) {
			slot = keys.length;
			slots.set(key, slot);
			keys.push(key);
			known.push(options.cache?.get(key));
		}
		slotOf.push(slot);
	}
	const missing = keys.filter((_, index) => known[index] === void 0);
	const fresh = missing.length === 0 ? [] : await embedder.embed(missing, options.signal);
	if (fresh.length !== missing.length) throw new Error(`嵌入结果应有 ${missing.length} 条向量，实际 ${fresh.length} 条`);
	let next = 0;
	for (let index = 0; index < keys.length; index += 1) {
		if (known[index] !== void 0) continue;
		const vector = fresh[next];
		next += 1;
		if (vector === void 0) throw new Error(`嵌入结果缺少第 ${index + 1} 条向量`);
		known[index] = vector;
		const key = keys[index];
		if (options.cache !== void 0 && key !== void 0 && options.cache.size < CACHE_LIMIT) options.cache.set(key, vector);
	}
	withTransaction(handle, () => {
		items.forEach((item, index) => {
			const vector = known[slotOf[index] ?? -1];
			if (vector === void 0) throw new Error(`嵌入结果缺少第 ${index + 1} 条向量`);
			setChunkEmbedding(handle, item.id, vector);
		});
	});
	return {
		embedded: items.length,
		dimensions: known[0]?.length ?? 0
	};
}
/**
* Embed every pending chunk, returning how many were written. Throws when the
* embedding server fails; vectors already written stay in place.
*/
async function embedPending(handle, embedder, options) {
	const batchSize = Math.max(1, options.batchSize);
	const pending = pendingChunkIds(handle);
	const total = pending.length;
	let done = 0;
	let dimensions = 0;
	let cache;
	let cachedDocument = null;
	for (let start = 0; start < pending.length; start += batchSize) {
		if (options.signal?.aborted === true) break;
		const slice = pending.slice(start, start + batchSize);
		const documentId = slice[0]?.documentId ?? null;
		if (documentId !== cachedDocument) {
			cachedDocument = documentId;
			cache = void 0;
		}
		const texts = chunkTexts(handle, slice.map((chunk) => chunk.id));
		const items = [];
		for (const chunk of slice) {
			const text = texts.get(chunk.id);
			if (text === void 0) continue;
			if (cache === void 0 && options.dedupeNumbers === true && SPREADSHEET_KINDS.has(chunk.kind)) cache = /* @__PURE__ */ new Map();
			items.push({
				id: chunk.id,
				text,
				kind: chunk.kind
			});
		}
		const result = await embedChunks(handle, embedder, items, {
			...options,
			...cache === void 0 ? {} : { cache }
		});
		if (result.dimensions > 0) dimensions = result.dimensions;
		done += result.embedded;
		options.onProgress?.({
			done,
			total
		});
	}
	if (done > 0) recordEmbeddingModel(handle, embedder.model, dimensions);
	return done;
}

//#endregion
//#region src/host/embed/ollama.ts
function endpoint$1(baseURL, path) {
	return `${baseURL.replace(/\/+$/u, "")}${path}`;
}
function withTimeout(signal, milliseconds) {
	const timeout = AbortSignal.timeout(milliseconds);
	return signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
}
async function failure(response) {
	const body = await response.text().catch(() => "");
	const detail = body.trim() === "" ? response.statusText : body.trim().slice(0, 400);
	return new CyberSelfError(502, `Ollama 嵌入请求失败（${response.status}）：${detail}`);
}
/** Create an embedder for the configured endpoint and model. */
function createOllamaEmbedder(settings) {
	const embedURL = endpoint$1(settings.baseURL, "/api/embed");
	const tagsURL = endpoint$1(settings.baseURL, "/api/tags");
	/** Ask the endpoint which models it has; a silent endpoint yields no names. */
	const fetchInstalled = async (signal) => {
		const request = withTimeout(signal, Math.min(settings.timeoutMs, 5e3));
		let response;
		try {
			response = await fetch(tagsURL, { signal: request });
		} catch (error) {
			return {
				names: [],
				message: `连不上 Ollama（${settings.baseURL}）：${error instanceof Error ? error.message : String(error)}`
			};
		}
		if (!response.ok) return {
			names: [],
			message: `Ollama 返回 ${response.status}`
		};
		const names = ((await response.json()).models ?? []).flatMap((model) => [model.name, model.model]).filter((name$1) => typeof name$1 === "string");
		return {
			names: [...new Set(names)],
			message: null
		};
	};
	return {
		model: settings.model,
		async probe(signal) {
			const { names, message } = await fetchInstalled(signal);
			if (message !== null) return {
				ready: false,
				message
			};
			const wanted = settings.model;
			return names.includes(wanted) || names.includes(`${wanted}:latest`) || names.some((name$1) => name$1.split(":")[0] === wanted.split(":")[0]) ? {
				ready: true,
				message: null
			} : {
				ready: false,
				message: `Ollama 里没有模型 ${wanted}，请先 ollama pull ${wanted}`
			};
		},
		async models(signal) {
			const { names } = await fetchInstalled(signal);
			return names;
		},
		async embed(texts, signal) {
			const vectors = [];
			for (let start = 0; start < texts.length; start += settings.batchSize) {
				const batch = texts.slice(start, start + settings.batchSize);
				const request = withTimeout(signal, settings.timeoutMs);
				let response;
				try {
					response = await fetch(embedURL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model: settings.model,
							input: batch,
							truncate: true
						}),
						signal: request
					});
				} catch (error) {
					throw new CyberSelfError(502, `连不上 Ollama（${settings.baseURL}）：${error instanceof Error ? error.message : String(error)}`);
				}
				if (!response.ok) throw await failure(response);
				const embeddings = (await response.json()).embeddings ?? [];
				if (embeddings.length !== batch.length) throw new CyberSelfError(502, `Ollama 返回 ${embeddings.length} 条向量，应为 ${batch.length} 条`);
				for (const embedding of embeddings) {
					if (!Array.isArray(embedding) || embedding.length === 0) throw new CyberSelfError(502, `Ollama 返回了空向量，模型 ${settings.model} 不支持嵌入`);
					vectors.push(Float32Array.from(embedding));
				}
			}
			return vectors;
		}
	};
}

//#endregion
//#region src/host/parse/plain.ts
/** Split plain text into one block per blank-line-separated paragraph. */
function parseText(text) {
	return text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph !== "").map((paragraph) => ({
		text: paragraph,
		page: null,
		heading: null
	}));
}
/**
* Read Markdown into blocks, tracking the nearest heading so later chunks know
* which section they came from. Fenced code stays verbatim in one block.
*/
function parseMarkdown(text) {
	const blocks = [];
	let heading = null;
	let buffer = [];
	let fence = null;
	const flush = () => {
		const body = buffer.join("\n").trim();
		if (body !== "") blocks.push({
			text: body,
			page: null,
			heading
		});
		buffer = [];
	};
	for (const line of text.split(/\r?\n/u)) {
		const fenceMatch = /^\s*(```+|~~~+)/u.exec(line);
		if (fence !== null) {
			if (fenceMatch !== null && line.trim().startsWith(fence)) {
				fence = null;
				flush();
				continue;
			}
			buffer.push(line);
			continue;
		}
		if (fenceMatch !== null) {
			flush();
			fence = fenceMatch[1] ?? "```";
			continue;
		}
		const headingMatch = /^(#{1,6})\s+(.*)$/u.exec(line);
		if (headingMatch !== null) {
			flush();
			heading = (headingMatch[2] ?? "").replace(/#+\s*$/u, "").trim() || null;
			continue;
		}
		if (line.trim() === "") {
			flush();
			continue;
		}
		buffer.push(line);
	}
	flush();
	return blocks;
}

//#endregion
//#region src/host/parse/pool.ts
/**
* Bounded concurrency for work that waits on the model: PDF pages and the
* pictures inside a document are independent of each other, and transcribing
* them one at a time leaves the model idle between requests.
* @module cyberself/parse/pool
*/
/** Run one worker per item with at most `limit` in flight, keeping result order. */
async function mapWithConcurrency(items, limit, work) {
	const results = new Array(items.length);
	const workers = Math.max(1, Math.min(limit, items.length));
	let next = 0;
	const run = async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			const item = items[index];
			if (item === void 0) continue;
			results[index] = await work(item);
		}
	};
	await Promise.all(Array.from({ length: workers }, () => run()));
	return results;
}

//#endregion
//#region src/host/parse/docx.ts
const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]*\)/gu;
/** Parse a Word document into blocks. */
async function parseDocx(bytes, options) {
	const vision = options.vision;
	const pictures = [];
	const convertImage = images.imgElement(async (image) => {
		if (!options.ocr || vision === null) return { src: "" };
		const buffer = await image.read();
		pictures.push({
			bytes: new Uint8Array(buffer),
			mime: image.contentType === "" ? "image/png" : image.contentType,
			label: image.altText === void 0 ? "Word 文档中的图片" : `Word 文档中的图片：${image.altText}`,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		return { src: "" };
	});
	const blocks = parseMarkdown((await convertToMarkdown({ buffer: Buffer.from(bytes) }, { convertImage })).value.replace(IMAGE_MARKDOWN, ""));
	if (vision === null || pictures.length === 0) return blocks;
	const transcriptions = await mapWithConcurrency(pictures, options.concurrency, (request) => vision.transcribe(request));
	for (const transcription of transcriptions) {
		const text = transcription.trim();
		if (text !== "") blocks.push({
			text,
			page: null,
			heading: "文档内图片"
		});
	}
	return blocks;
}

//#endregion
//#region src/host/parse/encoding.ts
/**
* Text decoding for files that carry no encoding declaration: valid UTF-8 is
* read as UTF-8, and anything else is read as GBK, which is what the older
* Chinese documents in a working library are saved as.
* @module cyberself/parse/encoding
*/
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const GBK = new TextDecoder("gbk", { fatal: true });
const LOSSY = new TextDecoder("utf-8");
function attempt(decoder, bytes) {
	try {
		return decoder.decode(bytes);
	} catch {
		return null;
	}
}
/** Decode one text file, falling back to GBK when the bytes are not valid UTF-8. */
function decodeText(bytes) {
	const utf8 = attempt(UTF8, bytes);
	if (utf8 !== null) return utf8;
	const gbk = attempt(GBK, bytes);
	if (gbk !== null) return gbk;
	return LOSSY.decode(bytes);
}

//#endregion
//#region src/host/parse/html.ts
const DROPPED = "script, style, noscript, template, nav, header, footer, aside, form, iframe, svg, canvas, button";
const CONTENT_SELECTORS = [
	"article",
	"main",
	"[role=main]",
	".markdown-body",
	"#content",
	".content"
];
const BLOCK_TAGS = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"li",
	"blockquote",
	"pre",
	"dt",
	"dd"
]);
function textOf(raw) {
	return raw.replace(/[ \t\u00A0]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}
/** One line per table row, cells separated by a pipe, so a row stays a unit. */
function tableRows($, table) {
	const rows = [];
	for (const row of $(table).find("tr").toArray()) {
		const cells = [];
		for (const cell of $(row).children("th, td").toArray()) {
			const text = textOf($(cell).text());
			if (text !== "") cells.push(text);
		}
		if (cells.length > 0) rows.push(cells.join(" | "));
	}
	return rows;
}
/** Parse an HTML page into blocks, preferring a semantic content container. */
function parseHtml(html) {
	const $ = load(html);
	$(DROPPED).remove();
	let root = $("body");
	for (const selector of CONTENT_SELECTORS) {
		const candidate = $(selector).first();
		if (candidate.length > 0 && candidate.text().trim().length > 200) {
			root = candidate;
			break;
		}
	}
	const title = ($("title").first().text() || $("h1").first().text()).replace(/\s+/gu, " ").trim();
	const blocks = [];
	let heading = null;
	const walk = (parent) => {
		for (const node of parent.children) {
			if (!isTag(node)) continue;
			const tag = node.tagName.toLowerCase();
			if (tag === "table") {
				for (const row of tableRows($, node)) blocks.push({
					text: row,
					page: null,
					heading
				});
				continue;
			}
			if (!BLOCK_TAGS.has(tag)) {
				walk(node);
				continue;
			}
			const text = tag === "pre" ? $(node).text().trim() : textOf($(node).text());
			if (text === "") {
				walk(node);
				continue;
			}
			if (/^h[1-6]$/u.test(tag)) heading = text;
			blocks.push({
				text,
				page: null,
				heading
			});
		}
	};
	const start = root[0];
	if (start !== void 0) {
		if (isTag(start)) walk(start);
		else if (start.type === "root") walk(start);
	}
	return {
		title,
		blocks
	};
}

//#endregion
//#region src/host/parse/types.ts
/** Text shorter than this on a PDF page is treated as a scanned page. */
const SCANNED_PAGE_THRESHOLD = 40;

//#endregion
//#region src/host/parse/pdf.ts
/** Render scale that turns the configured dots per inch into PDF points. */
function renderScale(pdfDpi) {
	return Math.max(.5, pdfDpi / 72);
}
/** Read the abort flag through a call, so a value seen before an await is not reused. */
function aborted(signal) {
	return signal?.aborted === true;
}
/** Parse every page of a PDF into blocks carrying their page number. */
async function parsePdf(bytes, options) {
	const extracted = await extractText(new Uint8Array(bytes), { mergePages: false });
	const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
	const vision = options.vision;
	const slots = pages.map(() => null);
	const scanned = [];
	pages.forEach((page, index) => {
		const pageNumber = index + 1;
		const text = page.trim();
		if (text.length >= SCANNED_PAGE_THRESHOLD) {
			slots[index] = {
				text,
				page: pageNumber,
				heading: null
			};
			return;
		}
		if (!options.ocr || vision === null) {
			if (text !== "") slots[index] = {
				text,
				page: pageNumber,
				heading: null
			};
			return;
		}
		if (scanned.length < options.maxPages) scanned.push(pageNumber);
	});
	const render = async (pageNumber) => {
		try {
			return await renderPageAsImage(new Uint8Array(bytes), pageNumber, {
				canvasImport: () => import("@napi-rs/canvas"),
				scale: renderScale(options.pdfDpi)
			});
		} catch (error) {
			throw new CyberSelfError(500, `PDF 第 ${pageNumber} 页没有文字层，需要渲染成图片再转写，但这一步失败了：${error instanceof Error ? error.message : String(error)}`);
		}
	};
	if (vision !== null) await mapWithConcurrency(scanned, options.concurrency, async (pageNumber) => {
		if (aborted(options.signal)) return;
		const image = await render(pageNumber);
		if (aborted(options.signal)) return;
		const transcription = await vision.transcribe({
			bytes: new Uint8Array(image),
			mime: "image/png",
			label: `PDF 第 ${pageNumber} 页`,
			signal: options.signal
		});
		const merged = [(pages[pageNumber - 1] ?? "").trim(), transcription.trim()].filter((part) => part !== "").join("\n");
		if (merged !== "") slots[pageNumber - 1] = {
			text: merged,
			page: pageNumber,
			heading: null
		};
	});
	return slots.filter((block) => block !== null);
}

//#endregion
//#region src/host/parse/spreadsheet.ts
function cellText(value) {
	if (value === null || value === void 0) return "";
	return String(value).replace(/\s+/gu, " ").trim();
}
/**
* Parse an XLSX/XLS/CSV workbook into rows.
*
* A CSV arrives as text because the bytes are UTF-8 encoded by whoever wrote
* the file, and the workbook reader would otherwise decode them as a binary
* code page and mangle every non-ASCII character.
*/
function parseSpreadsheet(input) {
	const workbook = typeof input === "string" ? XLSX.read(input.replace(/^\uFEFF/u, ""), { type: "string" }) : XLSX.read(input, { type: "array" });
	const blocks = [];
	for (const sheetName of workbook.SheetNames) {
		const sheet = workbook.Sheets[sheetName];
		if (sheet === void 0) continue;
		const rows = XLSX.utils.sheet_to_json(sheet, {
			header: 1,
			raw: false,
			defval: "",
			blankrows: false
		});
		for (const row of rows) {
			const cells = row.map(cellText).filter((cell) => cell !== "");
			if (cells.length === 0) continue;
			blocks.push({
				text: cells.join(" | "),
				page: null,
				heading: sheetName
			});
		}
	}
	return blocks;
}

//#endregion
//#region src/host/parse/index.ts
/** File extensions the importer accepts, without the dot. */
const SUPPORTED_EXTENSIONS = [
	"pdf",
	"docx",
	"xlsx",
	"xls",
	"csv",
	"md",
	"markdown",
	"txt",
	"text",
	"log",
	"html",
	"htm",
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif"
];
const IMAGE_MIME = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif"
};
/** True when the file name carries an extension the importer handles. */
function isSupported(name$1) {
	return SUPPORTED_EXTENSIONS.includes(extname(name$1).replace(/^\./u, "").toLowerCase());
}
/** True when the file is read by the vision model rather than by a text parser. */
function isImageName(name$1) {
	return IMAGE_MIME[extname(name$1).replace(/^\./u, "").toLowerCase()] !== void 0;
}
function baseTitle(name$1) {
	const base = basename(name$1);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}
/**
* Parse one file.
*
* Failures are explicit: an unsupported extension and a document that yields no
* text both raise {@link CyberSelfError} with a message the UI can show as-is.
*/
async function parseFile(name$1, bytes, options) {
	const extension = extname(name$1).replace(/^\./u, "").toLowerCase();
	const title = baseTitle(name$1);
	let document;
	if (extension === "pdf") document = {
		kind: "pdf",
		title,
		blocks: await parsePdf(bytes, options)
	};
	else if (extension === "docx") document = {
		kind: "docx",
		title,
		blocks: await parseDocx(bytes, options)
	};
	else if (extension === "csv") document = {
		kind: extension,
		title,
		blocks: parseSpreadsheet(decodeText(bytes))
	};
	else if (extension === "xlsx" || extension === "xls") document = {
		kind: extension,
		title,
		blocks: parseSpreadsheet(bytes)
	};
	else if (extension === "md" || extension === "markdown") document = {
		kind: "markdown",
		title,
		blocks: parseMarkdown(decodeText(bytes))
	};
	else if (extension === "txt" || extension === "text" || extension === "log") document = {
		kind: "text",
		title,
		blocks: parseText(decodeText(bytes))
	};
	else if (extension === "html" || extension === "htm") {
		const parsed = parseHtml(decodeText(bytes));
		document = {
			kind: "html",
			title: parsed.title === "" ? title : parsed.title,
			blocks: parsed.blocks
		};
	} else if (IMAGE_MIME[extension] !== void 0) {
		if (options.vision === null) throw new CyberSelfError(422, "没有可用的视觉模型，无法读取图片里的文字");
		const transcription = await options.vision.transcribe({
			bytes,
			mime: IMAGE_MIME[extension],
			label: `图片 ${basename(name$1)}`,
			signal: options.signal
		});
		document = {
			kind: "image",
			title,
			blocks: transcription.trim() === "" ? [] : [{
				text: transcription.trim(),
				page: null,
				heading: null
			}]
		};
	} else throw new CyberSelfError(415, `不支持的文件类型：.${extension}`);
	const textBlocks = document.blocks.filter((block) => block.text.trim() !== "");
	if (textBlocks.length === 0) throw new CyberSelfError(422, `${basename(name$1)} 里没有读到任何文字`);
	return {
		...document,
		blocks: textBlocks
	};
}

//#endregion
//#region src/host/kb/text.ts
/** SHA-256 of raw bytes, lowercase hex. */
function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/** SHA-256 of a string, lowercase hex. */
function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
/** Collapse every whitespace run to one space and trim. */
function collapseWhitespace(text) {
	return text.replace(/\s+/g, " ").trim();
}
/**
* Form compared for deduplication: whitespace collapsed, case folded, and
* full-width punctuation folded to its ASCII counterpart so the same sentence
* copied from a PDF and from a web page hashes identically.
*/
function normalizeForHash(text) {
	return collapseWhitespace(text).replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 65248)).replace(/\u3000/g, " ").toLowerCase();
}
/** Split one paragraph into sentence-sized pieces, keeping terminators attached. */
function splitSentences(text) {
	return text.split(/(?<=[。！？；!?;\n])\s*/u).map((piece) => piece.trim()).filter((piece) => piece !== "");
}

//#endregion
//#region src/host/kb/chunking.ts
function emptyPending(heading, page) {
	return {
		parts: [],
		length: 0,
		page,
		heading
	};
}
/**
* Split one over-long paragraph into sentence-packed pieces, each at most
* `targetChars`, repeating the tail of the previous piece as `overlapChars`.
*/
function splitLongParagraph(paragraph, settings) {
	const pieces = [];
	let current = "";
	for (const sentence of splitSentences(paragraph)) {
		if (sentence.length > settings.targetChars) {
			if (current !== "") {
				pieces.push(current);
				current = "";
			}
			for (let offset = 0; offset < sentence.length; offset += settings.targetChars) pieces.push(sentence.slice(offset, offset + settings.targetChars));
			continue;
		}
		if (current !== "" && current.length + 1 + sentence.length > settings.targetChars) {
			pieces.push(current);
			const tail = current.slice(-settings.overlapChars);
			current = settings.overlapChars > 0 && tail !== "" ? `${tail} ${sentence}` : sentence;
		} else current = current === "" ? sentence : `${current} ${sentence}`;
	}
	if (current !== "") pieces.push(current);
	return pieces;
}
/**
* Pack parsed blocks into chunks.
*
* A heading change always closes the current chunk, so a chunk never mixes
* two sections; consecutive short blocks under the same heading are merged so
* that a bulleted list does not become a dozen one-line chunks.
*/
function chunkBlocks(blocks, settings) {
	const chunks = [];
	let pending = emptyPending(null, null);
	const flush = () => {
		const heading = pending.heading;
		const page = pending.page;
		if (pending.parts.length === 0) {
			pending = emptyPending(heading, null);
			return;
		}
		const text = pending.parts.join("\n");
		pending = emptyPending(heading, null);
		if (text.trim() === "") return;
		const previous = chunks[chunks.length - 1];
		if (previous !== void 0 && text.length < settings.minChars && previous.heading === heading && previous.text.length + text.length <= settings.targetChars * 2) {
			previous.text = `${previous.text}\n${text}`;
			previous.hash = sha256Text(normalizeForHash(previous.text));
			return;
		}
		chunks.push({
			text,
			hash: sha256Text(normalizeForHash(text)),
			ordinal: chunks.length,
			page,
			heading
		});
	};
	for (const block of blocks) {
		const paragraphs = block.text.split(/\n\s*\n/u);
		for (const rawParagraph of paragraphs) {
			const paragraph = collapseWhitespace(rawParagraph);
			if (paragraph === "") continue;
			if (pending.heading !== block.heading) {
				flush();
				pending.heading = block.heading;
			}
			if (pending.parts.length === 0) pending.page = block.page;
			if (paragraph.length > settings.targetChars) {
				for (const piece of splitLongParagraph(paragraph, settings)) {
					if (pending.parts.length > 0) {
						flush();
						pending.heading = block.heading;
						pending.page = block.page;
					}
					pending.parts.push(piece);
					pending.length = piece.length;
					flush();
				}
				pending.heading = block.heading;
				continue;
			}
			if (pending.length > 0 && pending.length + 1 + paragraph.length > settings.targetChars) {
				flush();
				pending.heading = block.heading;
				pending.page = block.page;
			}
			pending.parts.push(paragraph);
			pending.length += paragraph.length + 1;
		}
	}
	flush();
	return chunks.map((chunk, ordinal) => ({
		...chunk,
		ordinal
	}));
}

//#endregion
//#region src/host/kb/import.ts
/** Largest file the importer accepts. */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
function renumber(chunks) {
	return chunks.map((chunk, ordinal) => ({
		...chunk,
		ordinal
	}));
}
/** Import one file into the knowledge base. */
async function importFile(handle, input, deps) {
	const startedAt = Date.now();
	if (input.bytes.byteLength > MAX_IMPORT_BYTES) throw new CyberSelfError(413, `${input.name} 超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB，无法导入`);
	const fileHash = sha256Bytes(input.bytes);
	const existingId = findDocumentByHash(handle, fileHash);
	if (existingId !== null) return {
		document: getDocument(handle, existingId),
		duplicateOf: existingId,
		chunksKept: 0,
		chunksDropped: 0,
		elapsedMs: Date.now() - startedAt,
		note: "这个文件已经导入过"
	};
	deps.onProgress?.({
		phase: "parse",
		done: 0,
		total: 1
	});
	const parsed = await parseFile(input.name, input.bytes, {
		ocr: deps.config.ocr.enabled,
		pdfDpi: deps.config.ocr.pdfDpi,
		maxPages: deps.config.ocr.maxPages,
		concurrency: deps.config.ocr.concurrency,
		vision: deps.vision,
		signal: deps.signal
	});
	const produced = chunkBlocks(parsed.blocks, deps.config.chunking);
	if (produced.length === 0) throw new CyberSelfError(422, `${input.name} 分块后没有内容`);
	const known = findChunkHashes(handle, produced.map((chunk) => chunk.hash));
	const kept = [];
	let dropped = 0;
	for (const chunk of produced) {
		if (known.has(chunk.hash)) {
			dropped += 1;
			continue;
		}
		known.add(chunk.hash);
		kept.push(chunk);
	}
	if (kept.length === 0) return {
		document: null,
		duplicateOf: null,
		chunksKept: 0,
		chunksDropped: dropped,
		elapsedMs: Date.now() - startedAt,
		note: "这个文件的内容都已经在资料库里了"
	};
	const documentId = `doc-${fileHash.slice(0, 16)}`;
	const chunks = renumber(kept);
	deps.onProgress?.({
		phase: "write",
		done: 0,
		total: 1
	});
	withTransaction(handle, () => {
		insertDocument(handle, {
			id: documentId,
			title: parsed.title,
			path: input.sourcePath,
			kind: parsed.kind,
			bytes: input.bytes.byteLength,
			sha256: fileHash,
			importedAt: Date.now()
		});
		insertChunks(handle, documentId, chunks, chunks.map(() => null));
	});
	return {
		document: getDocument(handle, documentId),
		duplicateOf: null,
		chunksKept: chunks.length,
		chunksDropped: dropped,
		elapsedMs: Date.now() - startedAt,
		note: null
	};
}

//#endregion
//#region src/host/kb/search.ts
/** How many candidates each half contributes to the fusion. */
const CANDIDATES = 80;
/** Rank fusion damping; the usual value from the original RRF paper. */
const RRF_K = 60;
function cosine(left, right) {
	if (left.length !== right.length) return 0;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	if (leftNorm === 0 || rightNorm === 0) return 0;
	return dot / Math.sqrt(leftNorm * rightNorm);
}
/**
* Terms handed to the trigram index: latin words of two characters or more,
* and every three-character window of a Han run. Trigram indexes cannot match
* shorter text, so a two-character run is left out instead of widening the
* query into noise.
*/
function keywordTerms(text) {
	const terms = [];
	const seen = /* @__PURE__ */ new Set();
	const add = (term) => {
		const key = term.toLowerCase();
		if (key === "" || seen.has(key)) return;
		seen.add(key);
		terms.push(key);
	};
	for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_+-]*/gu)) if (match[0].length >= 2) add(match[0]);
	for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
		const run = match[0];
		for (let offset = 0; offset + 3 <= run.length; offset += 1) add(run.slice(offset, offset + 3));
	}
	return terms.slice(0, 24);
}
/** Build the FTS5 MATCH expression for a query, or null when nothing is indexable. */
function ftsExpression(text) {
	const terms = keywordTerms(text);
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term.replace(/"/gu, "\"\"")}"`).join(" OR ");
}
function scanVectors(handle, query, floor) {
	const statement = handle.db.prepare("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL");
	const scored = [];
	for (const row of statement.iterate()) {
		const score = cosine(query, decodeVector(row.embedding));
		if (score >= floor) scored.push({
			id: row.id,
			score
		});
	}
	scored.sort((left, right) => right.score - left.score);
	return scored.slice(0, CANDIDATES);
}
function scanKeywords(handle, text) {
	const expression = ftsExpression(text);
	if (expression === null) return [];
	const rows = handle.db.prepare(`
    SELECT chunks_fts.rowid AS rowid, bm25(chunks_fts) AS rank
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(expression, CANDIDATES);
	const lookup = handle.db.prepare("SELECT id FROM chunks WHERE rowid = ?");
	const scored = [];
	for (const row of rows) {
		const found = lookup.get(row.rowid);
		if (found === void 0) continue;
		scored.push({
			id: found.id,
			score: -row.rank
		});
	}
	return scored;
}
function loadChunk(handle, id) {
	const row = handle.db.prepare(`
    SELECT c.id, c.document_id, d.title, d.path, c.ordinal, c.text, c.page, c.heading, c.embedding
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.id = ?
  `).get(id);
	if (row === void 0) return null;
	return {
		id: row.id,
		documentId: row.document_id,
		title: row.title,
		path: row.path,
		ordinal: row.ordinal,
		text: row.text,
		page: row.page,
		heading: row.heading,
		embedding: row.embedding === null ? null : decodeVector(row.embedding)
	};
}
/**
* Fuse both halves and apply the per-document cap, so one long document cannot
* fill every slot. `query` may carry a null vector: keyword search still runs.
*/
function retrieve(handle, input, limits) {
	const vectorList = input.vector === null ? [] : scanVectors(handle, input.vector, limits.minScore);
	const keywordList = scanKeywords(handle, input.text);
	const fused = /* @__PURE__ */ new Map();
	const merge = (list, fromVector) => {
		list.forEach((item, rank) => {
			const contribution = 1 / (RRF_K + rank + 1);
			const existing = fused.get(item.id);
			if (existing === void 0) {
				fused.set(item.id, {
					score: contribution,
					fromVector,
					fromKeyword: !fromVector
				});
				return;
			}
			existing.score += contribution;
			existing.fromVector ||= fromVector;
			existing.fromKeyword ||= !fromVector;
		});
	};
	merge(vectorList, true);
	merge(keywordList, false);
	const ordered = [...fused.entries()].map(([id, value]) => ({
		id,
		...value
	})).sort((left, right) => right.score - left.score);
	const perDocument = /* @__PURE__ */ new Map();
	const hits = [];
	for (const entry of ordered) {
		if (hits.length >= limits.topK) break;
		const chunk = loadChunk(handle, entry.id);
		if (chunk === null) continue;
		const used = perDocument.get(chunk.documentId) ?? 0;
		if (used >= limits.perDocument) continue;
		perDocument.set(chunk.documentId, used + 1);
		hits.push({
			chunk,
			score: entry.score,
			fromVector: entry.fromVector,
			fromKeyword: entry.fromKeyword
		});
	}
	return {
		hits,
		vectorHits: vectorList.length,
		keywordHits: keywordList.length
	};
}
/** Number the retrieved chunks in ranking order, which is what the prompt cites. */
function materializeCitations(hits) {
	return hits.map((hit, index) => ({
		index: index + 1,
		chunkId: hit.chunk.id,
		documentId: hit.chunk.documentId,
		title: hit.chunk.title,
		path: hit.chunk.path,
		page: hit.chunk.page,
		heading: hit.chunk.heading,
		text: hit.chunk.text,
		score: Math.round(hit.score * 1e3) / 1e3
	}));
}

//#endregion
//#region src/host/kb/usage.ts
/** Files that carry a library: the database itself, its log and its shards. */
const DATA_PREFIX = "kb.db";
/** Measures the files of one library without creating anything. */
function measureLibrary(dir) {
	const location = locateKb(dir);
	const usage = {
		file: location.file,
		bytes: 0,
		updatedAt: null
	};
	if (!existsSync(location.root)) return usage;
	for (const entry of readdirSync(location.root)) {
		if (!entry.startsWith(DATA_PREFIX)) continue;
		const stat$1 = statSync(join(location.root, entry), { throwIfNoEntry: false });
		if (stat$1 === void 0) continue;
		usage.bytes += stat$1.size;
		if (usage.updatedAt === null || stat$1.mtimeMs > usage.updatedAt) usage.updatedAt = stat$1.mtimeMs;
	}
	return usage;
}

//#endregion
//#region src/host/settings.ts
/** File name of the per-workspace marker inside {@link KB_DIRECTORY}. */
const MARKER_FILE = "config.json";
/** Schema version written into every file this module owns. */
const FORMAT_VERSION = 1;
/** Root of the DSH home that owns the global settings file. */
function dshHome() {
	const configured = process.env.DSH_HOME;
	return configured === void 0 || configured === "" ? join(homedir(), ".dsh") : configured;
}
/** Absolute path of the global settings file. */
function settingsFile() {
	return join(dshHome(), "cyberself", "settings.json");
}
function readJsonFile(file) {
	if (!existsSync(file)) return {};
	const text = readFileSync(file, "utf8");
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
		return parsed;
	} catch {
		throw new CyberSelfError(500, `设置文件不是合法的 JSON：${file}`);
	}
}
function writeJsonFile(file, value) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, file);
}
/** Embedding overrides saved so far; empty when nothing was saved yet. */
function readEmbeddingSettings() {
	return readJsonFile(settingsFile()).embedding ?? {};
}
/** Merge embedding overrides into the settings file and return the new state. */
function writeEmbeddingSettings(patch) {
	const file = settingsFile();
	const current = readJsonFile(file);
	const merged = {
		...current.embedding,
		...patch
	};
	writeJsonFile(file, {
		...current,
		version: FORMAT_VERSION,
		embedding: merged
	});
	return merged;
}
/** Absolute path of the marker that declares a workspace a library. */
function libraryMarker(dir) {
	return join(dir, KB_DIRECTORY, MARKER_FILE);
}
/** True when the workspace carries the library marker. */
function isLibraryWorkspace(dir) {
	const file = libraryMarker(dir);
	if (!existsSync(file)) return false;
	return readJsonFile(file).library !== false;
}
/** How far the model may reach beyond this library; a workspace without the marker defaults to `library`. */
function libraryScope(dir) {
	const file = libraryMarker(dir);
	if (!existsSync(file)) return "library";
	return readJsonFile(file).scope === "open" ? "open" : "library";
}
/** Turn a workspace into a library, or drop the marker while keeping the database. */
function setLibraryWorkspace(dir, library, scope) {
	const file = libraryMarker(dir);
	if (library) {
		const current = existsSync(file) ? readJsonFile(file) : {};
		const next = scope ?? (current.scope === "open" ? "open" : "library");
		writeJsonFile(file, {
			...current,
			version: FORMAT_VERSION,
			library: true,
			scope: next
		});
		return;
	}
	if (existsSync(file)) rmSync(file);
}

//#endregion
//#region src/host/service.ts
/** How long an embedding health answer is reused. */
const HEALTH_TTL_MS = 3e4;
/** Documents larger than this are refused before the payload is decoded. */
const MAX_BASE64_CHARS = Math.ceil(MAX_IMPORT_BYTES * 4 / 3);
/** Directories never walked when scanning a folder for importable files. */
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	".git",
	".cyberself",
	"dist",
	"build",
	"lib"
]);
/** Smallest accepted embedding request timeout. */
const MIN_TIMEOUT_MS = 1e3;
/** Largest accepted embedding request timeout. */
const MAX_TIMEOUT_MS = 6e5;
/** Largest accepted embedding batch. */
const MAX_BATCH_SIZE = 64;
/** Largest accepted character budget per embedded chunk. */
const MAX_EMBED_CHARS = 8e3;
function isDirectory(target) {
	return stat(target).then((info) => info.isDirectory(), () => false);
}
function requireInteger(input, field, min, max) {
	if (typeof input !== "number" || !Number.isInteger(input) || input < min || input > max) throw new CyberSelfError(400, `${field} 必须是 ${min} 到 ${max} 之间的整数`);
	return input;
}
/**
* Validate the embedding part of a settings request.
* @param input - the raw `embedding` member of the request body.
* @returns only the fields that were present and valid.
*/
function parseEmbeddingPatch(input) {
	if (input === void 0) return {};
	if (input === null || typeof input !== "object") throw new CyberSelfError(400, "embedding 必须是对象");
	const body = input;
	const patch = {};
	if (body.baseURL !== void 0) {
		if (typeof body.baseURL !== "string" || !/^https?:\/\//u.test(body.baseURL)) throw new CyberSelfError(400, "baseURL 必须是以 http:// 或 https:// 开头的地址");
		patch.baseURL = body.baseURL.replace(/\/+$/u, "");
	}
	if (body.model !== void 0) {
		if (typeof body.model !== "string" || body.model.trim() === "") throw new CyberSelfError(400, "model 不能为空");
		patch.model = body.model.trim();
	}
	if (body.timeoutMs !== void 0) patch.timeoutMs = requireInteger(body.timeoutMs, "timeoutMs", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
	if (body.batchSize !== void 0) patch.batchSize = requireInteger(body.batchSize, "batchSize", 1, MAX_BATCH_SIZE);
	if (body.maxChars !== void 0) patch.maxChars = requireInteger(body.maxChars, "maxChars", 0, MAX_EMBED_CHARS);
	if (body.dedupeNumbers !== void 0) {
		if (typeof body.dedupeNumbers !== "boolean") throw new CyberSelfError(400, "dedupeNumbers 必须是布尔值");
		patch.dedupeNumbers = body.dedupeNumbers;
	}
	return patch;
}
/** The plugin's operations over every library it has opened. */
var CyberSelf = class {
	deps;
	handles = /* @__PURE__ */ new Map();
	storedEmbedding;
	health = null;
	/** Background embedding runs, one per library directory. */
	jobs = /* @__PURE__ */ new Map();
	/** Completion of the run in {@link jobs}, so callers can wait for it. */
	runs = /* @__PURE__ */ new Map();
	aborters = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
		this.storedEmbedding = deps.readEmbeddingSettings();
	}
	/** Close every open database. */
	dispose() {
		for (const abort of this.aborters.values()) abort.abort();
		this.aborters.clear();
		this.jobs.clear();
		this.runs.clear();
		for (const handle of this.handles.values()) closeKb(handle);
		this.handles.clear();
	}
	/** Effective embedding settings: the profile configuration overridden by the settings page. */
	embeddingSettings() {
		return {
			...this.deps.config().embedding,
			...this.storedEmbedding
		};
	}
	embedder() {
		return createOllamaEmbedder(this.embeddingSettings());
	}
	/** State of the background run for one library. */
	embeddingProgress(dir) {
		const job = this.jobs.get(dir);
		if (job === void 0) return {
			running: false,
			done: 0,
			total: 0,
			error: null
		};
		return {
			running: job.running,
			done: job.done,
			total: job.total,
			error: job.error
		};
	}
	/**
	* Start the background run that fills in missing vectors. One run per library:
	* a second call while it is working is a no-op, and the run keeps going after
	* the request that started it has answered.
	*/
	startEmbedding(dir) {
		if (this.jobs.get(dir)?.running === true) return;
		const job = {
			running: true,
			done: 0,
			total: 0,
			error: null
		};
		this.jobs.set(dir, job);
		const run = this.runEmbedding(dir, job);
		this.runs.set(dir, run);
		run.then(() => {
			if (this.runs.get(dir) === run) this.runs.delete(dir);
		});
	}
	async runEmbedding(dir, job) {
		const handle = this.kb(dir);
		const abort = new AbortController();
		this.aborters.set(dir, abort);
		try {
			for (;;) {
				if (abort.signal.aborted) break;
				const settings = this.embeddingSettings();
				const stored = readMeta(handle, "embedding_model");
				if (stored !== null && stored !== settings.model) clearEmbeddings(handle);
				if (await embedPending(handle, this.embedder(), {
					batchSize: settings.batchSize,
					maxChars: settings.maxChars,
					dedupeNumbers: settings.dedupeNumbers,
					signal: abort.signal,
					onProgress: (progress) => {
						job.done = progress.done;
						job.total = progress.total;
					}
				}) === 0) break;
			}
		} catch (error) {
			job.error = error instanceof Error ? error.message : String(error);
		} finally {
			job.running = false;
			this.aborters.delete(dir);
		}
	}
	/** Workspaces the Host knows about, each flagged with its library marker and its answer scope. */
	choices() {
		return this.deps.listWorkspaces().map((workspace) => ({
			...workspace,
			library: isLibraryWorkspace(workspace.path),
			scope: libraryScope(workspace.path)
		}));
	}
	/**
	* Canonicalize a requested directory and refuse anything that is not a
	* registered workspace: a library only exists inside a workspace.
	*/
	resolveDir(input) {
		if (input.trim() === "") throw new CyberSelfError(400, "缺少工作区目录");
		const absolute = resolve(input);
		let canonical;
		try {
			canonical = realpathSync(absolute);
		} catch {
			throw new CyberSelfError(404, `目录不存在：${absolute}`);
		}
		if (!this.deps.listWorkspaces().some((workspace) => workspace.path === canonical)) throw new CyberSelfError(403, `不是已注册的工作区：${canonical}`);
		return canonical;
	}
	/** Refuse library operations in a workspace that was never turned into one. */
	requireLibrary(dir) {
		const canonical = this.resolveDir(dir);
		if (!isLibraryWorkspace(canonical)) throw new CyberSelfError(409, `这个工作区还不是资料库：${canonical}`);
		return canonical;
	}
	/** Open (or reuse) the database of a canonical workspace directory. */
	kb(dir) {
		const existing = this.handles.get(dir);
		if (existing !== void 0) return existing;
		const handle = openKb(dir);
		this.handles.set(dir, handle);
		return handle;
	}
	/** True when the directory carries the library marker; used by the session policy. */
	isLibrary(dir) {
		return isLibraryWorkspace(resolve(dir));
	}
	/** How far the model may reach beyond this library; used by the session policy. */
	scopeOf(dir) {
		return libraryScope(resolve(dir));
	}
	/** Counts of the library in this directory, or null when it is not a library. */
	librarySummary(dir) {
		const canonical = resolve(dir);
		if (!isLibraryWorkspace(canonical)) return null;
		return libraryStats(this.kb(canonical));
	}
	/** Turn a workspace into a library, or drop the marker while keeping the database. */
	mark(dirInput, library, scope) {
		const dir = this.resolveDir(dirInput);
		setLibraryWorkspace(dir, library, scope);
		return {
			dir,
			library,
			scope: libraryScope(dir)
		};
	}
	async embeddingHealth() {
		const settings = this.embeddingSettings();
		const key = `${settings.baseURL}|${settings.model}`;
		const now = Date.now();
		if (this.health !== null && this.health.key === key && now - this.health.at < HEALTH_TTL_MS) return this.health;
		this.health = {
			key,
			at: now,
			...await this.embedder().probe()
		};
		return this.health;
	}
	/** Header state plus the document list; a workspace without the marker reports empty. */
	async library(dirInput) {
		const dir = this.resolveDir(dirInput);
		const scope = libraryScope(dir);
		if (!isLibraryWorkspace(dir)) return {
			dir,
			library: false,
			scope,
			stats: null,
			documents: []
		};
		const handle = this.kb(dir);
		const counts = libraryStats(handle);
		const stored = readMeta(handle, "embedding_model");
		const health = await this.embeddingHealth();
		const failed = (this.jobs.get(dir)?.error ?? null) !== null;
		if (counts.chunks > counts.embedded && !failed) this.startEmbedding(dir);
		return {
			dir,
			library: true,
			scope,
			stats: {
				dir,
				documents: counts.documents,
				chunks: counts.chunks,
				embedded: counts.embedded,
				configuredModel: this.embeddingSettings().model,
				embeddingModel: stored === null ? "" : stored,
				embeddingReady: health.ready,
				embedding: this.embeddingProgress(dir),
				...measureLibrary(dir)
			},
			documents: listDocuments(handle)
		};
	}
	/** One document with its first chunks, for the detail view. */
	async detail(dirInput, id) {
		const dir = this.requireLibrary(dirInput);
		const handle = this.kb(dir);
		const document = getDocument(handle, id);
		if (document === null) throw new CyberSelfError(404, `没有这个文档：${id}`);
		return {
			document,
			chunks: listChunks(handle, id, 200)
		};
	}
	async citations(dir, text) {
		const handle = this.kb(dir);
		const health = await this.embeddingHealth();
		const counts = libraryStats(handle);
		const stored = readMeta(handle, "embedding_model");
		const model = this.embeddingSettings().model;
		let vector = null;
		let note = health.message;
		if (!health.ready) note = `${health.message ?? "嵌入服务不可用"}，这次只用关键词检索`;
		else if (counts.embedded === 0) note = "资料库里还没有向量，这次只用关键词检索";
		else if (stored !== null && stored !== model) note = `资料库的向量来自 ${stored}，与当前模型 ${model} 不同，这次只用关键词检索`;
		else {
			const [embedding] = await this.embedder().embed([text]);
			vector = embedding ?? null;
		}
		const retrieval = retrieve(handle, {
			text,
			vector
		}, this.deps.config().retrieval);
		const citations = materializeCitations(retrieval.hits);
		return {
			query: text,
			citations,
			vectorHits: retrieval.vectorHits,
			keywordHits: retrieval.keywordHits,
			note: citations.length === 0 && note === null ? "资料库里没有匹配的内容" : note
		};
	}
	/** Retrieval only, used by the tools and the search box. */
	async search(dirInput, text) {
		const dir = this.requireLibrary(dirInput);
		const query = text.trim();
		if (query === "") throw new CyberSelfError(400, "缺少查询内容");
		return this.citations(dir, query);
	}
	/** Retrieve, then answer. An empty retrieval never reaches the model. */
	async ask(input) {
		const dir = this.requireLibrary(input.dir);
		const question = input.question.trim();
		if (question === "") throw new CyberSelfError(400, "缺少问题");
		const found = await this.citations(dir, question);
		if (found.citations.length === 0) throw new CyberSelfError(422, `${found.note ?? "资料库里没有相关内容"}，请先导入相关资料再提问`);
		const llm = this.deps.llm;
		if (llm === null) throw new CyberSelfError(503, "没有可用的模型服务，无法生成回答");
		return answerQuestion(llm, this.deps.route(), {
			question,
			citations: found.citations,
			settings: this.deps.config().answer,
			maxEvidenceChars: this.deps.config().retrieval.maxEvidenceChars,
			signal: input.signal,
			...input.onToken === void 0 ? {} : { onToken: input.onToken }
		});
	}
	/** Import one file from an absolute Host path. */
	async importFromPath(dirInput, filePath, onProgress) {
		const dir = this.requireLibrary(dirInput);
		const absolute = resolve(filePath);
		const info = await stat(absolute).catch(() => null);
		if (info === null || !info.isFile()) throw new CyberSelfError(404, `文件不存在：${absolute}`);
		if (!isSupported(absolute)) throw new CyberSelfError(415, `不支持的文件类型：${basename(absolute)}`);
		const bytes = await readFile(absolute);
		const view = await importFile(this.kb(dir), {
			sourcePath: absolute,
			name: basename(absolute),
			bytes
		}, {
			config: this.deps.config(),
			vision: this.visionGrab(),
			...onProgress === void 0 ? {} : { onProgress }
		});
		if (view.document !== null) this.startEmbedding(dir);
		return view;
	}
	/** Import one uploaded file sent as base64. */
	async importUpload(dirInput, name$1, data, onProgress) {
		const dir = this.requireLibrary(dirInput);
		if (data.length > MAX_BASE64_CHARS) throw new CyberSelfError(413, `${name$1} 超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB，无法导入`);
		if (!isSupported(name$1)) throw new CyberSelfError(415, `不支持的文件类型：${name$1}`);
		const bytes = Buffer.from(data, "base64");
		const view = await importFile(this.kb(dir), {
			sourcePath: name$1,
			name: name$1,
			bytes
		}, {
			config: this.deps.config(),
			vision: this.visionGrab(),
			...onProgress === void 0 ? {} : { onProgress }
		});
		if (view.document !== null) this.startEmbedding(dir);
		return view;
	}
	/**
	* List importable files under a Host directory, so the UI can show what an
	* import would cost before the model starts working through it.
	*/
	async scan(dirInput, path) {
		this.requireLibrary(dirInput);
		const root = resolve(path);
		if (!await isDirectory(root)) throw new CyberSelfError(404, `目录不存在：${root}`);
		const files = [];
		const skipped = [];
		let totalBytes = 0;
		let images$1 = 0;
		const walk = async (current) => {
			const entries = await readdir(current, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const full = join(current, entry.name);
				if (entry.isDirectory()) {
					if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
					await walk(full);
					continue;
				}
				if (!entry.isFile()) continue;
				const extension = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
				if (!SUPPORTED_EXTENSIONS.includes(extension)) {
					skipped.push(full);
					continue;
				}
				files.push(full);
				totalBytes += (await stat(full)).size;
				if (isImageName(entry.name)) images$1 += 1;
			}
		};
		await walk(root);
		files.sort();
		return {
			files,
			skipped,
			totalBytes,
			images: images$1
		};
	}
	/** Remove a document and its chunks, then return the freed disk space. */
	async removeDocument(dirInput, id) {
		const dir = this.requireLibrary(dirInput);
		const handle = this.kb(dir);
		const deleted = deleteDocument(handle, id);
		if (!deleted) throw new CyberSelfError(404, `没有这个文档：${id}`);
		reclaimSpace(handle);
		return { deleted };
	}
	/** Remove every document of one library; the marker and the settings stay. */
	async purge(dirInput) {
		const dir = this.requireLibrary(dirInput);
		const before = measureLibrary(dir);
		const handle = this.kb(dir);
		const removed = purgeDocuments(handle);
		reclaimSpace(handle);
		const after = measureLibrary(dir);
		this.jobs.delete(dir);
		return {
			dir,
			removed,
			reclaimed: Math.max(0, before.bytes - after.bytes)
		};
	}
	/**
	* Delete one library together with its files: the database, the vectors and
	* the marker that made the workspace a library.
	*/
	forget(dirInput) {
		const dir = this.resolveDir(dirInput);
		const handle = this.handles.get(dir);
		if (handle !== void 0) {
			closeKb(handle);
			this.handles.delete(dir);
		}
		this.jobs.delete(dir);
		const location = locateKb(dir);
		const existed = existsSync(location.root);
		rmSync(location.root, {
			recursive: true,
			force: true
		});
		return {
			dir,
			removed: existed
		};
	}
	/** Every library on disk, with the space it occupies. */
	storage() {
		const libraries = [];
		for (const workspace of this.deps.listWorkspaces()) {
			const dir = workspace.path;
			if (!isLibraryWorkspace(dir)) continue;
			const usage = measureLibrary(dir);
			const counts = existsSync(usage.file) ? libraryStats(this.kb(dir)) : {
				documents: 0,
				chunks: 0,
				embedded: 0
			};
			libraries.push({
				dir,
				title: workspace.title,
				scope: libraryScope(dir),
				documents: counts.documents,
				chunks: counts.chunks,
				embedded: counts.embedded,
				bytes: usage.bytes,
				file: usage.file,
				updatedAt: usage.updatedAt
			});
		}
		const totals = libraries.reduce((sum, library) => ({
			libraries: sum.libraries + 1,
			documents: sum.documents + library.documents,
			chunks: sum.chunks + library.chunks,
			embedded: sum.embedded + library.embedded,
			bytes: sum.bytes + library.bytes
		}), {
			libraries: 0,
			documents: 0,
			chunks: 0,
			embedded: 0,
			bytes: 0
		});
		return {
			root: KB_DIRECTORY,
			settingsFile: settingsFile(),
			libraries,
			totals
		};
	}
	/**
	* Start embedding every chunk that lacks a vector, after a model change for
	* example. The run continues in the background; its progress is reported by
	* {@link library}.
	*/
	async embedMissing(dirInput) {
		const dir = this.requireLibrary(dirInput);
		const handle = this.kb(dir);
		const stored = readMeta(handle, "embedding_model");
		if (stored !== null && stored !== this.embeddingSettings().model) clearEmbeddings(handle);
		const remaining = countPendingChunks(handle);
		if (this.jobs.get(dir)?.running !== true) {
			this.jobs.delete(dir);
			this.startEmbedding(dir);
		}
		return { remaining };
	}
	/** Wait until the background run of one library has nothing left to do. */
	async waitForEmbedding(dirInput) {
		const dir = this.resolveDir(dirInput);
		await this.runs.get(dir);
	}
	/** Current settings, plus whether the embedding endpoint answers right now. */
	async settings() {
		const embedding = this.embeddingSettings();
		this.health = null;
		const probe = await this.embedder().probe();
		const installed = await this.embedder().models();
		return {
			embedding: {
				baseURL: embedding.baseURL,
				model: embedding.model,
				timeoutMs: embedding.timeoutMs,
				batchSize: embedding.batchSize,
				maxChars: embedding.maxChars,
				dedupeNumbers: embedding.dedupeNumbers,
				reachable: probe.ready,
				note: probe.message,
				installed
			},
			workspaces: this.choices(),
			file: settingsFile()
		};
	}
	/** Persist embedding overrides, then report the state that took effect. */
	async saveSettings(patch) {
		if (Object.keys(patch).length > 0) {
			const previous = this.embeddingSettings();
			const next = {
				...previous,
				...patch
			};
			const rebuilt = next.model !== previous.model || next.maxChars !== previous.maxChars || next.dedupeNumbers !== previous.dedupeNumbers;
			if (rebuilt) {
				const probe = await createOllamaEmbedder(next).probe();
				if (!probe.ready) throw new CyberSelfError(409, `设置没有保存：改完要重建全部向量，而新的嵌入服务现在不可用（${probe.message ?? "探测失败"}）`);
			}
			this.storedEmbedding = this.deps.writeEmbeddingSettings(patch);
			this.health = null;
			for (const dir of [...this.jobs.keys()]) if (this.jobs.get(dir)?.running !== true) this.jobs.delete(dir);
			if (rebuilt) for (const [dir, handle] of this.handles) {
				clearEmbeddings(handle);
				this.startEmbedding(dir);
			}
		}
		return this.settings();
	}
	visionGrab() {
		return this.deps.llm === null || this.deps.attachments === null ? null : createVisionTranscriber(this.deps.llm, this.deps.attachments, () => this.deps.route(), () => this.deps.config().ocr);
	}
};

//#endregion
//#region src/host/routes.ts
/** Largest JSON body accepted on ordinary endpoints. */
const MAX_JSON_BYTES = 1024 * 1024;
/** Largest upload payload accepted. */
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024;
function endpoint(name$1) {
	return `${API_PREFIX}/${name$1}`;
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
/** Read the whole request body, refusing anything above the limit. */
async function readBody(req, limit) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		total += buffer.length;
		if (total > limit) throw new CyberSelfError(413, "请求内容超过限制");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req, limit = MAX_JSON_BYTES) {
	const text = await readBody(req, limit);
	if (text === "") throw new CyberSelfError(400, "请求内容为空");
	try {
		return JSON.parse(text);
	} catch {
		throw new CyberSelfError(400, "请求内容不是合法的 JSON");
	}
}
function requirePost(req) {
	if (req.method !== "POST") throw new CyberSelfError(405, "只接受 POST 请求");
}
function requireString(value, field) {
	if (typeof value !== "string" || value.trim() === "") throw new CyberSelfError(400, `缺少 ${field}`);
	return value;
}
function requireBoolean(value, field) {
	if (typeof value !== "boolean") throw new CyberSelfError(400, `${field} 必须是布尔值`);
	return value;
}
function requireScope(value) {
	if (value === void 0) return void 0;
	if (value !== "library" && value !== "open") throw new CyberSelfError(400, "scope 只能是 library 或 open");
	return value;
}
/** Start an event stream and return its writer. */
function openStream(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no"
	});
	res.flushHeaders();
	return (event) => {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	};
}
function messageOf(error) {
	if (error instanceof CyberSelfError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}
function statusOf(error) {
	return error instanceof CyberSelfError ? error.status : 500;
}
function guarded(deps, res, work, failStream) {
	work().catch((error) => {
		if (statusOf(error) === 500) deps.report(error);
		if (res.headersSent) {
			failStream?.({
				kind: "error",
				message: messageOf(error)
			});
			res.end();
			return;
		}
		sendJson(res, statusOf(error), {
			error: messageOf(error),
			status: statusOf(error)
		});
	});
}
/** Every route this plugin serves. */
function createRoutes(deps) {
	const { service } = deps;
	const running = /* @__PURE__ */ new Map();
	const json = (name$1, work) => ({
		kind: "exact",
		path: name$1.startsWith("/") ? name$1 : endpoint(name$1),
		handler: (req, res) => guarded(deps, res, () => work(req, res))
	});
	/**
	* A stream endpoint: the body is read and validated first, so a bad request
	* still gets a JSON error with a real status, then the stream opens.
	*/
	const stream = (name$1, work) => ({
		kind: "exact",
		path: name$1.startsWith("/") ? name$1 : endpoint(name$1),
		handler: (req, res) => {
			guarded(deps, res, async () => {
				requirePost(req);
				await work(req, res, openStream(res));
				res.end();
			}, (event) => {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			});
		}
	});
	return [
		json("workspaces", async (req, res) => {
			requirePost(req);
			sendJson(res, 200, service.choices());
		}),
		json(SETTINGS_PATH, async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, await service.saveSettings(parseEmbeddingPatch(body.embedding)));
		}),
		json(MARK_PATH, async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			const dir = requireString(body.dir, "dir");
			sendJson(res, 200, service.mark(dir, requireBoolean(body.library, "library"), requireScope(body.scope)));
		}),
		json("library", async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, await service.library(requireString(body.dir, "dir")));
		}),
		json("search", async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, await service.search(requireString(body.dir, "dir"), requireString(body.query, "query")));
		}),
		json("document", async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, await service.detail(requireString(body.dir, "dir"), requireString(body.id, "id")));
		}),
		json("delete", async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, await service.removeDocument(requireString(body.dir, "dir"), requireString(body.id, "id")));
		}),
		json(PURGE_PATH, async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, await service.purge(requireString(body.dir, "dir")));
		}),
		json(FORGET_PATH, async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, service.forget(requireString(body.dir, "dir")));
		}),
		json(STORAGE_PATH, async (req, res) => {
			requirePost(req);
			sendJson(res, 200, service.storage());
		}),
		json("scan", async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			sendJson(res, 200, await service.scan(requireString(body.dir, "dir"), requireString(body.path, "path")));
		}),
		stream("embed", async (req, res, write) => {
			const body = await readJson(req);
			write({
				kind: "embedded",
				remaining: (await service.embedMissing(requireString(body.dir, "dir"))).remaining
			});
		}),
		stream("import", async (req, res, write) => {
			const body = await readJson(req, MAX_UPLOAD_BYTES);
			const dir = requireString(body.dir, "dir");
			const onProgress = (progress) => {
				write({
					kind: "progress",
					phase: progress.phase,
					done: progress.done,
					total: progress.total
				});
			};
			write({
				kind: "import",
				view: typeof body.path === "string" ? await service.importFromPath(dir, body.path, onProgress) : await service.importUpload(dir, requireString(body.name, "name"), requireString(body.data, "data"), onProgress)
			});
		}),
		json(CANCEL_PATH, async (req, res) => {
			requirePost(req);
			const body = await readJson(req);
			const controller = running.get(requireString(body.id, "id"));
			if (controller === void 0) throw new CyberSelfError(404, "没有正在进行的回答");
			controller.abort();
			sendJson(res, 200, { cancelled: true });
		}),
		stream(ASK_PATH, async (req, res, write) => {
			const body = await readJson(req);
			const id = requireString(body.id, "id");
			const dir = requireString(body.dir, "dir");
			const question = requireString(body.question, "question");
			const controller = new AbortController();
			running.set(id, controller);
			res.on("close", () => controller.abort());
			try {
				write({
					kind: "answer",
					answer: await service.ask({
						dir,
						question,
						signal: controller.signal,
						onToken: (text) => write({
							kind: "token",
							text
						})
					})
				});
			} catch (error) {
				if (controller.signal.aborted) {
					write({ kind: "cancelled" });
					return;
				}
				if (statusOf(error) === 500) deps.report(error);
				write({
					kind: "error",
					message: messageOf(error)
				});
			} finally {
				running.delete(id);
			}
		})
	];
}

//#endregion
//#region src/host/tools.ts
/** Where a tool finds the knowledge base: the session's validated cwd. */
function sessionDirectory(exec) {
	const cwd = exec.agent?.session.header.cwd;
	if (cwd === void 0) throw new CyberSelfError(400, "当前会话没有工作目录，无法确定资料库位置");
	return cwd;
}
function formatCitation(citation) {
	const place = [citation.page === null ? null : `第 ${citation.page} 页`, citation.heading].filter((part) => part !== null && part !== "");
	const suffix = place.length === 0 ? "" : ` · ${place.join(" · ")}`;
	return `[${citation.index}]《${citation.title}》${suffix}\n${citation.text}`;
}
function formatDocument(document) {
	const size = document.bytes < 1024 ? `${document.bytes} 字节` : `${Math.round(document.bytes / 1024)} KB`;
	return `- ${document.title}（${document.kind}，${size}，${document.chunkCount} 段，已向量化 ${document.embeddedChunks} 段）id=${document.id}`;
}
function formatChunk(chunk) {
	const place = [chunk.page === 0 ? null : `第 ${chunk.page} 页`, chunk.heading === "" ? null : chunk.heading].filter((part) => part !== null).join(" · ");
	return `#${chunk.ordinal}${place === "" ? "" : `（${place}）`}\n${chunk.text}`;
}
/** Tools registered by the plugin. */
function createTools(service) {
	return [
		defineTool({
			name: "cyberself_search",
			description: "在当前工作区的个人知识库里检索资料片段。回答用户关于资料的问题之前先用它取得原文依据，引用时使用返回的编号。",
			parameters: { query: {
				type: "string",
				required: true,
				description: "检索用的自然语言问题或关键词，使用用户问题里的原词效果最好。"
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						query: {
							type: "string",
							required: true
						},
						note: {
							type: "string",
							required: true
						},
						citations: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									index: {
										type: "integer",
										required: true
									},
									title: {
										type: "string",
										required: true
									},
									path: {
										type: "string",
										required: true
									},
									page: {
										type: "integer",
										required: true
									},
									heading: {
										type: "string",
										required: true
									},
									text: {
										type: "string",
										required: true
									},
									score: {
										type: "number",
										required: true
									}
								}
							}
						}
					}
				},
				render: (_args, value) => {
					if (value.citations.length === 0) return [{
						type: "text",
						text: value.note === "" ? "资料库里没有匹配的内容。" : value.note
					}];
					const body = value.citations.map((citation) => formatCitation({
						index: citation.index,
						chunkId: "",
						documentId: "",
						title: citation.title,
						path: citation.path,
						page: citation.page,
						heading: citation.heading,
						text: citation.text,
						score: citation.score
					})).join("\n\n");
					return [{
						type: "text",
						text: `${value.note === "" ? "" : `${value.note}\n\n`}${body}`
					}];
				}
			},
			async execute(args, exec) {
				const dir = sessionDirectory(exec);
				const found = await service.search(dir, args.query);
				return {
					query: found.query,
					note: found.note ?? "",
					citations: found.citations.map((citation) => ({
						index: citation.index,
						title: citation.title,
						path: citation.path,
						page: citation.page ?? 0,
						heading: citation.heading ?? "",
						text: citation.text,
						score: citation.score
					}))
				};
			}
		}),
		defineTool({
			name: "cyberself_documents",
			description: "列出当前工作区个人知识库里的全部资料，包含标题、类型、段落数与向量化进度。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { documents: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: {
									type: "string",
									required: true
								},
								title: {
									type: "string",
									required: true
								},
								kind: {
									type: "string",
									required: true
								},
								bytes: {
									type: "integer",
									required: true
								},
								chunkCount: {
									type: "integer",
									required: true
								},
								embeddedChunks: {
									type: "integer",
									required: true
								}
							}
						}
					} }
				},
				render: (_args, value) => {
					if (value.documents.length === 0) return [{
						type: "text",
						text: "资料库还是空的。"
					}];
					return [{
						type: "text",
						text: value.documents.map((document) => formatDocument({
							id: document.id,
							title: document.title,
							path: "",
							kind: document.kind,
							bytes: document.bytes,
							importedAt: 0,
							chunkCount: document.chunkCount,
							embeddedChunks: document.embeddedChunks
						})).join("\n")
					}];
				}
			},
			async execute(_args, exec) {
				return { documents: (await service.library(sessionDirectory(exec))).documents.map((document) => ({
					id: document.id,
					title: document.title,
					kind: document.kind,
					bytes: document.bytes,
					chunkCount: document.chunkCount,
					embeddedChunks: document.embeddedChunks
				})) };
			}
		}),
		defineTool({
			name: "cyberself_read",
			description: "按文档 id 读取资料原文，用于核对检索片段之外的上下文。",
			parameters: {
				documentId: {
					type: "string",
					required: true,
					description: "资料 id，来自 cyberself_documents 或 cyberself_search 的结果。"
				},
				offset: {
					type: "integer",
					description: "从第几段开始，默认 0。"
				},
				limit: {
					type: "integer",
					description: "读取多少段，默认 20，最多 100。"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						title: {
							type: "string",
							required: true
						},
						total: {
							type: "integer",
							required: true
						},
						chunks: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									ordinal: {
										type: "integer",
										required: true
									},
									page: {
										type: "integer",
										required: true
									},
									heading: {
										type: "string",
										required: true
									},
									text: {
										type: "string",
										required: true
									}
								}
							}
						}
					}
				},
				render: (_args, value) => {
					return [{
						type: "text",
						text: `${`《${value.title}》共 ${value.total} 段，本次 ${value.chunks.length} 段`}\n\n${value.chunks.map(formatChunk).join("\n\n")}`
					}];
				}
			},
			async execute(args, exec) {
				const detail = await service.detail(sessionDirectory(exec), args.documentId);
				const offset = Math.max(0, args.offset ?? 0);
				const limit = Math.min(100, Math.max(1, args.limit ?? 20));
				const chunks = detail.chunks.slice(offset, offset + limit);
				return {
					title: detail.document.title,
					total: detail.document.chunkCount,
					chunks: chunks.map((chunk) => ({
						ordinal: chunk.ordinal,
						page: chunk.page ?? 0,
						heading: chunk.heading ?? "",
						text: chunk.text
					}))
				};
			}
		})
	];
}

//#endregion
//#region src/host/index.ts
/** Plugin name used by the loader and the patch file. */
const name = "cyberself";
/** Host services this plugin needs before it applies. */
const inject = [
	"webServer",
	"llm",
	"attachments",
	"workspaceRegistry",
	"agentDefaultModel",
	"tools"
];
/**
* Compose the service from the Host, mount the routes, register the tools, and
* add the per-session library policy.
* @param ctx - plugin scope.
* @param config - resolved plugin configuration.
*/
function apply(ctx, config) {
	const settings = Config(config ?? {});
	const route = () => {
		const selection = ctx.agentDefaultModel.currentSelection();
		const configured = settings.answer;
		const overridden = configured.provider !== "" && configured.model !== "";
		return {
			provider: overridden ? configured.provider : selection.provider,
			model: overridden ? configured.model : selection.model,
			...overridden || selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
		};
	};
	const service = new CyberSelf({
		config: () => settings,
		listWorkspaces: () => ctx.workspaceRegistry.list().map((workspace) => ({
			id: workspace.id,
			path: workspace.path,
			title: workspace.title
		})),
		llm: ctx.llm,
		attachments: ctx.attachments,
		route,
		readEmbeddingSettings,
		writeEmbeddingSettings
	});
	ctx.effect(() => () => service.dispose());
	const routes = createRoutes({
		service,
		report: (error) => ctx.logger.warn(error)
	});
	for (const webRoute of routes) ctx.effect(() => ctx.webServer.register(webRoute));
	for (const tool of createTools(service)) ctx.effect(() => ctx.tools.register(tool));
	registerLibraryPolicy(ctx, service);
}

//#endregion
export { Config, apply, inject, name };