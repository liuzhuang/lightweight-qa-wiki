import { describe, expect, it } from "vitest";

import {
  calculateMetrics,
  parseRecords,
  scenarios,
  sourceIdsFromMap,
  type EvalRecord,
} from "../scripts/eval";

const record = (overrides: Partial<EvalRecord> = {}): EvalRecord => ({
  id: "case",
  scenario: "exact_identifier",
  question: "question",
  expected: { source_ids: ["a", "b"], refused: false, used_source_fallback: false },
  actual: {
    retrieved_source_ids: ["x", "a"],
    proposed_citation_ids: ["a"],
    final_citation_ids: ["a"],
    refused: false,
    used_source_fallback: false,
  },
  ...overrides,
});

describe("offline evaluation", () => {
  it("calculates ranked retrieval, context, citation, and behavior metrics", () => {
    const metrics = calculateMetrics([record()], new Set(["a", "b"]));

    expect(metrics).toMatchObject({
      cases: 1,
      retrieval_cases: 1,
      recall: 0.5,
      precision: 0.5,
      hit_rate: 1,
      mrr: 0.5,
      context_precision: 0.5,
      context_recall: 0.5,
      citation_validity: 1,
      behavior_pass_rate: 1,
    });
    expect(metrics.ndcg_at_5).toBeCloseTo(0.38685, 5);
  });

  it("requires every planned scenario in an evaluation file", () => {
    const records = scenarios.map((scenario, index) => record({ id: `case-${index}`, scenario }));
    expect(parseRecords({ records })).toHaveLength(scenarios.length);
    expect(() => parseRecords({ records: records.slice(1) })).toThrow("missing scenarios");
  });

  it("counts only server-accepted citations as final citation evidence", () => {
    const metrics = calculateMetrics([
      record({
        actual: {
          retrieved_source_ids: ["a"],
          proposed_citation_ids: ["missing"],
          final_citation_ids: [],
          refused: true,
          used_source_fallback: true,
          citation_guard_triggered: true,
        },
        expected: {
          source_ids: ["a"],
          refused: true,
          used_source_fallback: true,
          citation_guard_triggered: true,
        },
      }),
      ],
      new Set(["a"]),
    );

    expect(metrics.citation_validity).toBe(1);
    expect(metrics.behavior_pass_rate).toBe(1);
  });

  it("uses the source map rather than self-reported citation validity", () => {
    const sources = sourceIdsFromMap({ sources: { a: { file: "company.md" } } });
    expect(() => calculateMetrics([record()], sources)).toThrow("expects unknown source b");
  });
});
