import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, MessagesValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { isNumericSensitive, type Evidence, type KnowledgeRepository } from "./knowledge";
import type { QaModel, TokenUsage } from "./model";
import type { Citation, QaResponse, RefusalReason } from "./types";

const EvidenceSchema = z.object({
  sourceId: z.string(),
  text: z.string(),
  origin: z.enum(["wiki", "source"]),
  entryPath: z.string().optional(),
});

const CitationSchema = z.object({
  source_id: z.string(),
  file: z.string(),
  locator: z.string(),
  excerpt: z.string(),
});

const ResultSchema = z.object({
  run_id: z.string(),
  thread_id: z.string(),
  knowledge_version: z.string(),
  answer: z.string(),
  refused: z.boolean(),
  refusal_reason: z.enum(["out_of_scope", "insufficient_evidence"]).nullable(),
  used_source_fallback: z.boolean(),
  citations: z.array(CitationSchema),
});

export const QaStateSchema = new StateSchema({
  messages: MessagesValue,
  runId: z.string().default(""),
  threadId: z.string().default(""),
  question: z.string().default(""),
  knowledgeVersion: z.string().default(""),
  exactSourceIds: z.array(z.string()).default(() => []),
  unmatchedIdentifiers: z.array(z.string()).default(() => []),
  candidatePaths: z.array(z.string()).default(() => []),
  evidence: z.array(EvidenceSchema).default(() => []),
  safeguards: z.array(z.string()).default(() => []),
  usedSourceFallback: z.boolean().default(false),
  tokenUsage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
  result: ResultSchema.nullable().default(null),
});

export type QaGraphState = typeof QaStateSchema.State;

type GraphDependencies = {
  knowledge: KnowledgeRepository;
  model: QaModel;
  checkpointer: BaseCheckpointSaver;
};

export function createQaGraph({ knowledge, model, checkpointer }: GraphDependencies) {
  const initialize = async () => {
    const snapshot = await knowledge.load();
    return {
      knowledgeVersion: snapshot.version,
      exactSourceIds: [],
      unmatchedIdentifiers: [],
      candidatePaths: [],
      evidence: [],
      safeguards: [],
      usedSourceFallback: false,
      tokenUsage: undefined,
      result: null,
    };
  };

  const retrieve = async (state: QaGraphState) => {
    const [snapshot, exact] = await Promise.all([knowledge.load(), knowledge.exactMatches(state.question)]);
    if (exact.unmatchedIdentifiers.length > 0) {
      return {
        exactSourceIds: [],
        unmatchedIdentifiers: exact.unmatchedIdentifiers,
        candidatePaths: [],
      };
    }
    const ranked = await model.rank({
      question: state.question,
      history: formatHistory(state.messages),
      index: snapshot.index,
    });
    const modelPaths = await knowledge.rankedPaths(ranked.candidates);
    const candidatePaths = [...new Set([...exact.entryPaths, ...modelPaths])].slice(0, 5);
    return {
      exactSourceIds: exact.sourceIds,
      unmatchedIdentifiers: [],
      candidatePaths,
      tokenUsage: ranked.tokenUsage,
    };
  };

  const gather = async (state: QaGraphState) => ({
    evidence: await knowledge.collectWikiEvidence(state.candidatePaths),
  });

  const fallback = async (state: QaGraphState) => {
    if (state.unmatchedIdentifiers.length > 0) {
      return { safeguards: [...state.safeguards, "unknown_identifier"] };
    }
    const numeric = isNumericSensitive(state.question);
    if (!numeric && state.evidence.length > 0) return {};

    const safeguards = [
      ...state.safeguards,
      ...(numeric ? ["numeric_source_verification"] : []),
      ...(state.evidence.length === 0 ? ["no_wiki_evidence"] : []),
    ];
    const sourceEvidence = await retrieveSourceEvidence(state, knowledge);
    return {
      evidence: dedupeEvidence([...state.evidence, ...sourceEvidence]).slice(0, 12),
      safeguards,
      usedSourceFallback: true,
    };
  };

  const answer = async (state: QaGraphState) => {
    if (state.evidence.length === 0) {
      return {
        result: refusal(
          state,
          state.candidatePaths.length === 0 ? "out_of_scope" : "insufficient_evidence",
        ),
      };
    }

    const numeric = isNumericSensitive(state.question);
    if (numeric && !state.evidence.some((item) => item.origin === "source")) {
      return { result: refusal(state, "insufficient_evidence") };
    }

    let evidence = state.evidence;
    let usedSourceFallback = state.usedSourceFallback;
    let safeguards = state.safeguards;
    let draft = await model.answer({
      question: state.question,
      history: formatHistory(state.messages),
      evidence,
    });
    let tokenUsage = addUsage(state.tokenUsage, draft.tokenUsage);
    if (draft.refused && draft.refusal_reason === "insufficient_evidence" && !usedSourceFallback) {
      const sourceEvidence = await retrieveSourceEvidence(state, knowledge);
      usedSourceFallback = true;
      safeguards = [...safeguards, "model_requested_source_fallback"];
      if (sourceEvidence.length > 0) {
        evidence = dedupeEvidence([...evidence, ...sourceEvidence]).slice(0, 12);
        draft = await model.answer({
          question: state.question,
          history: formatHistory(state.messages),
          evidence,
        });
        tokenUsage = addUsage(tokenUsage, draft.tokenUsage);
      }
    }
    if (draft.refused) {
      return {
        evidence,
        usedSourceFallback,
        safeguards,
        tokenUsage,
        result: refusalWithFallback(
          state,
          draft.refusal_reason ?? "insufficient_evidence",
          usedSourceFallback,
        ),
      };
    }

    const citations = await validateCitations(draft.citation_ids, evidence, knowledge);
    if (!draft.answer.trim() || citations.length === 0 || citations.length !== new Set(draft.citation_ids).size) {
      return {
        tokenUsage,
        evidence,
        usedSourceFallback,
        safeguards: [...safeguards, "invalid_model_citations"],
        result: refusalWithFallback(state, "insufficient_evidence", usedSourceFallback),
      };
    }
    if (
      numeric &&
      !citations.some((citation) =>
        evidence.some(
          (item) => item.sourceId === citation.source_id && item.origin === "source",
        ),
      )
    ) {
      return {
        tokenUsage,
        evidence,
        usedSourceFallback,
        safeguards: [...safeguards, "numeric_citation_not_from_source"],
        result: refusalWithFallback(state, "insufficient_evidence", usedSourceFallback),
      };
    }
    return {
      tokenUsage,
      result: {
        run_id: state.runId,
        thread_id: state.threadId,
        knowledge_version: state.knowledgeVersion,
        answer: draft.answer.trim(),
        refused: false,
        refusal_reason: null,
        used_source_fallback: usedSourceFallback,
        citations,
      } satisfies QaResponse,
      evidence,
      usedSourceFallback,
      safeguards,
    };
  };

  const finalize = async (state: QaGraphState) => ({
    messages: [new AIMessage(state.result?.answer ?? "知识库中没有足够且可验证的依据回答该问题。")],
  });

  return new StateGraph(QaStateSchema)
    .addNode("initialize", initialize)
    .addNode("retrieve", retrieve)
    .addNode("gather", gather)
    .addNode("fallback", fallback)
    .addNode("answer", answer)
    .addNode("finalize", finalize)
    .addEdge(START, "initialize")
    .addEdge("initialize", "retrieve")
    .addEdge("retrieve", "gather")
    .addEdge("gather", "fallback")
    .addEdge("fallback", "answer")
    .addEdge("answer", "finalize")
    .addEdge("finalize", END)
    .compile({ checkpointer });
}

