import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseCorpusFile } from "../kb/parsers";
import type { SourceBlock } from "../kb/types";
import { knowledgeNotReady } from "./types";

const SourceRecordSchema = z.object({
  file: z.string().min(1),
  locator: z.string().min(1),
  checksum: z.string().min(1),
  excerpt: z.string(),
});

const SourceMapSchema = z.object({
  version: z.literal(1),
  knowledge_version: z.string().min(1),
  sources: z.record(z.string().regex(/^src_[A-Za-z0-9_-]+$/), SourceRecordSchema),
});

export type SourceRecord = z.infer<typeof SourceRecordSchema> & { id: string };

export type Evidence = {
  sourceId: string;
  text: string;
  origin: "wiki" | "source";
  entryPath?: string;
};

export type ExactMatches = {
  identifiers: string[];
  unmatchedIdentifiers: string[];
  sourceIds: string[];
  entryPaths: string[];
};

type KnowledgeSnapshot = {
  version: string;
  index: string;
  sources: Map<string, SourceRecord>;
  entries: Map<string, string>;
  cacheKey: string;
};

const SOURCE_MARKER = /\[\[SRC:(src_[A-Za-z0-9_-]+)\]\]/g;
const IDENTIFIER = /(?<![A-Za-z0-9])(?=[A-Za-z0-9._/-]*[A-Za-z])(?=[A-Za-z0-9._/-]*\d)[A-Za-z0-9][A-Za-z0-9._/-]{2,127}(?![A-Za-z0-9])/g;
const MAX_EVIDENCE = 12;
const MAX_EVIDENCE_CHARS = 900;

export class KnowledgeRepository {
  private cached?: KnowledgeSnapshot;

  constructor(private readonly root = process.cwd()) {}

  async load(): Promise<KnowledgeSnapshot> {
    const sourceMapPath = path.join(this.root, "data/processed/source-map.json");
    const indexPath = path.join(this.root, "data/wiki/index.md");

    try {
      const [sourceStat, indexStat] = await Promise.all([stat(sourceMapPath), stat(indexPath)]);
      const cacheKey = `${sourceStat.mtimeMs}:${sourceStat.size}:${indexStat.mtimeMs}:${indexStat.size}`;
      if (this.cached?.cacheKey === cacheKey) return this.cached;

      const [sourceMapText, index, entryPaths] = await Promise.all([
        readFile(sourceMapPath, "utf8"),
        readFile(indexPath, "utf8"),
        this.listEntryPaths(path.join(this.root, "data/wiki")),
      ]);
      const parsed = SourceMapSchema.parse(JSON.parse(sourceMapText));
      const sources = new Map(
        Object.entries(parsed.sources).map(([id, value]) => [id, { id, ...value }]),
      );
      const entries = new Map<string, string>();

      for (const relativePath of entryPaths) {
        const content = await readFile(path.join(this.root, "data/wiki", relativePath), "utf8");
        const markers = [...content.matchAll(SOURCE_MARKER)].map((match) => match[1]);
        if (markers.length === 0 || markers.some((id) => !sources.has(id))) {
          throw new Error(`Invalid source marker in ${relativePath}`);
        }
        entries.set(relativePath, content);
      }

      if (entries.size === 0) throw new Error("Wiki contains no concept entries");
      this.cached = { version: parsed.knowledge_version, index, sources, entries, cacheKey };
      return this.cached;
    } catch (error) {
      if (error instanceof Error && error.name === "QaError") throw error;
      throw knowledgeNotReady("Knowledge base files are missing or invalid", error);
    }
  }

  async status(): Promise<{ version: string; wiki: true; sourceMap: true }> {
    const snapshot = await this.load();
    return { version: snapshot.version, wiki: true, sourceMap: true };
  }

  async exactMatches(question: string): Promise<ExactMatches> {
    const snapshot = await this.load();
    const identifiers = [...new Set(question.match(IDENTIFIER) ?? [])];
    const normalized = identifiers.map((value) => value.toLocaleLowerCase());
    const blocks = normalized.length === 0 ? [] : await this.rawBlocks(snapshot);
    const tokensBySource = blocks.map((source) => ({ source, tokens: identifierTokens(source.text) }));
    const unmatchedIdentifiers = identifiers.filter(
      (_, index) => !tokensBySource.some(({ tokens }) => tokens.has(normalized[index])),
    );
    const sourceIds = normalized.length === 0
      ? []
      : tokensBySource
          .filter(({ tokens }) => normalized.some((id) => tokens.has(id)))
          .map(({ source }) => source.source_id);
    const entryPaths = [...snapshot.entries]
      .filter(([, content]) =>
        normalized.some((id) => identifierTokens(content).has(id)) ||
        sourceIds.some((sourceId) => content.includes(`[[SRC:${sourceId}]]`)),
      )
      .map(([entryPath]) => entryPath);
    return { identifiers, unmatchedIdentifiers, sourceIds, entryPaths };
  }

