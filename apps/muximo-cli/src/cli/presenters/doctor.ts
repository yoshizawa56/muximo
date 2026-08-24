import type { DoctorReport } from "@muximo/infrastructure";
import type { CliIo } from "../commands/types.js";

export function presentDoctorReport(report: DoctorReport, io: CliIo): number {
  for (const check of report.commands) {
    io[check.path ? "out" : "err"].write(`${check.command}: ${check.path ?? "missing"}\n`);
  }

  const profile = report.codexProfile;
  if (profile.state === "not-configured") {
    io.out.write("codex profile: not configured\n");
  } else if (profile.state === "missing") {
    io.err.write(`codex profile: missing (${profile.path})\n`);
  } else {
    io.out.write(`codex profile: ${profile.path}\n`);
    io[profile.state === "valid" ? "out" : "err"].write(
      `codex profile validation: ${profile.state === "valid" ? "ok" : "failed"}\n`,
    );
  }

  io.out.write(
    report.mise.path ? `mise: ${report.mise.path}\n` : "mise: unavailable (not required for workspace hooks)\n",
  );
  if (report.details) {
    io.out.write(`database: ${report.details.databaseFile}\n`);
    io.out.write(`codex remote: ${report.details.defaultRemote || "native local mode"}\n`);
    io.out.write(`worktree root pattern: ${report.details.worktreeRootPattern}\n`);
  }
  return report.status;
}
