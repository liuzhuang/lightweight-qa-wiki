import { knowledgeStatus, updateKnowledgeBase, validateKnowledgeBase } from "../src/kb";

const command = process.argv[2];

try {
  if (command === "build" || command === "update") {
    const result = await updateKnowledgeBase({ force: command === "build" });
    console.log(
      result.noOp
        ? `No corpus changes; OpenWiki skipped (${result.knowledgeVersion})`
        : `Knowledge base ${command} complete (${result.knowledgeVersion})`,
    );
  } else if (command === "check") {
    await validateKnowledgeBase();
    console.log("Knowledge base is valid");
  } else if (command === "status") {
    const status = await knowledgeStatus();
    console.log(`Corpus files: ${status.corpusFiles}`);
    console.log(
      `Changes: +${status.changes.added.length} ~${status.changes.modified.length} -${status.changes.deleted.length}`,
    );
    console.log(`Knowledge version: ${status.knowledgeVersion}`);
    console.log(`Wiki ready: ${status.wikiReady ? "yes" : "no"}`);
  } else {
    throw new Error("Usage: kb.ts <build|update|check|status>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