export function qaGraphInput(runId: string, threadId: string, question: string) {
  return {
    messages: [new HumanMessage(question)],
    runId,
    threadId,
    question,
  };
}

function refusal(
  state: QaGraphState,
  reason: RefusalReason,
  answer = reason === "out_of_scope"
    ? "该问题超出当前知识库范围，无法依据已有资料回答。"
    : "知识库中没有足够且可验证的依据回答该问题。",
): QaResponse {
  return {
    run_id: state.runId,
    thread_id: state.threadId,
    knowledge_version: state.knowledgeVersion,
    answer,
    refused: true,
    refusal_reason: reason,
    used_source_fallback: state.usedSourceFallback,
    citations: [],
  };
}

function refusalWithFallback(
  state: QaGraphState,
  reason: RefusalReason,
  usedSourceFallback: boolean,
): QaResponse {
  return { ...refusal(state, reason), used_source_fallback: usedSourceFallback };
}

async function validateCitations(
  citationIds: string[],
  evidence: Evidence[],
  knowledge: KnowledgeRepository,
): Promise<Citation[]> {
  if (citationIds.length === 0 || new Set(citationIds).size !== citationIds.length) return [];
  const allowed = new Set(evidence.map(({ sourceId }) => sourceId));
  const citations: Citation[] = [];
  for (const sourceId of citationIds) {
    if (!allowed.has(sourceId)) return [];
    const source = await knowledge.source(sourceId);
    if (!source) return [];
    citations.push({
      source_id: source.id,
      file: source.file,
      locator: source.locator,
      excerpt: source.excerpt.slice(0, 500),
    });
  }
  return citations;
}

function formatHistory(messages: BaseMessage[]): string {
  return messages
    .slice(0, -1)
    .slice(-8)
    .map((message) => {
      const content =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return `${message.getType()}: ${content.slice(0, 2_000)}`;
    })
    .join("\n");
}

async function retrieveSourceEvidence(
  state: QaGraphState,
  knowledge: KnowledgeRepository,
): Promise<Evidence[]> {
  // ponytail: deterministic four-call ceiling; switch to a model-driven tool loop if corpus scale needs it.
  const preferred = [
    ...new Set([...state.exactSourceIds, ...state.evidence.map(({ sourceId }) => sourceId)]),
  ].slice(0, 3);
  if (preferred.length < 3) {
    const sourceIds = await knowledge.searchSources(state.question, 3); // search_sources: at most one round
    for (const sourceId of sourceIds) {
      if (!preferred.includes(sourceId)) preferred.push(sourceId);
      if (preferred.length === 3) break;
    }
  }
  const evidence: Evidence[] = [];
  for (const sourceId of preferred) {
    const item = await knowledge.readSource(sourceId); // read_source: rounds 2-4
    if (item) evidence.push(item);
  }
  return evidence;
}

function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.sourceId}:${item.origin}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addUsage(left?: TokenUsage, right?: TokenUsage): TokenUsage | undefined {
  if (!left && !right) return undefined;
  return {
    input_tokens: (left?.input_tokens ?? 0) + (right?.input_tokens ?? 0),
    output_tokens: (left?.output_tokens ?? 0) + (right?.output_tokens ?? 0),
    total_tokens: (left?.total_tokens ?? 0) + (right?.total_tokens ?? 0),
  };
}
