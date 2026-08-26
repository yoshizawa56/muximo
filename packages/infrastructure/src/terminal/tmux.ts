// This adapter owns all tmux process I/O; application code sees only MuximodHostPort.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { MuximodPanePlacement } from "@muximo/application";

type AgentRuntime = {
  argv: readonly string[];
  execPath: string;
};

const stableAgentSessionMetadataKey = "@muximod.agent_session_id";
const stableAgentExecutionMetadataKey = "@muximod.agent_execution_id";
const stableMobileViewportMetadataKey = "@muximod.mobile_viewport";
const tmuxFormatSeparator = "\u001f";

type TmuxSessionOption = {
  name: string;
  value: string;
};

type TmuxSessionEnvironment = {
  name: string;
  value?: string;
  removed: boolean;
  hidden: boolean;
};

export type TmuxWindowSize = "largest" | "smallest" | "manual" | "latest";
export type TmuxWindowMouse = "on" | "off";

export type TmuxPaneRef = {
  paneId: string;
  windowId: string;
  sessionName: string;
};

export type TmuxPane = TmuxPaneRef & {
  tmuxServerId: string;
  muximodSessionId?: string;
  muximodExecutionId?: string;
  windowName: string;
  windowIndex: number;
  paneIndex: number;
  cwd: string;
  command: string;
  title: string;
  active: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
  muximodPaneId?: string;
  muximodName?: string;
  muximodKind?: string;
  muximodAgentId?: string;
  muximodWorkspaceId?: string;
  muximodManagedSessionId?: string;
  isMuximoMobileViewport?: boolean;
};

export type TmuxLiveSnapshot = {
  panes: TmuxPane[];
  /** False means the adapter could not obtain an authoritative tmux snapshot. */
  available: boolean;
  tmuxServerId: string | null;
  tmuxServerScope: string | null;
};

export type TmuxWindowSnapshot = TmuxPaneRef & {
  layout: string;
  visibleLayout: string;
  zoomed: boolean;
  activePaneId: string;
  width: number;
  height: number;
  windowSize: TmuxWindowSize;
  mouse: TmuxWindowMouse;
};

