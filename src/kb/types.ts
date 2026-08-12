export type SourceRecord = {
  file: string;
  locator: string;
  checksum: string;
  excerpt: string;
};

export type SourceMap = {
  version: 1;
  knowledge_version: string;
  sources: Record<string, SourceRecord>;
};

export type Manifest = {
  version: 1;
  knowledge_version: string;
  files: Record<string, string>;
};

export type SourceBlock = SourceRecord & {
  source_id: string;
  text: string;
};

export type ChangeSet = {
  added: string[];
  modified: string[];
  deleted: string[];
};
