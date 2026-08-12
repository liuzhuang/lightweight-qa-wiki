import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileCorpus, createManifest, sourceId } from "../src/kb";
import { KnowledgeRepository } from "../src/qa/knowledge";
import type { AnswerDraft, AnswerInput, QaModel } from "../src/qa/model";
import { createQaService } from "../src/qa/service";

class FakeModel implements QaModel {
  histories: string[] = [];
  answerCalls = 0;

  constructor(
    private readonly candidates: string[],
    private readonly answerFn: (input: AnswerInput, call: number) => AnswerDraft,
  ) {}

  async rank() {
    return { candidates: this.candidates };
  }

  async answer(input: AnswerInput) {
    this.histories.push(input.history);
    this.answerCalls += 1;
    return this.answerFn(input, this.answerCalls);
  }
}

function service(model: QaModel) {
  return createQaService({
    knowledge: new KnowledgeRepository(),
    model,
    checkpointer: SqliteSaver.fromConnString(":memory:"),
    logger: async () => undefined,
  });
}

const grounded = (input: AnswerInput, answer = "有可靠答案。") => {
  const source = input.evidence.find((item) => item.origin === "source") ?? input.evidence[0];
  if (!source) throw new Error("Expected evidence");
  return {
    answer,
    refused: false as const,
    refusal_reason: null,
    citation_ids: [source.sourceId],
  };
};

describe("QA graph", () => {
  it("uses exact identifiers and forces price answers back to the XLSX source", async () => {
    const qa = service(new FakeModel([], (input) => grounded(input, "NQ-100 未税价格为 1299 CNY/年。")));

    const result = await qa.run({ thread_id: "price-thread", question: "NQ-100 的价格是多少？" });

    expect(result.refused).toBe(false);
    expect(result.used_source_fallback).toBe(true);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ file: "products.xlsx", locator: "产品目录!R2" });
    expect(result.citations[0].excerpt).toContain("NQ-100");
  });

  it("retries once against raw sources after an insufficient-evidence draft", async () => {
    const model = new FakeModel(["products/nq-100.md"], (input, call) =>
      call === 1
        ? {
            answer: "untrusted draft",
            refused: true,
            refusal_reason: "insufficient_evidence",
            citation_ids: [],
          }
        : grounded(input, "星桥协作台包含 50 个许可用户。"),
    );

    const result = await service(model).run({
      thread_id: "fallback-thread",
      question: "星桥协作台包含哪些许可信息？",
    });

    expect(model.answerCalls).toBe(2);
    expect(result.refused).toBe(false);
    expect(result.used_source_fallback).toBe(true);
    expect(result.citations[0].file).toBe("products.xlsx");
  });

  it("returns a fixed closed-domain refusal without calling the answer model", async () => {
    const model = new FakeModel([], () => {
      throw new Error("answer should not run");
    });

    const result = await service(model).run({
      thread_id: "scope-thread",
      question: "月球背面明天的天气如何？",
    });

    expect(result).toMatchObject({
      refused: true,
      refusal_reason: "out_of_scope",
      citations: [],
      answer: "该问题超出当前知识库范围，无法依据已有资料回答。",
    });
    expect(model.answerCalls).toBe(0);
  });

  it("refuses an unknown identifier that is only a prefix of a real product code", async () => {
    const model = new FakeModel([], () => {
      throw new Error("answer should not run");
    });

    const result = await service(model).run({
      thread_id: "identifier-prefix",
      question: "NQ-10 对应什么产品？",
    });

    expect(result).toMatchObject({ refused: true, refusal_reason: "out_of_scope", citations: [] });
    expect(model.answerCalls).toBe(0);
  });

  it("rejects model citations that were not present in bounded evidence", async () => {
    const model = new FakeModel(["company/profile.md"], () => ({
      answer: "伪造回答",
      refused: false,
      refusal_reason: null,
      citation_ids: ["src_not_in_evidence"],
    }));

    const result = await service(model).run({
      thread_id: "citation-thread",
      question: "璟云科技总部在哪里？",
    });

    expect(result.refused).toBe(true);
    expect(result.refusal_reason).toBe("insufficient_evidence");
    expect(result.citations).toEqual([]);
    expect(result.answer).not.toContain("伪造回答");
  });

  it("persists bounded history per thread and isolates other threads", async () => {
    const model = new FakeModel(["company/profile.md"], (input) => grounded(input));
    const qa = service(model);

    await qa.run({ thread_id: "thread-a", question: "璟云科技总部在哪里？" });
    await qa.run({ thread_id: "thread-a", question: "它的支持邮箱是什么？" });
    await qa.run({ thread_id: "thread-b", question: "支持邮箱是什么？" });

    expect(model.histories[0]).toBe("");
    expect(model.histories[1]).toContain("璟云科技总部在哪里");
    expect(model.histories[1]).toContain("有可靠答案");
    expect(model.histories[1]).not.toContain("它的支持邮箱是什么");
    expect(model.histories[2]).toBe("");
  });

  it("uses the current Wiki evidence to resolve a numeric follow-up from raw sources", async () => {
    const qa = service(
      new FakeModel(["products/nq-100.md"], (input) =>
        grounded(input, "NQ-100 的未税价格为 1299 CNY/年。"),
      ),
    );

    await qa.run({ thread_id: "follow-up-price", question: "NQ-100 是什么产品？" });
    const result = await qa.run({ thread_id: "follow-up-price", question: "它多少钱？" });

    expect(result).toMatchObject({ refused: false, used_source_fallback: true });
    expect(result.citations[0]).toMatchObject({
      file: "products.xlsx",
      locator: "产品目录!R2",
    });
  });

  it("returns thread_busy for concurrent calls on the same thread", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const blocker = new Promise<void>((resolve) => (release = resolve));
    const model = new FakeModel(["company/profile.md"], asyncAnswer);
    const qa = service(model);

    function asyncAnswer(input: AnswerInput): AnswerDraft {
      started();
      return grounded(input);
    }
    const originalAnswer = model.answer.bind(model);
    model.answer = async (input: AnswerInput) => {
      started();
      await blocker;
      return originalAnswer(input);
    };

    const first = qa.run({ thread_id: "locked", question: "璟云科技总部在哪里？" });
    await startedPromise;
    await expect(
      qa.run({ thread_id: "locked", question: "支持邮箱是什么？" }),
    ).rejects.toMatchObject({ code: "thread_busy", status: 409 });
    release();
    await first;
  });
});

