import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

import type { SourceBlock } from "./types";

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceId(file: string, locator: string): string {
  const normalized = file.split(path.sep).join("/").normalize("NFC");
  return `src_${sha256(`${normalized}\0${locator}`).slice(0, 16)}`;
}

function block(file: string, locator: string, text: string): SourceBlock {
  return {
    source_id: sourceId(file, locator),
    file,
    locator,
    text,
    checksum: sha256(text),
    excerpt: text.slice(0, 500),
  };
}

export async function assertSafeCorpusFile(root: string, candidate: string): Promise<string> {
  const rootPath = await realpath(root);
  const absolute = path.resolve(rootPath, candidate);
  const relative = path.relative(rootPath, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes corpus root: ${candidate}`);
  }
  if ((await lstat(absolute)).isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed: ${candidate}`);
  }
  const resolved = await realpath(absolute);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Resolved path escapes corpus root: ${candidate}`);
  }
  return resolved;
}

export async function parseMarkdown(root: string, relativeFile: string): Promise<SourceBlock[]> {
  const contents = await readFile(await assertSafeCorpusFile(root, relativeFile), "utf8");
  const lines = contents.replace(/\r\n?/g, "\n").split("\n");
  const blocks: SourceBlock[] = [];
  let start = -1;
  let paragraph: string[] = [];
  const flush = (end: number) => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push(block(relativeFile, `L${start + 1}-L${end}`, text));
    start = -1;
    paragraph = [];
  };
  lines.forEach((line, index) => {
    if (!line.trim()) {
      if (paragraph.length) flush(index);
      return;
    }
    if (start < 0) start = index;
    paragraph.push(line);
  });
  if (paragraph.length) flush(lines.length);
  return blocks;
}

export function excelCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "formula" in value) {
    const formula = value as ExcelJS.CellFormulaValue;
    return formula.result === undefined || formula.result === null || formula.result === ""
      ? `=${formula.formula}`
      : excelCellText(formula.result as ExcelJS.CellValue);
  }
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function parseExcel(root: string, relativeFile: string): Promise<SourceBlock[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await assertSafeCorpusFile(root, relativeFile));
  const blocks: SourceBlock[] = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        const value = excelCellText(cell.value).trim();
        if (value) cells.push(`${sheet.getColumn(column).letter}=${value}`);
      });
      if (cells.length) {
        blocks.push(block(relativeFile, `${sheet.name}!R${rowNumber}`, cells.join(" | ")));
      }
    });
  });
  return blocks;
}

function collectSlideText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSlideText(item, output));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "t" && (typeof child === "string" || typeof child === "number")) {
        output.push(String(child));
      } else {
        collectSlideText(child, output);
      }
    }
  }
}

export async function parsePowerPoint(root: string, relativeFile: string): Promise<SourceBlock[]> {
  const archive = unzipSync(new Uint8Array(await readFile(await assertSafeCorpusFile(root, relativeFile))));
  return Object.entries(archive)
    .flatMap(([name, bytes]) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
      if (!match) return [];
      const text: string[] = [];
      collectSlideText(xmlParser.parse(new TextDecoder().decode(bytes)), text);
      const joined = text.map((item) => item.trim()).filter(Boolean).join("\n");
      return joined ? [{ number: Number(match[1]), value: block(relativeFile, `slide:${match[1]}`, joined) }] : [];
    })
    .sort((a, b) => a.number - b.number)
    .map(({ value }) => value);
}

export async function parseCorpusFile(root: string, relativeFile: string): Promise<SourceBlock[]> {
  switch (path.extname(relativeFile).toLowerCase()) {
    case ".md":
      return parseMarkdown(root, relativeFile);
    case ".xlsx":
      return parseExcel(root, relativeFile);
    case ".pptx":
      return parsePowerPoint(root, relativeFile);
    default:
      throw new Error(`Unsupported corpus file: ${relativeFile}`);
  }
}
