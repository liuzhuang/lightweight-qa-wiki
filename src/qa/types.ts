import { z } from "zod";

export const QaRequestSchema = z
  .object({
    thread_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/, "thread_id contains unsafe characters"),
    question: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type QaRequest = z.infer<typeof QaRequestSchema>;

export type RefusalReason = "out_of_scope" | "insufficient_evidence";

export type Citation = {
  source_id: string;
  file: string;
  locator: string;
  excerpt: string;
};

export type QaResponse = {
  run_id: string;
  thread_id: string;
  knowledge_version: string;
  answer: string;
  refused: boolean;
  refusal_reason: RefusalReason | null;
  used_source_fallback: boolean;
  citations: Citation[];
};

export type ErrorCode =
  | "invalid_request"
  | "thread_busy"
  | "knowledge_not_ready"
  | "model_unavailable"
  | "upstream_model_error"
  | "internal_error";

export class QaError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QaError";
  }
}

export const invalidRequest = (message = "Invalid request") =>
  new QaError("invalid_request", 400, message);

export const threadBusy = () =>
  new QaError("thread_busy", 409, "Another request is already running for this thread");

export const knowledgeNotReady = (message = "Knowledge base is not ready", cause?: unknown) =>
  new QaError("knowledge_not_ready", 503, message, { cause });

export const modelUnavailable = (message = "LLM is not configured", cause?: unknown) =>
  new QaError("model_unavailable", 503, message, { cause });

export const upstreamModelError = (cause?: unknown) =>
  new QaError("upstream_model_error", 502, "The upstream model request failed", { cause });