export type TmuxClient = {
  name: string;
  pid: number;
  tty: string;
  sessionName: string;
  windowId: string;
  paneId: string;
  width: number;
  height: number;
  flags: string;
  activity: number;
};

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export class TmuxError extends Error {
  public constructor(
    message: string,
    public readonly args: string[],
    public readonly result: CommandResult,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

export function resolveMuximoCommand(
  environment: NodeJS.ProcessEnv = process.env,
  runtime: AgentRuntime = process,
): string {
  const configured = environment.MUXIMOD_MUXIMO_COMMAND;
  if (configured) return configured;

  const entry = runtime.argv[1];
  const sourceEntry = entry?.endsWith(".ts") && existsSync(resolve(entry)) ? resolve(entry) : undefined;
  if (sourceEntry) {
    if (sourceEntry.endsWith("/apps/muximo-cli/src/index.ts")) return sourceEntry;
    const sourceLauncherCandidates = [
      resolve(dirname(sourceEntry), "../../../muximo-cli/src/index.ts"),
      resolve(dirname(sourceEntry), "../../../../apps/muximo-cli/src/index.ts"),
    ];
    const siblingAgentEntry = sourceLauncherCandidates.find((candidate) => existsSync(candidate));
    if (siblingAgentEntry) return siblingAgentEntry;
  }
  if (entry && /\.(?:[cm]?js)$/.test(entry) && existsSync(resolve(entry))) return "muximo";
  return runtime.execPath;
}

export class TmuxAdapter {
  private readonly commandPrefix: string[];
  private readonly metadataPrefix: string;
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(
    socketPath = process.env.MUXIMOD_TMUX_SOCKET,
    configFile?: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.environment = { ...process.env, ...environment };
    this.commandPrefix = [...(configFile ? ["-f", configFile] : []), ...(socketPath ? ["-S", socketPath] : [])];
    const namespace = this.environment.MUXIMO_WORKTREE_ID?.trim();
    this.metadataPrefix = namespace ? `@muximod.${sanitizeMetadataNamespace(namespace)}.` : "@muximod.";
  }

  public command(args: string[]): CommandResult {
    const fullArgs = [...this.commandPrefix, ...args];
    const result = spawnSync("tmux", fullArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: this.environment,
    });

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  public require(args: string[]): string {
    const result = this.command(args);
    if (result.status !== 0) {
      throw new TmuxError(result.stderr.trim() || `tmux ${args.join(" ")} failed`, args, result);
    }
    return result.stdout;
  }

  public ensureSession(target: string, cwd: string, command?: string): boolean {
    const existing = this.command(["has-session", "-t", target]);
    if (existing.status === 0) return false;

    const args = ["new-session", "-d", "-s", target, "-c", resolveTmuxCwd(cwd)];
    if (command) args.push(command);
    const created = this.command(args);
    if (created.status !== 0) {
      throw new TmuxError(created.stderr.trim() || `Could not create tmux session: ${target}`, args, created);
    }
    return true;
  }

  public hasSession(target: string): boolean {
    return this.command(["has-session", "-t", target]).status === 0;
  }

  public killSession(target: string): void {
    this.require(["kill-session", "-t", target]);
  }

  public createSession(target: string, cwd: string, command?: string): void {
    const args = ["new-session", "-d", "-s", target, "-c", resolveTmuxCwd(cwd)];
    if (command) args.push(command);
    const created = this.command(args);
    if (created.status !== 0) {
      throw new TmuxError(created.stderr.trim() || `Could not create tmux session: ${target}`, args, created);
    }
  }

  public createGroupedSession(groupSession: string, sessionName: string): void {
    const sourceSessionTarget = exactSessionTarget(groupSession);
    const sourcePaneTarget = exactSessionPaneTarget(groupSession);
    const mobileSessionTarget = exactSessionTarget(sessionName);
    const mobilePaneTarget = exactSessionPaneTarget(sessionName);
    if (this.hasSession(mobileSessionTarget)) {
      throw new Error(`Temporary tmux session already exists: ${sessionName}`);
    }

    const options = this.readSessionOptions(sourcePaneTarget);
    const environment = this.readSessionEnvironment(sourceSessionTarget);
    // Keep the new session alive long enough for the mobile PTY to attach,
    // even when the source server config collects unattached sessions. Run
    // this in the same tmux command queue as creation so the session is
    // protected before the server checks for unattached sessions.
    const createArgs = [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-t",
      sourceSessionTarget,
      ";",
      "set-option",
      "-t",
      mobilePaneTarget,
      "destroy-unattached",
      "off",
      ";",
      "set-option",
      "-t",
      mobilePaneTarget,
      stableMobileViewportMetadataKey,
      "1",
    ];
    let mayHaveCreated = false;
    try {
      mayHaveCreated = true;
      this.require(createArgs);
      for (const entry of environment) this.copySessionEnvironment(mobileSessionTarget, entry);
      for (const option of options) {
        // The temporary session must stay alive until the mobile client
        // attaches, regardless of the source session's cleanup policy.
        if (option.name === "destroy-unattached" || option.name === stableMobileViewportMetadataKey) continue;
        this.setSessionOption(mobilePaneTarget, option.name, option.value);
      }
    } catch (error) {
      if (mayHaveCreated) {
        try {
          this.killSession(mobileSessionTarget);
        } catch {
          // Preserve the original setup error; cleanup is best effort.
        }
      }
      throw error;
    }
  }

  private readSessionOptions(target: string): TmuxSessionOption[] {
    // Keep enumeration separate from value reads because older tmux versions
    // support -A and -v but do not support show-options -F.
    const output = this.require(["show-options", "-A", "-t", target]);
    const options: TmuxSessionOption[] = [];
    for (const line of output
      .split("\n")
      .map((value) => value.trimEnd())
      .filter(Boolean)) {
      const name = line.match(/^\S+/)?.[0]?.replace(/\*$/, "");
      if (!name) throw new Error(`Could not parse tmux session option: ${line}`);
      // Empty array options have no value to copy. Setting the base option
      // would not recreate the empty array and can be rejected by tmux.
      if (!/\s/.test(line)) continue;
      options.push({ name, value: removeTrailingNewline(this.require(["show-options", "-v", "-t", target, name])) });
    }
    return options;
  }

  private readSessionEnvironment(target: string): TmuxSessionEnvironment[] {
    const environment: TmuxSessionEnvironment[] = [];
    for (const hidden of [false, true]) {
      const args = ["show-environment"];
      if (hidden) args.push("-h");
      args.push("-t", target);
      const output = this.require(args);
      for (const line of output
        .split("\n")
        .map((value) => value.trimEnd())
        .filter(Boolean)) {
        if (line.startsWith("-")) {
          const name = line.slice(1);
          if (!name) throw new Error(`Could not parse tmux session environment: ${line}`);
          environment.push({ name, removed: true, hidden });
          continue;
        }
        const separator = line.indexOf("=");
        if (separator <= 0) throw new Error(`Could not parse tmux session environment: ${line}`);
        environment.push({
          name: line.slice(0, separator),
          value: line.slice(separator + 1),
          removed: false,
          hidden,
        });
      }
    }
    return environment;
  }

  private copySessionEnvironment(target: string, entry: TmuxSessionEnvironment): void {
    const args = ["set-environment"];
    if (entry.hidden) args.push("-h");
    if (entry.removed) args.push("-r");
    args.push("-t", target, entry.name);
    if (!entry.removed) {
      if (entry.value === undefined) throw new Error(`Missing value for tmux session environment: ${entry.name}`);
      args.push(entry.value);
    }
    this.require(args);
  }

  public attachSession(target: string): number {
    const result = spawnSync("tmux", [...this.commandPrefix, "attach-session", "-t", target], {
      stdio: "inherit",
      env: this.environment,
    });
    return result.status ?? 1;
  }

  public newWindow(sessionName: string, cwd?: string, command?: string): string {
    const args = ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionName];
    if (cwd) args.push("-c", resolveTmuxCwd(cwd));
    if (command) args.push(command);
    return this.require(args).trim();
  }

  public splitWindow(
    command: string | undefined,
    placement: Exclude<MuximodPanePlacement, "window">,
    targetPaneId: string,
    keepZoomed = false,
  ): string {
    const args = ["split-window", "-d", "-P", "-F", "#{pane_id}"];
    if (keepZoomed) args.push("-Z");
    if (placement === "right") args.push("-h");
    args.push("-t", targetPaneId, "-c", this.resolvePaneCwd(targetPaneId));
    if (command) args.push(command);
    return this.require(args).trim();
  }

  public setPaneOption(paneId: string, name: string, value: string): void {
    this.require(["set-option", "-p", "-t", paneId, name, value]);
  }

  public setSessionOption(sessionName: string, name: string, value: string): void {
    this.require(["set-option", "-t", sessionName, name, value]);
  }

  public setSessionEnvironment(sessionName: string, name: string, value: string): void {
    this.require(["set-environment", "-t", sessionName, name, value]);
  }

  public setAgentPaneMetadata(
    paneId: string,
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
    value: string,
  ): void {
    this.setPaneOption(paneId, this.metadataKey(field), value);
  }

  public resetAgentPaneMetadata(paneId: string): void {
    this.setAgentPaneMetadata(paneId, "kind", "shell");
    this.setAgentPaneMetadata(paneId, "agent_id", "");
    this.setAgentPaneMetadata(paneId, "pane_name", "shell");
  }

  public setManagedSessionMetadata(
    sessionName: string,
    field: "managed_session_id" | "managed" | "wrapper",
    value: string,
  ): void {
    this.setSessionOption(sessionName, this.metadataKey(field), value);
  }

  public setAgentExecutionMetadata(paneId: string, agentSessionId: string, executionId: string): void {
    this.setPaneOption(paneId, stableAgentExecutionMetadataKey, executionId);
    this.setPaneOption(paneId, stableAgentSessionMetadataKey, agentSessionId);
  }

  public clearAgentExecutionMetadata(paneId: string, expectedExecutionId = ""): boolean {
    const current = this.command(["show-options", "-q", "-p", "-v", "-t", paneId, stableAgentExecutionMetadataKey]);
    if (current.status !== 0 || current.stdout.trim() !== expectedExecutionId) return false;
    this.require(["set-option", "-p", "-u", "-t", paneId, stableAgentExecutionMetadataKey]);
    this.require(["set-option", "-p", "-u", "-t", paneId, stableAgentSessionMetadataKey]);
    return true;
  }

  public capturePane(paneId: string, lines = 48): string {
    return this.require(["capture-pane", "-p", "-e", "-S", String(-Math.abs(lines)), "-t", paneId]);
  }

  /**
   * Stores raw bytes in a named tmux buffer. `pasteBuffer` later writes the
   * bytes straight into the pane's PTY without tmux interpreting them as
   * input, which is how terminal-emulator paste semantics are reproduced for
   * sequences such as iTerm2 inline images.
   */
  public setBuffer(name: string, data: Buffer): void {
    const fullArgs = [...this.commandPrefix, "set-buffer", "-b", name, "-n", name];
    const result = spawnSync("tmux", fullArgs, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: data,
      env: this.environment,
    });
    if (result.status !== 0) {
      throw new TmuxError(result.stderr?.trim() || `tmux set-buffer failed for ${name}`, fullArgs, {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    }
  }

  public pasteBuffer(name: string, targetPaneId: string): void {
    this.require(["paste-buffer", "-b", name, "-t", targetPaneId]);
  }

  /** Removes a named buffer; missing buffers are treated as already removed. */
  public deleteBuffer(name: string): void {
    this.command(["delete-buffer", "-b", name]);
  }

  public resolvePane(target: string): TmuxPaneRef {
    const output = this.require(["display-message", "-p", "-t", target, "#{pane_id}\t#{window_id}\t#{session_name}"]);
    const [paneId, windowId, sessionName] = output.trim().split("\t");
    if (!paneId || !windowId || !sessionName) {
      throw new Error(`Could not resolve tmux pane: ${target}`);
    }
    return { paneId, windowId, sessionName };
  }

  public resolvePaneCwd(target: string): string {
    const output = this.require(["display-message", "-p", "-t", target, "#{pane_current_path}"]).trim();
    if (!output) throw new Error(`Could not resolve tmux pane cwd: ${target}`);
    return resolveTmuxCwd(output);
  }

  public listPanes(): TmuxPane[] {
    return this.listPanesSnapshot().panes;
  }

  public listPanesSnapshot(): TmuxLiveSnapshot {
    const separator = tmuxFormatSeparator;
    const args = [
      "list-panes",
      "-a",
      "-F",
      [
        "#{pane_id}",
        "#{window_id}",
        "#{session_name}",
        "#{window_name}",
        "#{window_index}",
        "#{pane_index}",
        "#{pane_current_path}",
        "#{pane_current_command}",
        "#{pane_title}",
        "#{pane_active}",
        "#{pane_left}",
        "#{pane_top}",
        "#{pane_width}",
        "#{pane_height}",
        "#{window_width}",
        "#{window_height}",
        this.metadataFormat("pane_id"),
        this.metadataFormat("pane_name"),
        this.metadataFormat("kind"),
        this.metadataFormat("agent_id"),
        this.metadataFormat("workspace_id"),
        this.metadataFormat("managed_session_id"),
        `#{${stableAgentSessionMetadataKey}}`,
        `#{${stableAgentExecutionMetadataKey}}`,
        "#{pid}",
        "#{start_time}",
        "#{socket_path}",
        `#{${stableMobileViewportMetadataKey}}`,
      ].join(separator),
    ];
    const result = this.command(args);
    if (result.status !== 0) {
      // tmux exits its server after the last session disappears. An empty
      // live snapshot is more useful to callers than treating that normal
      // lifecycle transition as an infrastructure failure.
      if (isTmuxServerGone(result.stderr))
        return { panes: [], available: false, tmuxServerId: null, tmuxServerScope: null };
      throw new TmuxError(result.stderr.trim() || `tmux ${args.join(" ")} failed`, args, result);
    }
    const output = result.stdout;

    const panes = output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const [
          paneId,
          windowId,
          sessionName,
          windowName,
          windowIndex,
          paneIndex,
          cwd,
          command,
          title,
          active,
          left,
          top,
          width,
          height,
          windowWidth,
          windowHeight,
          muximodPaneId,
          muximodName,
          muximodKind,
          muximodAgentId,
          muximodWorkspaceId,
          muximodManagedSessionId,
          muximodSessionId,
          muximodExecutionId,
          serverPid,
          serverStartTime,
          socketPath,
          mobileViewport,
        ] = splitTmuxFormatLine(line, separator);
        if (
          !paneId ||
          !windowId ||
          !sessionName ||
          windowName === undefined ||
          windowIndex === undefined ||
          paneIndex === undefined ||
          cwd === undefined ||
          command === undefined ||
          title === undefined
        ) {
          throw new Error(`Could not parse tmux pane: ${line}`);
        }
        if (!serverPid || !serverStartTime || !socketPath) throw new Error(`Could not identify tmux server: ${line}`);
        const tmuxServerScope = hashServerScope(socketPath);
        return {
          paneId,
          windowId,
          sessionName,
          tmuxServerId: `${tmuxServerScope}:${serverPid}:${serverStartTime}`,
          windowName,
          windowIndex: parseDimension(windowIndex, "window index"),
          paneIndex: parseDimension(paneIndex, "pane index"),
          cwd,
          command,
          title,
          active: active === "1",
          left: parseDimension(left, "pane left"),
          top: parseDimension(top, "pane top"),
          width: parseDimension(width, "pane width"),
          height: parseDimension(height, "pane height"),
          windowWidth: parseDimension(windowWidth, "window width"),
          windowHeight: parseDimension(windowHeight, "window height"),
          muximodPaneId: nonEmpty(muximodPaneId),
          muximodName: nonEmpty(muximodName),
          muximodKind: nonEmpty(muximodKind),
          muximodAgentId: nonEmpty(muximodAgentId),
          muximodWorkspaceId: nonEmpty(muximodWorkspaceId),
          muximodManagedSessionId: nonEmpty(muximodManagedSessionId),
          muximodSessionId: nonEmpty(muximodSessionId),
          muximodExecutionId: nonEmpty(muximodExecutionId),
          ...(mobileViewport === "1" ? { isMuximoMobileViewport: true } : {}),
        } satisfies TmuxPane;
      })
      .filter((pane) => !pane.isMuximoMobileViewport);

    return {
      panes,
      available: true,
      tmuxServerId: panes[0]?.tmuxServerId ?? null,
      tmuxServerScope: panes[0]?.tmuxServerId?.split(":", 1)[0] ?? null,
    };
  }

  public snapshotWindow(pane: TmuxPaneRef): TmuxWindowSnapshot {
    const output = this.require([
      "display-message",
      "-p",
      "-t",
      pane.paneId,
      "#{window_layout}\t#{window_visible_layout}\t#{window_zoomed_flag}\t#{window_width}\t#{window_height}",
    ]);
    const [layout, visibleLayout, zoomed, width, height] = output.trim().split("\t");
    if (!layout || !visibleLayout || !width || !height) {
      throw new Error(`Could not snapshot tmux window: ${pane.windowId}`);
    }

    const activePaneId = this.findActivePane(pane.windowId);
    const windowSize = this.readWindowSize(pane.windowId);
    const mouse = this.readWindowMouse(pane.windowId);

    return {
      ...pane,
      layout,
      visibleLayout,
      zoomed: zoomed === "1",
      activePaneId,
      width: parseDimension(width, "window width"),
      height: parseDimension(height, "window height"),
      windowSize,
      mouse,
    };
  }

  public listClients(): TmuxClient[] {
    const output = this.require([
      "list-clients",
      "-F",
      "#{client_name}\t#{client_pid}\t#{client_tty}\t#{client_session}\t#{window_id}\t#{pane_id}\t#{client_width}\t#{client_height}\t#{client_flags}\t#{client_activity}",
    ]);

    return output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const [name, pid, tty, sessionName, windowId, paneId, width, height, flags, activity] = line.split("\t");
        return {
          name,
          pid: parseDimension(pid, "client pid"),
          tty,
          sessionName,
          windowId,
          paneId,
          width: parseDimension(width, "client width"),
          height: parseDimension(height, "client height"),
          flags,
          activity: parseDimension(activity, "client activity"),
        } satisfies TmuxClient;
      })
      .sort((left, right) => right.activity - left.activity);
  }

  public findClientByPid(pid: number): TmuxClient | undefined {
    return this.listClients().find((client) => client.pid === pid);
  }

  public clientView(clientName: string): TmuxClient {
    const output = this.require([
      "display-message",
      "-p",
      "-c",
      clientName,
      "#{client_name}\t#{client_pid}\t#{client_tty}\t#{client_session}\t#{window_id}\t#{pane_id}\t#{client_width}\t#{client_height}\t#{client_flags}\t#{client_activity}",
    ]);
    const [name, pid, tty, sessionName, windowId, paneId, width, height, flags, activity] = output.trim().split("\t");
    return {
      name,
      pid: parseDimension(pid, "client pid"),
      tty,
      sessionName,
      windowId,
      paneId,
      width: parseDimension(width, "client width"),
      height: parseDimension(height, "client height"),
      flags,
      activity: parseDimension(activity, "client activity"),
    };
  }

  public attachArgs(target: string): string[] {
    return [...this.commandPrefix, "attach-session", "-f", "active-pane", "-t", target];
  }

  public switchClient(clientName: string, targetPane: string, keepZoomed = false): void {
    const args = ["switch-client"];
    if (keepZoomed) args.push("-Z");
    args.push("-c", clientName, "-t", targetPane);
    this.require(args);
  }

  public setClientFlags(clientName: string, flags: string): void {
    this.require(["refresh-client", "-f", flags, "-t", clientName]);
  }

  public refreshClient(clientName: string): void {
    // refresh-client without -S requests a complete client redraw. Do not use
    // -r here: in newer tmux versions it reports terminal colours for control
    // mode clients, and older versions reject it entirely.
    this.require(["refresh-client", "-t", clientName]);
  }

  public selectPane(paneId: string, keepZoomed = false): void {
    const args = ["select-pane"];
    if (keepZoomed) args.push("-Z");
    args.push("-t", paneId);
    this.require(args);
  }

  public zoomPane(paneId: string): void {
    this.require(["resize-pane", "-Z", "-t", paneId]);
  }

  public selectLayout(windowId: string, layout: string): void {
    this.require(["select-layout", "-t", windowId, layout]);
  }

  public readWindowSize(windowId: string): TmuxWindowSize {
    const output = this.require(["display-message", "-p", "-t", windowId, "#{window-size}"]).trim();
    if (output === "largest" || output === "smallest" || output === "manual" || output === "latest") {
      return output;
    }
    throw new Error(`Unsupported tmux window-size value: ${output}`);
  }

  public setWindowSize(windowId: string, value: TmuxWindowSize): void {
    this.setWindowOption(windowId, "window-size", value);
  }

  public readWindowMouse(windowId: string): TmuxWindowMouse {
    const output = this.require(["display-message", "-p", "-t", windowId, "#{mouse}"]).trim();
    if (output === "1") return "on";
    if (output === "0") return "off";
    throw new Error(`Unsupported tmux mouse value: ${output}`);
  }

  public setWindowMouse(windowId: string, value: TmuxWindowMouse): void {
    this.setWindowOption(windowId, "mouse", value);
  }

  public setWindowOption(windowId: string, name: string, value: string): void {
    this.require(["set-window-option", "-t", windowId, name, value]);
  }

  public resizeWindow(windowId: string, width: number, height: number): void {
    this.require(["resize-window", "-t", windowId, "-x", String(width), "-y", String(height)]);
  }

  public resizeWindowToLargest(windowId: string): void {
    this.require(["resize-window", "-A", "-t", windowId]);
  }

  public resizeWindowToSmallest(windowId: string): void {
    this.require(["resize-window", "-a", "-t", windowId]);
  }

  public restoreWindowSize(
    snapshot: Pick<TmuxWindowSnapshot, "windowId" | "windowSize" | "width" | "height">,
    preferredClient?: Pick<TmuxClient, "width" | "height">,
  ): void {
    const width = preferredClient?.width ?? snapshot.width;
    const height = preferredClient?.height ?? snapshot.height;

    switch (snapshot.windowSize) {
      case "largest":
        this.resizeWindowToLargest(snapshot.windowId);
        break;
      case "smallest":
        this.resizeWindowToSmallest(snapshot.windowId);
        break;
      case "manual":
        this.resizeWindow(snapshot.windowId, snapshot.width, snapshot.height);
        break;
      case "latest":
        this.resizeWindow(snapshot.windowId, width, height);
        if (preferredClient) this.setWindowSize(snapshot.windowId, "latest");
        break;
    }

    if (snapshot.windowSize !== "manual") {
      this.setWindowSize(snapshot.windowId, snapshot.windowSize);
    }
  }

  public restoreSnapshot(snapshot: TmuxWindowSnapshot, preferredClient?: TmuxClient): void {
    this.selectLayout(snapshot.windowId, snapshot.layout);
    this.selectPane(snapshot.activePaneId);
    if (snapshot.zoomed) {
      this.zoomPane(snapshot.activePaneId);
    }
    this.restoreWindowSize(snapshot, preferredClient);
    this.setWindowMouse(snapshot.windowId, snapshot.mouse);
  }

  public setHook(name: string, index: number, command: string): void {
    this.require(["set-hook", "-g", `${name}[${index}]`, command]);
  }

  public unsetHook(name: string, index: number): void {
    this.require(["set-hook", "-gu", `${name}[${index}]`]);
  }

  private metadataKey(
    field:
      | "pane_id"
      | "pane_name"
      | "kind"
      | "agent_id"
      | "workspace_id"
      | "managed_session_id"
      | "managed"
      | "wrapper",
  ): string {
    return `${this.metadataPrefix}${field}`;
  }

  private metadataFormat(
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
  ): string {
    return `#{${this.metadataKey(field)}}`;
  }

  private findActivePane(windowId: string): string {
    const output = this.require(["list-panes", "-t", windowId, "-F", "#{pane_id}\t#{pane_active}"]);
    const active = output
      .split("\n")
      .map((line) => line.trimEnd().split("\t"))
      .find(([, isActive]) => isActive === "1");
    if (!active?.[0]) throw new Error(`Could not resolve active tmux pane: ${windowId}`);
    return active[0];
  }
}

