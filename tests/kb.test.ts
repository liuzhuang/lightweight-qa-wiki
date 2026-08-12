import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSafeCorpusFile,
  compareManifests,
  compileCorpus,
  createManifest,
  excelCellText,
  parseExcel,
  parseMarkdown,
  parsePowerPoint,
  prepareOpenWikiWorkspace,
  sourceId,
  updateKnowledgeBase,
  validateArtifactDirs,
  validateKnowledgeBase,
  type Manifest,
  type WikiBuilder,
} from "../src/kb";

const temporary: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lightweight-kb-"));
  temporary.push(root);
  await mkdir(path.join(root, "data", "corpus"), { recursive: true });
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fakeWiki: WikiBuilder = async ({ processed, output }) => {
  const content = await readFile(path.join(processed, "content.md"), "utf8");
  const marker = content.match(/\[\[SRC:(src_[a-f0-9]{16})\]\]/)?.[1];
  if (!marker) throw new Error("fixture has no source marker");
  await mkdir(path.join(output, "concepts"), { recursive: true });
  await writeFile(path.join(output, "index.md"), '---\nokf_version: "0.1"\n---\n# Index\n\n[Fact](concepts/fact.md)\n');
  await writeFile(path.join(output, "concepts", "fact.md"), `---\ntype: Fact\n---\n# Fact\n\n[[SRC:${marker}]]\n`);
};

async function artifactFixture() {
  const root = await tempRoot();
  const corpus = path.join(root, "data", "corpus");
  const processed = path.join(root, "data", "processed");
  const wiki = path.join(root, "data", "wiki");
  await writeFile(path.join(corpus, "fact.md"), "fact\n");
  await compileCorpus(corpus, processed, await createManifest(corpus));
  await fakeWiki({
    root,
    workspace: "",
    processed,
    output: wiki,
    previousWiki: "",
    previousWorkspace: "",
  });
  const page = path.join(wiki, "concepts", "fact.md");
  const marker = (await readFile(page, "utf8")).match(/\[\[SRC:(src_[a-f0-9]{16})\]\]/)?.[1];
  if (!marker) throw new Error("fixture has no source marker");
  return { processed, wiki, page, marker };
}

describe("corpus parsers", () => {
  it("keeps Markdown paragraph line ranges and stable source ids", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "data", "corpus", "guide.md"), "first\nline\n\nsecond\n");
    const blocks = await parseMarkdown(path.join(root, "data", "corpus"), "guide.md");
    expect(blocks.map((item) => item.locator)).toEqual(["L1-L2", "L4-L4"]);
    expect(blocks[0].source_id).toBe(sourceId("guide.md", "L1-L2"));
    expect(sourceId("guide.md", "L1-L2")).toBe(sourceId("guide.md", "L1-L2"));
  });

  it("reads non-empty Excel rows and falls back to formula text", async () => {
    const root = await tempRoot();
    const corpus = path.join(root, "data", "corpus");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Prices");
    sheet.addRow([2, { formula: "A1*2" }]);
    await workbook.xlsx.writeFile(path.join(corpus, "prices.xlsx"));
    const blocks = await parseExcel(corpus, "prices.xlsx");
    expect(blocks[0]).toMatchObject({ locator: "Prices!R1" });
    expect(blocks[0].text).toContain("B==A1*2");
    expect(excelCellText({ formula: "A1*2", result: 4 })).toBe("4");
  });

  it("extracts slide text from the bundled PPTX", async () => {
    const corpus = path.join(process.cwd(), "data", "corpus");
    const slides = await parsePowerPoint(corpus, "service-policy.pptx");
    expect(slides.map((slide) => slide.locator)).toEqual(["slide:1", "slide:2"]);
    expect(slides[1].text).toContain("7 个自然日");
  });

  it("rejects traversal and symbolic links", async () => {
    const root = await tempRoot();
    const corpus = path.join(root, "data", "corpus");
    await expect(assertSafeCorpusFile(corpus, "../outside.md")).rejects.toThrow("escapes corpus root");
    await writeFile(path.join(root, "outside.md"), "outside");
    await symlink(path.join(root, "outside.md"), path.join(corpus, "link.md"));
    await expect(assertSafeCorpusFile(corpus, "link.md")).rejects.toThrow("Symbolic links");
  });
});

