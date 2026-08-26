import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";

const root = process.cwd();
const workspaceRoots = ["apps", "packages"];
const workspacePackages = new Map();
const errors = [];

for (const workspaceRoot of workspaceRoots) {
  for (const entry of readdirSync(join(root, workspaceRoot))) {
    const directory = join(root, workspaceRoot, entry);
    if (!statSync(directory).isDirectory()) continue;
    const packageFile = join(directory, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
      workspacePackages.set(packageJson.name, {
        directory,
        relativeDirectory: relative(root, directory).split(sep).join("/"),
        dependencies: new Set(Object.keys(packageJson.dependencies ?? {})),
      });
    } catch {
      // Directories without a package.json are not workspace packages.
    }
  }
}

const packageRules = new Map([
  ["@muximo/contract", ["@muximo/domain"]],
  ["@muximo/application", ["@muximo/domain"]],
  ["@muximo/domain", []],
  ["@muximo/infrastructure", ["@muximo/application", "@muximo/domain"]],
  ["@muximo/test-support", []],
  ["@muximo/muximo-cli", ["@muximo/application", "@muximo/contract", "@muximo/domain", "@muximo/infrastructure"]],
  ["@muximo/muximod", ["@muximo/application", "@muximo/contract", "@muximo/domain", "@muximo/infrastructure"]],
  ["@muximo/web", ["@muximo/contract"]],
]);

const forbiddenImports = [
  {
    root: "packages/contract/src",
    packages: /^@muximo\/(?:application|infrastructure|web)/,
    runtimes: /^(?:node|bun):/,
  },
  {
    root: "packages/domain/src",
    packages: /^@muximo\//,
    runtimes: /^(?:node|bun):/,
  },
  {
    root: "packages/application/src",
    packages: /^@muximo\/(?:contract|infrastructure)/,
    runtimes: /^(?:node|bun):/,
  },
];

