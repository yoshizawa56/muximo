import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { normalizeAgentSessionName } from "./index.js";

type EmptyContext = {};
type NameInput = string;

const cases = [
  {
    name: "lowercases a name and turns spaces into hyphens",
    input: "API review",
    assert: [returns<EmptyContext, string>("api-review")],
  },
  {
    name: "removes git ref and path punctuation",
    input: "feature/foo:bar? [draft]",
    assert: [returns<EmptyContext, string>("feature-foo-bar-draft")],
  },
  {
    name: "avoids repeated dots and lock suffixes",
    input: "...My..branch.lock",
    assert: [returns<EmptyContext, string>("my-branch-lock")],
  },
  {
    name: "keeps Japanese letters as best effort while normalizing spaces",
    input: "日本語 レビュー",
    assert: [returns<EmptyContext, string>("日本語-レビュー")],
  },
  {
    name: "limits the normalized name to 64 characters",
    input: "A".repeat(80),
    assert: [returns<EmptyContext, string>("a".repeat(64))],
  },
  {
    name: "limits multibyte names to a safe UTF-8 component size",
    input: "𐌀".repeat(64),
    assert: [returns<EmptyContext, string>("𐌀".repeat(60))],
  },
  {
    name: "rejects a name with no letters or numbers",
    input: "--- ...",
    assert: [hasError<EmptyContext, string>({ code: "invalid_agent_name", name: "InvalidAgentSessionNameError" })],
  },
] satisfies readonly OperationCase<"default", NameInput, string, EmptyContext>[];

const table: OperationTable<undefined, "default", NameInput, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => normalizeAgentSessionName(input),
  observe: () => ({}),
};

describe("agent session name normalization", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
