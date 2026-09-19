import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { type DesktopActivityNoticeInput, shouldShowDesktopActivityNotice } from "./viewmodel";

type Context = {};

const cases = [
  {
    name: "shows the notice for desktop activity takeover",
    input: { status: "connected", viewportOwner: "desktop", viewportReason: "desktop_activity" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "shows the notice for desktop resize takeover",
    input: { status: "connected", viewportOwner: "desktop", viewportReason: "desktop_resize" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "shows the notice for desktop focus takeover",
    input: { status: "connected", viewportOwner: "desktop", viewportReason: "desktop_focus" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "hides the notice after an attached desktop-owned state",
    input: { status: "connected", viewportOwner: "desktop", viewportReason: "attached" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "hides the notice after a resumed desktop-owned state",
    input: { status: "connected", viewportOwner: "desktop", viewportReason: "resumed" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "hides the notice after transport loss restores desktop ownership",
    input: { status: "connected", viewportOwner: "desktop", viewportReason: "transport_lost" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "hides the notice while the terminal is reconnecting",
    input: { status: "connecting", viewportOwner: "desktop", viewportReason: "desktop_activity" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "hides the notice while the mobile client owns the viewport",
    input: { status: "connected", viewportOwner: "mobile", viewportReason: "desktop_activity" },
    assert: [returns<Context, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", DesktopActivityNoticeInput, boolean, Context>[];

const table: OperationTable<undefined, "default", DesktopActivityNoticeInput, boolean, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => shouldShowDesktopActivityNotice(input),
  observe: () => ({}),
};

describe("control room desktop activity notice", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