const webQueryKeyRules = {
  root: "apps/web/src",
  allowedFiles: new Set(["apps/web/src/app/api/orpc-utils.ts", "apps/web/src/app/api/invalidation.ts"]),
  patterns: [
    { name: "raw query key array", regex: /\bqueryKey\s*:\s*\[/ },
    { name: "raw setQueryData key array", regex: /\.setQueryData(?:<[^>(]*)?\(\s*\[/ },
  ],
};

// Domain entities are constructed only through their namespace API
// (create/restore/update). validate was removed on purpose so raw objects
// cannot be legitimized after the fact, and schema parsing outside the domain
// (plus contract derivation) is banned to keep rehydration on .restore().
const entityRules = {
  entityNames: "(?:Workspace|Pane|AgentSession)",
  schemaParseAllowedRoots: ["packages/domain/src/", "packages/contract/src/"],
};

const forbiddenCliDirectories = ["apps/muximo-cli/src/cli/host", "apps/muximo-cli/src/cli/runtime"];
const forbiddenCliTerms =
  /\b(?:CliRuntime|SessionLifecycleRuntime|RuntimeSessionHostAdapter|CliSessionHostPort|CommandEngine|MuximoCommand)\b/;
const muximodCliDirectory = "apps/muximod/src/cli";
const cliProviderLifecycleImport = /(?:from\s+|import\s*\(\s*)["'][^"']*\/agents\/(?:codex|claude|opencode)(?:\/|["'])/;
const cliProviderLifecycleTerms =
  /\b(?:CodexBackendProvider|ClaudeBackendProvider|OpenCodeBackendProvider|OpenCodeServerManager|manageCodexThread|manageCodexThreadFromEnvironment|ensureCodexRemoteControl|CodexRpcClient|MUXIMO_CODEX_NAME_BIN)\b/;
const forbiddenApplicationPaths = [
  "packages/application/src/ports/cli.ts",
  "packages/application/src/ports/terminal.ts",
  "packages/application/src/usecases/cli",
  "packages/application/src/usecases/daemon/manage-daemon.ts",
];
const applicationPresentationTerms =
  /\b(?:Cli[A-Z][A-Za-z0-9_]*|SessionOutputPort|CommandEngine|MuximoCommand|Presenter|Presentation|codexProfile|codexRemote|codexSessionBaseline)\b|\b(?:console\.(?:log|warn|error)|process\.(?:stdout|stderr)|Writable)\b/;
const applicationTerminalTransportTerms =
  /\b(?:MuximodPty(?:Exit|Process|Spawner|SpawnOptions)?|MuximodPreparedViewport|MuximodViewport(?:Event|Lease)|MuximodImage(?:PasteInput|Paster)|MuximodTerminal(?:Pane|ProcessSpec|ViewportPort))\b/;
const forbiddenInfrastructureDaemonPath = "packages/infrastructure/src/cli/daemon.ts";

// The application layer has no models/ directory: port-owned data lives in the
// port file, use-case inputs live in the use case file, and shared business
// vocabulary belongs to the domain package.
for (const sourceRoot of ["packages/application/src/models"]) {
  const modelsPath = join(root, sourceRoot);
  if (existsSync(modelsPath)) {
    errors.push(`${sourceRoot}: application/src/models was abolished; move types into ports or use case files`);
  }
}

for (const relativePath of forbiddenCliDirectories) {
  if (existsSync(join(root, relativePath))) {
    errors.push(`${relativePath}: CLI host/runtime directory is forbidden; compose focused ports directly`);
  }
}

for (const relativePath of forbiddenApplicationPaths) {
  if (existsSync(join(root, relativePath))) {
    errors.push(`${relativePath}: application must not expose CLI transport or dispatcher vocabulary`);
  }
}

if (existsSync(join(root, forbiddenInfrastructureDaemonPath))) {
  errors.push(
    `${forbiddenInfrastructureDaemonPath}: daemon process infrastructure is shared by apps; move it under packages/infrastructure/src/process`,
  );
}

if (existsSync(join(root, muximodCliDirectory))) {
  errors.push(
    `${muximodCliDirectory}: muximod has no public CLI; keep parsing, validation, and presentation in apps/muximo-cli`,
  );
}

for (const [packageName, packageInfo] of workspacePackages) {
  const allowed = packageRules.get(packageName);
  if (!allowed) continue;
  for (const dependency of packageInfo.dependencies) {
    if (dependency.startsWith("@muximo/") && !allowed.includes(dependency)) {
      errors.push(`${packageName}: package.json dependency ${dependency} points outside its allowed layer`);
    }
  }
}

for (const sourceRoot of workspaceRoots) {
  scanDirectory(join(root, sourceRoot));
}

if (errors.length > 0) {
  for (const error of errors) console.error(`architecture: ${error}`);
  process.exitCode = 1;
} else {
  console.log("architecture: dependency direction is valid");
}

function scanDirectory(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const relativePath = relative(root, path).split(sep).join("/");
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    if (statSync(path).isDirectory()) {
      scanDirectory(path);
      continue;
    }
    if (!/\.(?:ts|tsx|mts|cts|mjs)$/.test(entry) || isTestArtifact(relativePath)) continue;
    inspectSource(path, relativePath);
  }
}

function inspectSource(path, relativePath) {
  const source = readFileSync(path, "utf8");
  const sourcePackage = packageForPath(relativePath);
  const importPattern = /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const specifier = match[1];
    const line = source.slice(0, match.index).split("\n").length;
    const rule = forbiddenImports.find((candidate) => relativePath.startsWith(candidate.root));
    if (
      rule &&
      !rule.allowedFiles?.has(relativePath) &&
      (rule.packages.test(specifier) || rule.runtimes?.test(specifier))
    ) {
      errors.push(`${relativePath}:${line}: forbidden ${specifier} import for this layer`);
    }

    const dependency = workspacePackageName(specifier);
    inspectAppBoundary(specifier, path, relativePath, line);
    if (sourcePackage && dependency && dependency !== sourcePackage) {
      const packageInfo = workspacePackages.get(sourcePackage);
      if (packageInfo && !packageInfo.dependencies.has(dependency)) {
        errors.push(
          `${relativePath}:${line}: ${dependency} is imported but is not a production dependency of ${sourcePackage}`,
        );
      }
    }
  }

  inspectWebQueryKeys(source, relativePath);
  inspectEntityUsage(source, relativePath);
  inspectCliBoundary(source, relativePath);
  inspectApplicationBoundary(source, relativePath);
}

function inspectAppBoundary(specifier, sourcePath, relativePath, line) {
  const sourceApp = appName(relativePath);
  if (!sourceApp) return;

  if (specifier.startsWith(".")) {
    const targetPath = relative(root, resolvePath(dirname(sourcePath), specifier))
      .split(sep)
      .join("/");
    const targetApp = appName(targetPath);
    if (targetApp && targetApp !== sourceApp) {
      errors.push(`${relativePath}:${line}: apps may not import one another (${specifier})`);
    }
    return;
  }

  const dependency = workspacePackageName(specifier);
  const targetPackage = dependency ? workspacePackages.get(dependency) : undefined;
  if (targetPackage?.relativeDirectory.startsWith("apps/") && targetPackage.relativeDirectory !== `apps/${sourceApp}`) {
    errors.push(`${relativePath}:${line}: apps may not import one another (${specifier})`);
  }
}

function appName(relativePath) {
  const match = relativePath.match(/^apps\/([^/]+)(?:\/|$)/);
  return match?.[1];
}

function inspectCliBoundary(source, relativePath) {
  if (!relativePath.startsWith("apps/muximo-cli/src/")) return;
  if (forbiddenCliTerms.test(source)) {
    errors.push(`${relativePath}: CLI runtime/engine façade naming is forbidden`);
  }
  if (relativePath.startsWith("apps/muximo-cli/src/cli/") && /from\s+["']node:child_process["']/.test(source)) {
    errors.push(`${relativePath}: concrete process spawning belongs in packages/infrastructure/src/cli`);
  }
  if (relativePath.startsWith("apps/muximo-cli/src/cli/") && /from\s+["'][^"']*\/(?:runtime|host)\//.test(source)) {
    errors.push(`${relativePath}: CLI handlers/adapters may not import host/runtime layers`);
  }
  if (cliProviderLifecycleImport.test(source) || cliProviderLifecycleTerms.test(source)) {
    errors.push(
      `${relativePath}: provider lifecycle transport/implementation belongs in packages/infrastructure/src/agents; use a provider-neutral port or registry adapter`,
    );
  }
}

function inspectApplicationBoundary(source, relativePath) {
  if (!relativePath.startsWith("packages/application/src/")) return;
  if (applicationTerminalTransportTerms.test(source)) {
    errors.push(
      `${relativePath}: PTY, viewport-lease, and image-paste transport contracts belong in an outer terminal adapter boundary`,
    );
  }
  if (applicationPresentationTerms.test(source)) {
    errors.push(
      `${relativePath}: application must expose typed business outcomes and capabilities, not CLI transport or presentation vocabulary`,
    );
  }
  if (
    relativePath.startsWith("packages/application/src/usecases/daemon/") &&
    /\b(?:Date\.now|setTimeout)\s*\(/.test(source)
  ) {
    errors.push(`${relativePath}: daemon timing must be supplied through required clock and scheduler ports`);
  }
  if (source.includes("MUXIMO_CODEX_NAME_BIN")) {
    errors.push(`${relativePath}: Codex name helper is forbidden in the application layer`);
  }
}

function inspectEntityUsage(source, relativePath) {
  const entityCall = new RegExp(`\\b${entityRules.entityNames}\\.validate\\s*\\(`);
  const match = entityCall.exec(source);
  if (match) {
    const line = source.slice(0, match.index).split("\n").length;
    errors.push(
      `${relativePath}:${line}: entity .validate() was removed; construct through create/restore/update so raw objects cannot be legitimized after the fact`,
    );
  }

  if (!entityRules.schemaParseAllowedRoots.some((allowed) => relativePath.startsWith(allowed))) {
    const schemaParse = new RegExp(`\\b${entityRules.entityNames}\\.schema\\.(?:parse|safeParse)\\b`);
    const schemaMatch = schemaParse.exec(source);
    if (schemaMatch) {
      const line = source.slice(0, schemaMatch.index).split("\n").length;
      errors.push(
        `${relativePath}:${line}: parse domain entities through their namespace API (create/restore/update), not ${entityRules.entityNames}.schema.parse`,
      );
    }
  }
}

function inspectWebQueryKeys(source, relativePath) {
  const rule = webQueryKeyRules;
  if (!relativePath.startsWith(`${rule.root}/`)) return;
  if (rule.allowedFiles.has(relativePath)) return;
  for (const pattern of rule.patterns) {
    const match = pattern.regex.exec(source);
    if (!match) continue;
    const line = source.slice(0, match.index).split("\n").length;
    errors.push(
      `${relativePath}:${line}: ${pattern.name}; derive keys through app/api/orpc-utils.ts and invalidate through app/api/invalidation.ts`,
    );
  }
}

function packageForPath(relativePath) {
  for (const [packageName, packageInfo] of workspacePackages) {
    if (relativePath.startsWith(`${packageInfo.relativeDirectory}/`)) return packageName;
  }
  return undefined;
}

function workspacePackageName(specifier) {
  if (!specifier.startsWith("@muximo/")) return undefined;
  const match = specifier.match(/^(@muximo\/[^/]+)/);
  return match?.[1];
}

function isTestArtifact(relativePath) {
  return /(?:^|\/)(?:__tests__|fixtures)(?:\/|$)|(?:\.test|\.spec|\.stories)\.[^.]+$/.test(relativePath);
}
