import { mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createQaGraph, qaGraphInput } from "./graph";
import { KnowledgeRepository } from "./knowledge";
import { createChatQaModelFromEnv, type QaModel } from "./model";
import {
  QaError,
  QaRequestSchema,
  invalidRequest,
  threadBusy,
  type QaRequest,
  type QaResponse,
} from "./types";

export type HealthResponse = {
  status: "ok" | "unhealthy";
  knowledge_version: string | null;
  checks: { wiki: boolean; source_map: boolean; sqlite: boolean };
};

type QueryLog = {
  run_id: string;
  thread_id: string;
  knowledge_version?: string;
  candidates?: string[];
  source_ids?: string[];
  safeguard_reasons?: string[];
  refused?: boolean;
  refusal_reason?: string | null;
  used_source_fallback?: boolean;
  duration_ms: number;
  token_usage?: unknown;
  error_code?: string;
};

export type QaLogger = (entry: QueryLog) => Promise<void>;

type ServiceOptions = {
  knowledge: KnowledgeRepository;
  model: QaModel;
  checkpointer: BaseCheckpointSaver;
  logger?: QaLogger;
};

export function createQaService({ knowledge, model, checkpointer, logger = defaultLogger }: ServiceOptions) {
  const graph = createQaGraph({ knowledge, model, checkpointer });
  const activeThreads = new Set<string>();

  return {
    async run(input: QaRequest): Promise<QaResponse> {
      const parsed = QaRequestSchema.safeParse(input);
      if (!parsed.success) throw invalidRequest(parsed.error.issues[0]?.message);
      const request = parsed.data;
      if (activeThreads.has(request.thread_id)) throw threadBusy();
      activeThreads.add(request.thread_id);
      const runId = randomUUID();
      const startedAt = performance.now();

      try {
        const state = await graph.invoke(
          qaGraphInput(runId, request.thread_id, request.question),
          { configurable: { thread_id: request.thread_id } },
        );
        if (!state.result) throw new Error("Graph completed without a result");
        await safelyLog(logger, {
          run_id: runId,
          thread_id: request.thread_id,
          knowledge_version: state.knowledgeVersion,
          candidates: state.candidatePaths,
          source_ids: [...new Set(state.evidence.map(({ sourceId }) => sourceId))],
          safeguard_reasons: state.safeguards,
          refused: state.result.refused,
          refusal_reason: state.result.refusal_reason,
          used_source_fallback: state.result.used_source_fallback,
          duration_ms: Math.round(performance.now() - startedAt),
          token_usage: state.tokenUsage,
        });
        return state.result;
      } catch (error) {
        await safelyLog(logger, {
          run_id: runId,
          thread_id: request.thread_id,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: error instanceof QaError ? error.code : "internal_error",
        });
        if (error instanceof QaError) throw error;
        throw new QaError("internal_error", 500, "The query failed", { cause: error });
      } finally {
        activeThreads.delete(request.thread_id);
      }
    },
  };
}

type QaGlobals = typeof globalThis & {
  __lightweightQaSaver?: SqliteSaver;
  __lightweightQaService?: ReturnType<typeof createQaService>;
};

const globals = globalThis as QaGlobals;

export function getSqliteSaver(): SqliteSaver {
  if (!globals.__lightweightQaSaver) {
    const runtimeDir = path.join(process.cwd(), ".runtime");
    // SqliteSaver creates the file lazily; the directory must exist first.
    mkdirSync(runtimeDir, { recursive: true });
    globals.__lightweightQaSaver = SqliteSaver.fromConnString(
      path.join(runtimeDir, "checkpoints.sqlite"),
    );
  }
  return globals.__lightweightQaSaver;
}

export function getQaService() {
  if (!globals.__lightweightQaService) {
    globals.__lightweightQaService = createQaService({
      knowledge: new KnowledgeRepository(),
      model: createChatQaModelFromEnv(),
      checkpointer: getSqliteSaver(),
    });
  }
  return globals.__lightweightQaService;
}

export async function getHealthStatus(
  knowledge = new KnowledgeRepository(),
  checkpointer?: BaseCheckpointSaver,
  createCheckpointer: () => BaseCheckpointSaver = getSqliteSaver,
): Promise<HealthResponse> {
  let knowledgeVersion: string | null = null;
  let wiki = false;
  let sourceMap = false;
  let sqlite = false;
  try {
    const status = await knowledge.status();
    knowledgeVersion = status.version;
    wiki = status.wiki;
    sourceMap = status.sourceMap;
  } catch {
    // Report each failed dependency through the health contract.
  }
  try {
    await (checkpointer ?? createCheckpointer()).getTuple({
      configurable: { thread_id: "__health__" },
    });
    sqlite = true;
  } catch {
    // Report each failed dependency through the health contract.
  }
  return {
    status: wiki && sourceMap && sqlite ? "ok" : "unhealthy",
    knowledge_version: knowledgeVersion,
    checks: { wiki, source_map: sourceMap, sqlite },
  };
}

async function defaultLogger(entry: QueryLog): Promise<void> {
  const logDir = path.join(process.cwd(), ".runtime/logs");
  await mkdir(logDir, { recursive: true });
  await appendFile(path.join(logDir, "qa.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

async function safelyLog(logger: QaLogger, entry: QueryLog): Promise<void> {
  try {
    await logger(entry);
  } catch {
    // Query results must not fail because local observability storage is unavailable.
  }
}