describe("raw source retrieval", () => {
  it("finds identifiers and amounts after the source-map excerpt boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightweight-qa-raw-"));
    try {
      const corpus = path.join(root, "data/corpus");
      const processed = path.join(root, "data/processed");
      const wiki = path.join(root, "data/wiki");
      await mkdir(path.join(wiki, "concepts"), { recursive: true });
      await mkdir(corpus, { recursive: true });
      const text = `${"填充".repeat(260)} 产品编码 ZX-98765，金额 43210 CNY。`;
      const corpusFile = path.join(corpus, "long.md");
      await writeFile(corpusFile, text);
      const sourceMap = await compileCorpus(corpus, processed, await createManifest(corpus));
      const id = sourceId("long.md", "L1-L1");
      expect(sourceMap.sources[id].excerpt).not.toContain("ZX-98765");
      await writeFile(path.join(wiki, "index.md"), "# Index\n\n[Long](concepts/long.md)\n");
      await writeFile(path.join(wiki, "concepts/long.md"), `# Long\n\n[[SRC:${id}]]\n`);

      const knowledge = new KnowledgeRepository(root);
      await expect(knowledge.exactMatches("ZX-98765")).resolves.toMatchObject({
        sourceIds: [id],
        entryPaths: ["concepts/long.md"],
      });
      await expect(knowledge.searchSources("金额 43210")).resolves.toContain(id);
      await writeFile(corpusFile, `${text} changed`);
      await expect(knowledge.searchSources("金额 43210")).rejects.toMatchObject({
        code: "knowledge_not_ready",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat an identifier prefix as an exact match", async () => {
    const knowledge = new KnowledgeRepository();
    await expect(knowledge.exactMatches("NQ-100 对应什么产品？")).resolves.toMatchObject({
      identifiers: ["NQ-100"],
      sourceIds: ["src_b2117b87c3276666"],
    });
    await expect(knowledge.exactMatches("NQ-10 对应什么产品？")).resolves.toEqual({
      identifiers: ["NQ-10"],
      unmatchedIdentifiers: ["NQ-10"],
      sourceIds: [],
      entryPaths: [],
    });
  });
});