describe("incremental pipeline", () => {
  it("classifies add, modify, delete, and rename", () => {
    const previous: Manifest = { version: 1, knowledge_version: "old", files: { "a.md": "1", "b.md": "2" } };
    const current: Manifest = { version: 1, knowledge_version: "new", files: { "a.md": "3", "c.md": "2" } };
    expect(compareManifests(previous, current)).toEqual({ added: ["c.md"], modified: ["a.md"], deleted: ["b.md"] });
  });

  it("skips unchanged input and preserves the last Wiki on failure", async () => {
    const root = await tempRoot();
    const corpusFile = path.join(root, "data", "corpus", "fact.md");
    await writeFile(corpusFile, "version one\n");
    const builder = vi.fn(fakeWiki);
    await updateKnowledgeBase({ root, force: true, wikiBuilder: builder });
    const manifestBefore = await readFile(path.join(root, "data", "processed", "manifest.json"), "utf8");
    const wikiBefore = await readFile(path.join(root, "data", "wiki", "concepts", "fact.md"), "utf8");
    expect((await updateKnowledgeBase({ root, wikiBuilder: builder })).noOp).toBe(true);
    expect(builder).toHaveBeenCalledTimes(1);

    await writeFile(corpusFile, "version two\n");
    await expect(
      updateKnowledgeBase({ root, wikiBuilder: async () => Promise.reject(new Error("OpenWiki failed")) }),
    ).rejects.toThrow("OpenWiki failed");
    expect(await readFile(path.join(root, "data", "processed", "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(path.join(root, "data", "wiki", "concepts", "fact.md"), "utf8")).toBe(wikiBefore);
  });

  it("build from scratch does not expose the previous Wiki to its builder", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "data", "corpus", "fact.md"), "fact\n");
    await updateKnowledgeBase({ root, force: true, wikiBuilder: fakeWiki });
    const builder = vi.fn(async (context: Parameters<WikiBuilder>[0]) => {
      await expect(readFile(path.join(context.previousWiki, "index.md"), "utf8")).rejects.toThrow();
      await fakeWiki(context);
    });
    await updateKnowledgeBase({ root, force: true, wikiBuilder: builder });
    expect(builder).toHaveBeenCalledOnce();
  });

  it("enforces the exclusive update lock", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "data", "corpus", "fact.md"), "fact\n");
    await mkdir(path.join(root, ".runtime"), { recursive: true });
    await writeFile(path.join(root, ".runtime", "kb.lock"), "busy");
    await expect(updateKnowledgeBase({ root, force: true, wikiBuilder: fakeWiki })).rejects.toThrow("already running");
  });

  it("rejects unknown Wiki source markers", async () => {
    const root = await tempRoot();
    const corpus = path.join(root, "data", "corpus");
    const processed = path.join(root, "data", "processed");
    const wiki = path.join(root, "data", "wiki");
    await writeFile(path.join(corpus, "fact.md"), "fact\n");
    await compileCorpus(corpus, processed, await createManifest(corpus));
    await fakeWiki({ root, workspace: "", previousWorkspace: "", processed, output: wiki, previousWiki: "" });
    const page = path.join(wiki, "concepts", "fact.md");
    await writeFile(page, '---\ntype: Fact\n---\n[[SRC:src_0000000000000000]]\n');
    await expect(validateArtifactDirs(processed, wiki)).rejects.toThrow("Unknown source marker");
  });

  it("rejects invalid YAML in opening frontmatter", async () => {
    const { processed, wiki } = await artifactFixture();
    await writeFile(
      path.join(wiki, "index.md"),
      '---\nokf_version: "0.1"\nbroken: [\n---\n# Index\n',
    );
    await expect(validateArtifactDirs(processed, wiki)).rejects.toThrow("Invalid YAML frontmatter");
  });

  it("rejects root frontmatter placed after Markdown body", async () => {
    const { processed, wiki } = await artifactFixture();
    await writeFile(
      path.join(wiki, "index.md"),
      '# Body first\n\n---\nokf_version: "0.1"\n---\n# Index\n',
    );
    await expect(validateArtifactDirs(processed, wiki)).rejects.toThrow("must start with YAML frontmatter");
  });

  it("rejects an empty concept type", async () => {
    const { processed, wiki, page, marker } = await artifactFixture();
    await writeFile(page, `---\ntype: "   "\n---\n# Fact\n\n[[SRC:${marker}]]\n`);
    await expect(validateArtifactDirs(processed, wiki)).rejects.toThrow(
      "type must be a non-empty string",
    );
  });

  it("detects processed artifacts that no longer match the corpus", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "data", "corpus", "fact.md"), "fact\n");
    await updateKnowledgeBase({ root, force: true, wikiBuilder: fakeWiki });
    const contentPath = path.join(root, "data", "processed", "content.md");
    await writeFile(contentPath, `${await readFile(contentPath, "utf8")}tampered\n`);
    await expect(validateKnowledgeBase(root)).rejects.toThrow("Processed artifacts do not match");
  });

  it("preserves the OpenWiki Git baseline across consecutive updates", async () => {
    const root = await tempRoot();
    const corpus = path.join(root, "data", "corpus");
    const previousWiki = path.join(root, "data", "wiki");
    const baseline = path.join(root, ".runtime", "openwiki-workspace");
    const firstProcessed = path.join(root, "first-processed");
    const firstWorkspace = path.join(root, "first-workspace");
    await writeFile(path.join(corpus, "fact.md"), "version one\n");
    await compileCorpus(corpus, firstProcessed);
    expect(
      await prepareOpenWikiWorkspace({
        workspace: firstWorkspace,
        previousWorkspace: baseline,
        processed: firstProcessed,
        previousWiki,
      }),
    ).toBe("--init");
    const firstHead = readGit(firstWorkspace, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(firstWorkspace, "openwiki", ".last-update.json"),
      `${JSON.stringify({ updatedAt: new Date(0).toISOString(), command: "init", gitHead: firstHead, model: "test" })}\n`,
    );
    await mkdir(path.dirname(baseline), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(firstWorkspace, baseline);

    await writeFile(path.join(corpus, "fact.md"), "version two\n");
    const secondProcessed = path.join(root, "second-processed");
    const secondWorkspace = path.join(root, "second-workspace");
    await compileCorpus(corpus, secondProcessed);
    expect(
      await prepareOpenWikiWorkspace({
        workspace: secondWorkspace,
        previousWorkspace: baseline,
        processed: secondProcessed,
        previousWiki,
      }),
    ).toBe("--update");
    const secondHead = readGit(secondWorkspace, ["rev-parse", "HEAD"]);
    expect(readGit(secondWorkspace, ["merge-base", "--is-ancestor", firstHead, secondHead])).toBe("");
    expect(readGit(secondWorkspace, ["diff", "--name-only", `${firstHead}..${secondHead}`])).toContain(
      "knowledge/processed/",
    );
  });

  it("does not reuse a workspace that only belongs to a parent Git repository", async () => {
    const root = await tempRoot();
    const corpus = path.join(root, "data", "corpus");
    const processed = path.join(root, "processed");
    const workspace = path.join(root, ".runtime", "staged-workspace");
    const falseBaseline = path.join(root, ".runtime", "openwiki-workspace");
    await writeFile(path.join(corpus, "fact.md"), "fact\n");
    await compileCorpus(corpus, processed);
    readGit(root, ["init", "-q", "-b", "main"]);
    await mkdir(falseBaseline, { recursive: true });

    expect(
      await prepareOpenWikiWorkspace({
        workspace,
        previousWorkspace: falseBaseline,
        processed,
        previousWiki: path.join(root, "missing-wiki"),
      }),
    ).toBe("--init");
    const { realpath } = await import("node:fs/promises");
    expect(await realpath(readGit(workspace, ["rev-parse", "--show-toplevel"]))).toBe(
      await realpath(workspace),
    );
    expect(readGit(root, ["status", "--short"])).not.toContain("knowledge/processed");
  });
});

function readGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
}
