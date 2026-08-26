import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentMonitor, AgentMonitorContext, AgentObservation, AgentObservationSink } from "./index.js";

const monitorPollIntervalMs = 200;
const discoveryRetryIntervalMs = 500;
const recentOutputLimit = 1_200;
const supportedCodexOriginators = new Set(["codex-tui", "codex_cli_rs", "codex_exec", "codex_chatgpt_ios_remote"]);

export function createCodexMonitor(context: AgentMonitorContext): AgentMonitor {
  return new JsonlAgentMonitor(context, "codex");
}

export function createClaudeMonitor(context: AgentMonitorContext): AgentMonitor {
  return new JsonlAgentMonitor(context, "claude");
}

type Provider = "codex" | "claude";
type JsonObject = Record<string, unknown>;

class JsonlAgentMonitor implements AgentMonitor {
  private readonly startedAtMs: number;
  private readonly providerRoot: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;
  private sink: AgentObservationSink | undefined;
  private stopped = true;
  private nextDiscoveryAt = 0;
  private filePath: string | undefined;
  private offset = 0;
  private lastState: Extract<AgentObservation, { type: "state_changed" }>["state"] | undefined;
  private lastOutput: string | undefined;

  public constructor(
    private readonly context: AgentMonitorContext,
    private readonly provider: Provider,
  ) {
    this.startedAtMs = Date.parse(context.startedAt);
    this.providerRoot =
      provider === "codex"
        ? join(context.environment.CODEX_HOME ?? join(context.environment.HOME ?? homedir(), ".codex"), "sessions")
        : join(
            context.environment.CLAUDE_CONFIG_DIR ?? join(context.environment.HOME ?? homedir(), ".claude"),
            "projects",
          );
  }

  public async start(sink: AgentObservationSink): Promise<void> {
    if (this.timer) return;
    this.sink = sink;
    this.stopped = false;
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, monitorPollIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.polling) await this.polling;
    this.polling = undefined;
    this.sink = undefined;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    const operation = this.pollFile();
    this.polling = operation;
    try {
      await operation;
    } finally {
      if (this.polling === operation) this.polling = undefined;
    }
  }

  private async pollFile(): Promise<void> {
    if (this.stopped) return;
    if (!this.filePath && Date.now() >= this.nextDiscoveryAt) {
      this.filePath = this.findSessionFile();
      this.nextDiscoveryAt = Date.now() + discoveryRetryIntervalMs;
      if (this.filePath) this.offset = 0;
    }
    if (!this.filePath || !existsSync(this.filePath)) {
      this.filePath = undefined;
      return;
    }

    let content: string;
    try {
      content = readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    if (content.length < this.offset) this.offset = 0;
    const delta = content.slice(this.offset);
    const lines = delta.split("\n");
    const incomplete = lines.pop() ?? "";
    this.offset = content.length - incomplete.length;
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = parseObject(line);
      if (!record) continue;
      await this.handleRecord(record);
    }
  }

  private findSessionFile(): string | undefined {
    if (!existsSync(this.providerRoot)) return undefined;
    const files = walkJsonl(this.providerRoot);
    const candidates = files
      .map((file) => ({ file, stat: safeStat(file) }))
      .filter((entry): entry is { file: string; stat: { mtimeMs: number } } => entry.stat !== undefined)
      .filter(({ file, stat }) => this.isCandidate(file, stat.mtimeMs))
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    if (this.context.backendSessionId) return candidates[0]?.file;
    return candidates.length === 1 ? candidates[0]?.file : undefined;
  }

  private isCandidate(file: string, modifiedAtMs: number): boolean {
    if (!file.endsWith(".jsonl")) return false;
    if (this.context.backendSessionId && basename(file).startsWith(this.context.backendSessionId)) return true;
    if (Number.isFinite(this.startedAtMs) && modifiedAtMs < this.startedAtMs - 5_000) return false;
    const header = readPrefix(file);
    if (!header) return false;
    if (this.provider === "codex") return codexHeaderMatches(header, this.context.cwd);
    return claudeHeaderMatches(header, this.context.cwd, this.context.backendSessionId);
  }

  private async handleRecord(record: JsonObject): Promise<void> {
    if (this.provider === "codex") {
      await this.handleCodexRecord(record);
    } else {
      await this.handleClaudeRecord(record);
    }
  }

  private async handleCodexRecord(record: JsonObject): Promise<void> {
    const payload = objectValue(record.payload);
    if (!payload) return;
    const eventType = stringValue(payload.type) ?? "";
    const normalizedType = eventType.toLowerCase();
    if (isApprovalEvent(normalizedType)) {
      await this.emit("waiting_approval", undefined, eventType);
      return;
    }
    if (normalizedType === "task_started" || normalizedType === "turn_started" || normalizedType === "item_started") {
      await this.emit("running", extractOutput(payload), eventType);
      return;
    }
    if (
      normalizedType === "task_complete" ||
      normalizedType === "turn_complete" ||
      normalizedType === "turn_completed"
    ) {
      await this.emit("waiting_input", extractOutput(payload), eventType);
      return;
    }

    const output = extractOutput(payload);
    if (output) await this.emit(this.lastState ?? "running", output, eventType || "output");
  }

  private async handleClaudeRecord(record: JsonObject): Promise<void> {
    const recordType = stringValue(record.type)?.toLowerCase() ?? "";
    if (recordType === "user") {
      await this.emit("running", undefined, "user input");
      return;
    }
    if (recordType === "system") {
      const subtype = stringValue(record.subtype)?.toLowerCase() ?? "";
      if (subtype === "turn_duration" || subtype === "turn_complete" || subtype === "turn_completed") {
        await this.emit("waiting_input", extractOutput(record), subtype);
      } else {
        await this.emit("running", extractOutput(record), subtype || "system event");
      }
      return;
    }
    if (recordType === "result") {
      await this.emit("waiting_input", extractOutput(record), "result");
      return;
    }
    if (recordType !== "assistant") return;

    const content = record.message && objectValue(record.message)?.content;
    const blocks = Array.isArray(content) ? content : [];
    const toolNames = blocks
      .map((block) => objectValue(block))
      .map((block) => stringValue(block?.name)?.toLowerCase())
      .filter((name): name is string => Boolean(name));
    const output = extractOutput(record);
    if (toolNames.some((name) => /askuserquestion|question/.test(name))) {
      await this.emit("waiting_input", output, "user question requested");
    } else if (toolNames.some((name) => /approval|permission|plan/.test(name))) {
      await this.emit("waiting_approval", output, "approval requested");
    } else {
      await this.emit("running", output, "assistant output");
    }
  }

  private async emit(
    state: Extract<AgentObservation, { type: "state_changed" }>["state"],
    output: string | undefined,
    reason: string,
  ): Promise<void> {
    const recentOutput = output ? trimRecentOutput(output) : undefined;
    if (this.lastState === state && this.lastOutput === recentOutput) return;
    this.lastState = state;
    this.lastOutput = recentOutput;
    if (!this.sink) return;
    await this.sink({
      type: "state_changed",
      state,
      reason,
      ...(recentOutput ? { recentOutput } : {}),
    });
  }
}

