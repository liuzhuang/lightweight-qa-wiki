import { describe, expect, it } from "vitest";

import { getHealthStatus } from "../src/qa/service";
import type { KnowledgeRepository } from "../src/qa/knowledge";

describe("health check", () => {
  it("reports SQLite unhealthy when the default saver cannot be created", async () => {
    const failToCreateSaver = () => {
      throw Object.assign(new Error("runtime path exists as a file"), { code: "EEXIST" });
    };
    const knowledge = {
      status: async () => ({ version: "v1", wiki: true as const, sourceMap: true as const }),
    } as KnowledgeRepository;

    await expect(getHealthStatus(knowledge, undefined, failToCreateSaver)).resolves.toEqual({
      status: "unhealthy",
      knowledge_version: "v1",
      checks: { wiki: true, source_map: true, sqlite: false },
    });
  });
});