export function buildMuximoShellCommand(
  binary = resolveMuximoCommand(),
  environment: Record<string, string> = {},
  command?: string,
  wrapperArgs: readonly string[] = [],
): string {
  const prefix = Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const args = [shellQuote(binary), "shell", ...wrapperArgs.map(shellQuote)];
  const wrapper = args.join(" ");
  return `${prefix ? `${prefix} ` : ""}${wrapper}${command ? ` -- ${command}` : ""}`;
}

export function configureManagedTmuxSession(
  tmux: TmuxAdapter,
  sessionName: string,
  managedSessionId: string,
  binary = resolveMuximoCommand(),
): void {
  tmux.setSessionOption(sessionName, "default-command", buildMuximoShellCommand(binary));
  tmux.setSessionEnvironment(sessionName, "MUXIMOD_MANAGED_SESSION_ID", managedSessionId);
  tmux.setSessionEnvironment(sessionName, "MUXIMOD_MANAGED_SESSION_NAME", sessionName);
  tmux.setManagedSessionMetadata(sessionName, "managed_session_id", managedSessionId);
  tmux.setManagedSessionMetadata(sessionName, "managed", "1");
  tmux.setManagedSessionMetadata(sessionName, "wrapper", "muximo-shell");
}

function sanitizeMetadataNamespace(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

function parseDimension(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value ?? ""}`);
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveTmuxCwd(cwd: string): string {
  const expanded = cwd === "~" ? homedir() : cwd.startsWith("~/") ? `${homedir()}/${cwd.slice(2)}` : cwd;
  return resolve(expanded);
}

function splitTmuxFormatLine(line: string, separator: string): string[] {
  const fields = line.split(separator);
  return fields.length > 1 ? fields : line.split("\\037");
}

function removeTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function exactSessionTarget(sessionName: string): string {
  return `=${sessionName}`;
}

function exactSessionPaneTarget(sessionName: string): string {
  return `${exactSessionTarget(sessionName)}:`;
}

function isTmuxServerGone(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return message.includes("no server running") || message.includes("no sessions") || message.includes("server exited");
}

function hashServerScope(socketPath: string): string {
  return createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
}
