import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { Evidence } from "./knowledge";
import type { RefusalReason } from "./types";
import { modelUnavailable, upstreamModelError } from "./types";

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type RankInput = {
  question: string;
  history: string;
  index: string;
};

export type AnswerInput = {
  question: string;
  history: string;
  evidence: Evidence[];
};

export type AnswerDraft = {
  answer: string;
  refused: boolean;
  refusal_reason: RefusalReason | null;
  citation_ids: string[];
  tokenUsage?: TokenUsage;
};

export interface QaModel {
  rank(input: RankInput): Promise<{ candidates: string[]; tokenUsage?: TokenUsage }>;
  answer(input: AnswerInput): Promise<AnswerDraft>;
}

const RankSchema = z.object({
  candidates: z.array(z.string()).max(5),
});

const AnswerSchema = z.object({
  answer: z.string(),
  refused: z.boolean(),
  refusal_reason: z.enum(["out_of_scope", "insufficient_evidence"]).nullable(),
  citation_ids: z.array(z.string()).max(12),
});

export class ChatQaModel implements QaModel {
  constructor(private readonly chat: ChatOpenAI) {}

  async rank(input: RankInput): Promise<{ candidates: string[]; tokenUsage?: TokenUsage }> {
    try {
      const runnable = this.chat.withStructuredOutput(RankSchema, {
        name: "rank_wiki_entries",
        includeRaw: true,
      });
      const result = await runnable.invoke([
        new SystemMessage(
          "Select at most five relevant Wiki entry paths from the complete index. Return only paths that appear in the index, ordered most relevant first. Empty is valid for out-of-domain questions.",
        ),
        new HumanMessage(
          `Conversation:\n${input.history || "(none)"}\n\nQuestion:\n${input.question}\n\nComplete Wiki index:\n${input.index}`,
        ),
      ]);
      return { candidates: result.parsed.candidates, tokenUsage: usageFrom(result.raw) };
    } catch (error) {
      throw upstreamModelError(error);
    }
  }

  async answer(input: AnswerInput): Promise<AnswerDraft> {
    try {
      const runnable = this.chat.withStructuredOutput(AnswerSchema, {
        name: "grounded_qa_answer",
        includeRaw: true,
      });
      const evidence = input.evidence
        .map(
          (item, index) =>
            `[${index + 1}] source_id=${item.sourceId} origin=${item.origin}${item.entryPath ? ` entry=${item.entryPath}` : ""}\n${item.text}`,
        )
        .join("\n\n");
      const result = await runnable.invoke([
        new SystemMessage(
          "Answer only from the supplied evidence. Never invent facts or source IDs. If the question is outside the corpus, refuse with out_of_scope. If evidence is incomplete, refuse with insufficient_evidence. A non-refusal answer must include one or more citation_ids copied exactly from the evidence.",
        ),
        new HumanMessage(
          `Conversation:\n${input.history || "(none)"}\n\nQuestion:\n${input.question}\n\nEvidence:\n${evidence}`,
        ),
      ]);
      return { ...result.parsed, tokenUsage: usageFrom(result.raw) };
    } catch (error) {
      throw upstreamModelError(error);
    }
  }
}

export function createChatQaModelFromEnv(env: NodeJS.ProcessEnv = process.env): QaModel {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) throw modelUnavailable("LLM_API_KEY is required");
  const model = env.LLM_MODEL?.trim() || "qwen-plus";
  const baseURL = env.LLM_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  try {
    new URL(baseURL);
  } catch (error) {
    throw modelUnavailable("LLM_BASE_URL is invalid", error);
  }
  return new ChatQaModel(
    new ChatOpenAI({
      apiKey,
      model,
      temperature: 0,
      maxRetries: 0,
      timeout: 60_000,
      useResponsesApi: false,
      configuration: { baseURL },
    }),
  );
}

function usageFrom(message: BaseMessage): TokenUsage | undefined {
  const usage = (message as BaseMessage & { usage_metadata?: TokenUsage }).usage_metadata;
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
}