function walkJsonl(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root, 0);
  return files;
}

function safeStat(file: string): { mtimeMs: number } | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

function readPrefix(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").slice(0, 32_768);
  } catch {
    return undefined;
  }
}

function codexHeaderMatches(header: string, cwd: string): boolean {
  for (const line of header.split("\n")) {
    const record = parseObject(line);
    if (!record) continue;
    const payload = objectValue(record.payload);
    if (stringValue(record.type) !== "session_meta" || !payload) continue;
    const recordCwd = stringValue(payload.cwd);
    const originator = stringValue(payload.originator);
    const threadSource = stringValue(payload.thread_source);
    return (
      recordCwd === cwd && threadSource !== "subagent" && (!originator || supportedCodexOriginators.has(originator))
    );
  }
  return false;
}

function claudeHeaderMatches(header: string, cwd: string, sessionId: string | null): boolean {
  if (sessionId && header.includes(sessionId)) return true;
  for (const line of header.split("\n")) {
    const record = parseObject(line);
    if (!record) continue;
    if (stringValue(record.cwd) === cwd) return true;
    const message = objectValue(record.message);
    if (stringValue(message?.cwd) === cwd) return true;
  }
  return false;
}

function extractOutput(value: JsonObject | undefined): string | undefined {
  if (!value) return undefined;
  const direct =
    stringValue(value.last_agent_message) ??
    stringValue(value.result) ??
    stringValue(value.text) ??
    stringValue(value.message) ??
    stringValue(value.summary);
  if (direct) return direct;
  const message = objectValue(value.message);
  const content = message?.content ?? value.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => objectValue(entry))
    .map((entry) => stringValue(entry?.text) ?? stringValue(entry?.content))
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return text || undefined;
}

function trimRecentOutput(value: string): string | undefined {
  const normalized = value.replaceAll("\r", "").trim();
  if (!normalized) return undefined;
  return normalized.length <= recentOutputLimit ? normalized : `…${normalized.slice(-(recentOutputLimit - 1))}`;
}

function isApprovalEvent(value: string): boolean {
  return /approval|permission|request_user_input|requestuserinput|elicitation/.test(value);
}

function parseObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