  async rankedPaths(paths: string[]): Promise<string[]> {
    const snapshot = await this.load();
    const available = new Set(snapshot.entries.keys());
    const basenames = new Map([...available].map((entry) => [path.posix.basename(entry), entry]));
    const result: string[] = [];

    for (const candidate of paths) {
      const normalized = path.posix.normalize(candidate.replaceAll("\\", "/").replace(/^\.\//, ""));
      if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) continue;
      const resolved = available.has(normalized) ? normalized : basenames.get(path.posix.basename(normalized));
      if (resolved && !result.includes(resolved)) result.push(resolved);
      if (result.length === 5) break;
    }
    return result;
  }

  async collectWikiEvidence(entryPaths: string[]): Promise<Evidence[]> {
    const snapshot = await this.load();
    const evidence: Evidence[] = [];

    for (const entryPath of entryPaths) {
      const content = snapshot.entries.get(entryPath);
      if (!content) continue;
      for (const paragraph of content.split(/\n\s*\n/)) {
        const sourceIds = [...paragraph.matchAll(SOURCE_MARKER)].map((match) => match[1]);
        for (const sourceId of sourceIds) {
          const source = snapshot.sources.get(sourceId);
          if (!source) continue;
          const text = stripMarkers(paragraph).trim() || source.excerpt;
          evidence.push({
            sourceId,
            text: text.slice(0, MAX_EVIDENCE_CHARS),
            origin: "wiki",
            entryPath,
          });
          if (evidence.length === MAX_EVIDENCE) return evidence;
        }
      }
    }
    return evidence;
  }

  async listSources(): Promise<Array<Pick<SourceRecord, "id" | "file" | "locator">>> {
    const snapshot = await this.load();
    return [...snapshot.sources.values()].map(({ id, file, locator }) => ({ id, file, locator }));
  }

  async searchSources(query: string, limit = 3): Promise<string[]> {
    const snapshot = await this.load();
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const exactIdentifiers = identifierTokens(query);
    return (await this.rawBlocks(snapshot))
      .map((source) => {
        const text = source.text.toLocaleLowerCase();
        const sourceIdentifiers = identifierTokens(source.text);
        return {
          id: source.source_id,
          score: terms.reduce(
            (score, term) => {
              const matches = exactIdentifiers.has(term)
                ? sourceIdentifiers.has(term)
                : text.includes(term);
              return score + (matches ? term.length : 0);
            },
            0,
          ),
        };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(({ id }) => id);
  }

  async readSource(sourceId: string): Promise<Evidence | undefined> {
    const snapshot = await this.load();
    const source = snapshot.sources.get(sourceId);
    if (!source) return undefined;
    try {
      const blocks = await parseCorpusFile(path.join(this.root, "data/corpus"), source.file);
      const block = blocks.find((candidate) => candidate.source_id === sourceId);
      if (!block || block.locator !== source.locator || block.checksum !== source.checksum) {
        throw new Error(`Stale source mapping for ${sourceId}`);
      }
      return {
        sourceId,
        text: block.text.slice(0, MAX_EVIDENCE_CHARS),
        origin: "source",
      };
    } catch (error) {
      throw knowledgeNotReady(`Raw source is missing or stale: ${source.file}`, error);
    }
  }

  async source(sourceId: string): Promise<SourceRecord | undefined> {
    return (await this.load()).sources.get(sourceId);
  }

  private async rawBlocks(snapshot: KnowledgeSnapshot): Promise<SourceBlock[]> {
    try {
      const corpus = path.join(this.root, "data/corpus");
      const files = [...new Set([...snapshot.sources.values()].map(({ file }) => file))];
      const blocks = (await Promise.all(files.map((file) => parseCorpusFile(corpus, file)))).flat();
      if (blocks.length !== snapshot.sources.size) throw new Error("Raw source count changed");
      for (const block of blocks) {
        const mapped = snapshot.sources.get(block.source_id);
        if (
          !mapped ||
          mapped.file !== block.file ||
          mapped.locator !== block.locator ||
          mapped.checksum !== block.checksum
        ) {
          throw new Error(`Stale source mapping for ${block.source_id}`);
        }
      }
      return blocks;
    } catch (error) {
      throw knowledgeNotReady("Raw sources are missing or stale", error);
    }
  }

  private async listEntryPaths(wikiRoot: string): Promise<string[]> {
    const result: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolutePath);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const relativePath = path.relative(wikiRoot, absolutePath).split(path.sep).join("/");
          if (!["index.md", "log.md", "INSTRUCTIONS.md"].includes(relativePath)) result.push(relativePath);
        }
      }
    };
    await walk(wikiRoot);
    return result.sort();
  }
}

export function isNumericSensitive(question: string): boolean {
  return /(?:价格|金额|费用|报价|多少钱|比例|百分比|折扣|数量|多少个|日期|时间|时长|何时|哪天|期限|有效期|¥|￥|\$|\d+(?:\.\d+)?\s*(?:元|万元|%|％|个|台|份|小时|天|日|月|年))/.test(
    question,
  );
}

function stripMarkers(value: string): string {
  return value.replace(SOURCE_MARKER, "").replace(/^#{1,6}\s*/gm, "");
}

function identifierTokens(value: string): Set<string> {
  return new Set((value.match(IDENTIFIER) ?? []).map((token) => token.toLocaleLowerCase()));
}

function searchTerms(query: string): string[] {
  const lower = query.toLocaleLowerCase();
  const terms = [
    ...(lower.match(IDENTIFIER) ?? []),
    ...(lower.match(/\d+(?:\.\d+)?/g) ?? []),
    ...(lower.match(/[a-z][a-z0-9._/-]{1,}/g) ?? []),
  ];
  const ignored = new Set(["什么", "多少", "怎么", "如何", "可以", "是否", "产品", "服务", "请问"]);
  for (const run of lower.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!ignored.has(pair)) terms.push(pair);
    }
  }
  return [...new Set(terms.filter((term) => term.length >= 2 && !ignored.has(term)))];
}
