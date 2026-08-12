import { describe, expect, it } from "vitest";
import { handleHealthRequest } from "../src/app/api/health/route";
import { handleQaRequest } from "../src/app/api/qa/route";
import type { QaResponse } from "../src/qa/types";
import {
  knowledgeNotReady,
  modelUnavailable,
  threadBusy,
  upstreamModelError,
} from "../src/qa/types";

const validResult: QaResponse = {
  run_id: "2a6edfd9-8869-4db8-b20c-bac773fb5c79",
  thread_id: "api-test",
  knowledge_version: "demo-v1",
  answer: "没有足够依据。",
  refused: true,
  refusal_reason: "insufficient_evidence",
  used_source_fallback: true,
  citations: [],
};

const request = (body: string) =>
  new Request("http://127.0.0.1:3000/api/qa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("Route Handler contracts", () => {
  it("returns 200 for a normal refusal", async () => {
    const response = await handleQaRequest(request(JSON.stringify({
      thread_id: "api-test",
      question: "未知问题",
    })), { run: async () => validResult });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(validResult);
  });

  it.each([
    ["not-json", 400, "invalid_request"],
    [JSON.stringify({ thread_id: "unsafe id", question: "x" }), 400, "invalid_request"],
  ])("validates request body", async (body, status, code) => {
    const response = await handleQaRequest(request(body), { run: async () => validResult });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it.each([
    [threadBusy(), 409, "thread_busy"],
    [upstreamModelError(), 502, "upstream_model_error"],
    [knowledgeNotReady(), 503, "knowledge_not_ready"],
    [modelUnavailable(), 503, "model_unavailable"],
  ])("maps service errors without leaking causes", async (error, status, code) => {
    const response = await handleQaRequest(
      request(JSON.stringify({ thread_id: "api-test", question: "x" })),
      { run: async () => Promise.reject(error) },
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: error.message } });
  });

  it("reports health using 200 and 503", async () => {
    const healthy = await handleHealthRequest(async () => ({
      status: "ok",
      knowledge_version: "v1",
      checks: { wiki: true, source_map: true, sqlite: true },
    }));
    const unhealthy = await handleHealthRequest(async () => ({
      status: "unhealthy",
      knowledge_version: null,
      checks: { wiki: false, source_map: false, sqlite: true },
    }));
    expect(healthy.status).toBe(200);
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toMatchObject({ status: "unhealthy" });
  });
});
