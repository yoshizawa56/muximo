#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = path
  .relative(root, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join("/");
const maximumFileBytes = 10 * 1024 * 1024;

function gitFiles(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

const files = [
  ...new Set([...gitFiles(["ls-files", "-z"]), ...gitFiles(["ls-files", "--others", "--exclude-standard", "-z"])]),
];

const forbiddenFilePatterns = [
  { label: "environment file", pattern: /(^|\/)\.env(?:$|\.)(?!example$)/i },
  {
    label: "credential-like file",
    pattern:
      /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|known_hosts|credentials?(?:\.[^/]+)?|secrets?(?:\.[^/]+)?)(?:$|\/)/i,
  },
  {
    label: "private/certificate material",
    pattern: /\.(?:pem|key|p12|pfx|mobileprovision|provisionprofile|der|kdbx)$/i,
  },
  { label: "local database", pattern: /\.(?:sqlite|sqlite3|db)(?:[-.]|$)/i },
  {
    label: "generated or runtime artifact",
    pattern: /(^|\/)(?:node_modules|dist|coverage|storybook-static|\.turbo)(?:\/|$)|\.(?:log|dump)$/i,
  },
];

const forbiddenContentPatterns = [
  { label: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "OpenAI API key", pattern: /\bsk-(?:proj|live|admin)-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: "Tailscale auth key", pattern: /\btskey-(?:auth|client)-[A-Za-z0-9_-]{20,}\b/ },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  {
    label: "quoted credential assignment",
    pattern: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'`][^"'`\n]{16,}["'`]/i,
  },
];

const failures = [];
const warnings = [];
const homeDirectory = os.homedir();
const githubActionUsePattern = /^\s*uses:\s*([^\s#]+)/gm;

for (const relativeFile of files) {
  const absoluteFile = path.join(root, relativeFile);
  const normalizedFile = relativeFile.split(path.sep).join("/");

  for (const { label, pattern } of forbiddenFilePatterns) {
    if (pattern.test(normalizedFile)) {
      failures.push(`${normalizedFile}: forbidden ${label}`);
    }
  }

  let stats;
  try {
    stats = statSync(absoluteFile);
  } catch {
    // A tracked file may be deleted in the working tree as part of the change
    // under review. It is not part of the resulting public tree.
    continue;
  }

  if (!stats.isFile()) continue;
  if (stats.size > maximumFileBytes) {
    warnings.push(`${normalizedFile}: large file (${stats.size} bytes)`);
  }

  if (normalizedFile === self) continue;

  let contents;
  try {
    contents = readFileSync(absoluteFile);
  } catch {
    failures.push(`${normalizedFile}: file cannot be read`);
    continue;
  }

  if (contents.includes(0)) continue;

  const text = contents.toString("utf8");
  for (const { label, pattern } of forbiddenContentPatterns) {
    if (pattern.test(text)) {
      failures.push(`${normalizedFile}: possible ${label}`);
    }
  }

  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalizedFile)) {
    for (const match of text.matchAll(githubActionUsePattern)) {
      const actionReference = match[1];
      if (actionReference.startsWith("./")) continue;

      const atIndex = actionReference.lastIndexOf("@");
      const ref = atIndex === -1 ? "" : actionReference.slice(atIndex + 1);
      const line = text.slice(0, match.index).split("\n").length;
      if (!/^[0-9a-f]{40}$/i.test(ref)) {
        failures.push(
          `${normalizedFile}:${line}: GitHub Action is not pinned to a full commit SHA (${actionReference})`,
        );
      }
    }
  }

  if (homeDirectory.length > 4 && text.includes(homeDirectory)) {
    failures.push(`${normalizedFile}: contains the current machine's home directory`);
  }
}

console.log(`Public repository audit scanned ${files.length} file(s).`);
for (const warning of warnings) console.warn(`WARN ${warning}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error("Public repository audit failed. Remove the material or add only an explicit, reviewed placeholder.");
  process.exitCode = 1;
} else {
  console.log("No forbidden credentials, local data files, generated artifacts, or machine-specific paths were found.");
}
