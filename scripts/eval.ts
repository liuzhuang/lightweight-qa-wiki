import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const scenarios = [
  "cross_document",
  "exact_identifier",
  "numeric_fallback",
  "multi_turn",
  "thread_isolation",
  "out_of_scope",
  "invalid_citation",
] as const;

type Scenario = (typeof scenarios)[number];

export type EvalRecord = {
  id: string;
  scenario: Scenario;
  question: string;
  expected: {
    source_ids: string[];
    refused: boolean;
    used_source_fallback: boolean;
    citation_guard_triggered?: boolean;
  };
  actual: {
    retrieved_source_ids: string[];
    proposed_citation_ids: string[];
    final_citation_ids: string[];
    refused: boolean;
    used_source_fallback: boolean;
    citation_guard_triggered?: boolean;
  };
};

export type EvalMetrics = {
  cases: number;
  retrieval_cases: number;
  recall: number;
  precision: number;
  hit_rate: number;
  mrr: number;
  ndcg_at_5: number;
  context_precision: number;
  context_recall: number;
  citation_validity: number;
  behavior_pass_rate: number;
};

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const intersectionCount = (left: string[], right: Set<string>) =>
  new Set(left.filter((item) => right.has(item))).size;

function validateRecord(value: unknown, index: number): asserts value is EvalRecord {
  if (!value || typeof value !== "object") throw new Error(`records[${index}] must be an object`);
  const record = value as Partial<EvalRecord>;
  if (!record.id || !record.question || !record.scenario || !scenarios.includes(record.scenario)) {
    throw new Error(`records[${index}] has invalid identity fields`);
  }
  for (const side of ["expected", "actual"] as const) {
    if (!record[side] || typeof record[side] !== "object") {
      throw new Error(`records[${index}].${side} must be an object`);
    }
  }
  if (!isStringArray(record.expected?.source_ids)) {
    throw new Error(`records[${index}].expected.source_ids must be an array`);
  }
  for (const field of [
    "retrieved_source_ids",
    "proposed_citation_ids",
    "final_citation_ids",
  ] as const) {
    if (!isStringArray(record.actual?.[field])) {
      throw new Error(`records[${index}].actual.${field} must be an array`);
    }
  }
  for (const [path, flag] of [
    ["expected.refused", record.expected?.refused],
    ["expected.used_source_fallback", record.expected?.used_source_fallback],
    ["actual.refused", record.actual?.refused],
    ["actual.used_source_fallback", record.actual?.used_source_fallback],
  ] as const) {
    if (typeof flag !== "boolean") throw new Error(`records[${index}].${path} must be boolean`);
  }
  for (const side of ["expected", "actual"] as const) {
    const flag = record[side]?.citation_guard_triggered;
    if (flag !== undefined && typeof flag !== "boolean") {
      throw new Error(`records[${index}].${side}.citation_guard_triggered must be boolean`);
    }
  }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseRecords(value: unknown): EvalRecord[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { records?: unknown }).records)) {
    throw new Error("evaluation file must contain a records array");
  }
  const records = (value as { records: unknown[] }).records.map((record, index) => {
    validateRecord(record, index);
    return record;
  });
  const covered = new Set(records.map((record) => record.scenario));
  const missing = scenarios.filter((scenario) => !covered.has(scenario));
  if (missing.length > 0) throw new Error(`missing scenarios: ${missing.join(", ")}`);
  return records;
}

export function sourceIdsFromMap(value: unknown): Set<string> {
  const sources = (value as { sources?: unknown } | null)?.sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    throw new Error("source map must contain a sources object");
  }
  return new Set(Object.keys(sources));
}

export function calculateMetrics(records: EvalRecord[], validSourceIds: ReadonlySet<string>): EvalMetrics {
  const retrievalRecords = records.filter((record) => record.expected.source_ids.length > 0);
  const recall: number[] = [];
  const precision: number[] = [];
  const hitRate: number[] = [];
  const reciprocalRank: number[] = [];
  const ndcg: number[] = [];
  const averagePrecision: number[] = [];
  let validCitations = 0;
  let finalCitations = 0;
  let behaviorPasses = 0;

  for (const record of retrievalRecords) {
    const relevant = new Set(record.expected.source_ids);
    const retrieved = record.actual.retrieved_source_ids;
    const matches = intersectionCount(retrieved, relevant);
    recall.push(matches / relevant.size);
    precision.push(retrieved.length === 0 ? 0 : matches / new Set(retrieved).size);
    hitRate.push(matches > 0 ? 1 : 0);

    const firstRelevant = retrieved.findIndex((sourceId) => relevant.has(sourceId));
    reciprocalRank.push(firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1));

    let dcg = 0;
    let precisionSum = 0;
    let relevantSeen = 0;
    for (let rank = 0; rank < Math.min(retrieved.length, 5); rank += 1) {
      if (!relevant.has(retrieved[rank])) continue;
      relevantSeen += 1;
      dcg += 1 / Math.log2(rank + 2);
      precisionSum += relevantSeen / (rank + 1);
    }
    const idealCount = Math.min(relevant.size, 5);
    const idealDcg = Array.from({ length: idealCount }, (_, rank) => 1 / Math.log2(rank + 2)).reduce(
      (sum, value) => sum + value,
      0,
    );
    ndcg.push(idealDcg === 0 ? 0 : dcg / idealDcg);
    averagePrecision.push(relevantSeen === 0 ? 0 : precisionSum / relevantSeen);
  }

  for (const record of records) {
    for (const sourceId of record.expected.source_ids) {
      if (!validSourceIds.has(sourceId)) throw new Error(`${record.id} expects unknown source ${sourceId}`);
    }
    finalCitations += record.actual.final_citation_ids.length;
    validCitations += record.actual.final_citation_ids.filter((id) => validSourceIds.has(id)).length;
    const guardMatches =
      record.expected.citation_guard_triggered === undefined ||
      record.expected.citation_guard_triggered === record.actual.citation_guard_triggered;
    if (
      record.expected.refused === record.actual.refused &&
      record.expected.used_source_fallback === record.actual.used_source_fallback &&
      guardMatches
    ) {
      behaviorPasses += 1;
    }
  }

  return {
    cases: records.length,
    retrieval_cases: retrievalRecords.length,
    recall: mean(recall),
    precision: mean(precision),
    hit_rate: mean(hitRate),
    mrr: mean(reciprocalRank),
    ndcg_at_5: mean(ndcg),
    context_precision: mean(averagePrecision),
    context_recall: mean(recall),
    citation_validity: finalCitations === 0 ? 1 : validCitations / finalCitations,
    behavior_pass_rate: records.length === 0 ? 0 : behaviorPasses / records.length,
  };
}

async function main() {
  const file = process.argv[2] ?? fileURLToPath(new URL("../eval/records.json", import.meta.url));
  const sourceMapFile =
    process.argv[3] ?? fileURLToPath(new URL("../data/processed/source-map.json", import.meta.url));
  const records = parseRecords(JSON.parse(await readFile(file, "utf8")));
  const sourceIds = sourceIdsFromMap(JSON.parse(await readFile(sourceMapFile, "utf8")));
  console.log(JSON.stringify(calculateMetrics(records, sourceIds), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
