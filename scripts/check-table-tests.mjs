#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoots = ["apps", "packages", "scripts"];
const testFilePattern = /\.test\.(?:mjs|js|ts|tsx)$/;
const runnerNames = new Set(["runOperationTable", "runScenarioTable"]);

const testFiles = [];
for (const sourceRoot of sourceRoots) {
  await collectTestFiles(join(repositoryRoot, sourceRoot));
}

const violations = [];
for (const filePath of testFiles) {
  const source = await readFile(filePath, "utf8");
  const relativePath = relative(repositoryRoot, filePath);
  const fileViolations = inspectTestFile(source, filePath, relativePath);
  violations.push(...fileViolations);
}

if (violations.length > 0) {
  console.error("Table-test rule violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Table-test rules passed for ${testFiles.length} files.`);
}

function inspectTestFile(source, _filePath, relativePath) {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      sourceFilename: relativePath,
      plugins: ["typescript", "jsx", "topLevelAwait"],
    });
  } catch (error) {
    return [`${relativePath}: could not parse test source: ${error.message}`];
  }

  const violations = [];
  const callNames = new Set(["it", "test"]);
  const describeNames = new Set(["describe"]);
  const testFrameworkNamespaces = new Set();
  const tableRunnerNames = new Set(runnerNames);
  const tableRunnerNamespaces = new Set();
  const variableDeclarations = new Map();

  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    walk(ast, (node) => {
      if (node.type === "ImportDeclaration" && isTestFramework(node.source)) {
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            testFrameworkNamespaces.add(specifier.local.name);
            continue;
          }
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = identifierName(specifier.imported);
          const local = identifierName(specifier.local);
          if (["it", "test"].includes(imported) && !callNames.has(local)) {
            callNames.add(local);
            aliasesChanged = true;
          }
          if (imported === "describe" && !describeNames.has(local)) {
            describeNames.add(local);
            aliasesChanged = true;
          }
        }
      }

      if (node.type === "ImportDeclaration" && isTableSupport(node.source)) {
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            tableRunnerNamespaces.add(specifier.local.name);
            continue;
          }
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = identifierName(specifier.imported);
          const local = identifierName(specifier.local);
          if (runnerNames.has(imported)) tableRunnerNames.add(local);
        }
      }

      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
      variableDeclarations.set(node.id.name, node);
      if (node.init?.type !== "Identifier") return;
      if (callNames.has(node.init.name) && !callNames.has(node.id.name)) {
        callNames.add(node.id.name);
        aliasesChanged = true;
      }
      if (describeNames.has(node.init.name) && !describeNames.has(node.id.name)) {
        describeNames.add(node.id.name);
        aliasesChanged = true;
      }
      if (tableRunnerNames.has(node.init.name) && !tableRunnerNames.has(node.id.name)) {
        tableRunnerNames.add(node.id.name);
        aliasesChanged = true;
      }
    });
  }

  let runnerCallCount = 0;
  const runnerCalls = [];
  walk(ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee.type === "Identifier" && callNames.has(callee.name)) {
        violations.push(`${relativePath}: use the shared table runner instead of bare it/test`);
      }
      const chain = memberChain(callee);
      const namespace = chain[0];
      if (chain.length > 1 && testFrameworkNamespaces.has(namespace)) {
        if (["it", "test"].includes(chain[1])) {
          violations.push(`${relativePath}: use the shared table runner instead of bare it/test`);
        }
        if (chain.includes("describe") && chain.at(-1) === "each") {
          violations.push(`${relativePath}: direct describe.each registration is not allowed`);
        }
      } else if (callee.type === "MemberExpression" && callee.object.type === "Identifier") {
        if (callNames.has(callee.object.name)) {
          violations.push(`${relativePath}: direct test registration (${callee.object.name}.*) is not allowed`);
        }
        if (describeNames.has(callee.object.name) && propertyName(callee) === "each") {
          violations.push(`${relativePath}: direct describe.each registration is not allowed`);
        }
      }
      if (isTableRunner(callee, tableRunnerNames, tableRunnerNamespaces)) {
        runnerCallCount += 1;
        runnerCalls.push(node);
      }
    }

    if (node.type !== "ObjectExpression") return;
    const properties = namedProperties(node);
    const hasName = properties.has("name");
    const hasInputOrSteps = properties.has("input") || properties.has("steps");
    if (!hasName || !hasInputOrSteps) return;

    if (!properties.has("assert")) {
      violations.push(`${relativePath}: every table row must define assert`);
    }
    const allowedRowKeys = new Set(["name", "fixture", "input", "steps", "assert"]);
    for (const key of properties.keys()) {
      if (!allowedRowKeys.has(key)) {
        violations.push(
          `${relativePath}: row-level ${key} is not allowed; keep execution and observation at table level`,
        );
      }
    }

    const steps = properties.get("steps");
    const stepValue = steps ? unwrapExpression(steps.value) : undefined;
    if (steps && stepValue?.type !== "ArrayExpression") {
      violations.push(`${relativePath}: scenario steps must be a data array`);
    } else if (steps && stepValue && containsFunction(stepValue)) {
      violations.push(`${relativePath}: scenario steps must not contain functions`);
    }

    const assertion = properties.get("assert");
    const assertionValue = assertion ? unwrapExpression(assertion.value) : undefined;
    if (assertionValue?.type === "ArrayExpression" && assertionValue.elements.length === 0) {
      violations.push(`${relativePath}: assertion lists must not be empty`);
    }
  });

  for (const runnerCall of runnerCalls) {
    const tableArgument = runnerCall.arguments[1];
    if (tableArgument?.type !== "Identifier") continue;
    const tableDeclaration = variableDeclarations.get(tableArgument.name);
    if (!tableDeclaration || !hasExplicitType(tableDeclaration)) {
      violations.push(
        `${relativePath}: table passed to ${runnerCall.callee.name ?? "the shared runner"} must have an explicit type`,
      );
      continue;
    }

    const tableObject = unwrapExpression(tableDeclaration.init);
    const casesProperty =
      tableObject?.type === "ObjectExpression" ? namedProperties(tableObject).get("cases") : undefined;
    const casesValue = casesProperty ? unwrapExpression(casesProperty.value) : undefined;
    if (casesValue?.type !== "Identifier") continue;
    const casesDeclaration = variableDeclarations.get(casesValue.name);
    if (!casesDeclaration || !hasExplicitType(casesDeclaration)) {
      violations.push(`${relativePath}: cases passed through ${tableArgument.name} must have an explicit type`);
    }
  }

  if (runnerCallCount === 0) {
    violations.push(`${relativePath}: register cases through runOperationTable or runScenarioTable`);
  }

  return unique(violations);
}

function isTestFramework(source) {
  return source.type === "StringLiteral" && ["vitest", "bun:test"].includes(source.value);
}

function isTableSupport(source) {
  return source.type === "StringLiteral" && source.value === "@muximo/test-support";
}

function isTableRunner(callee, runnerNames, runnerNamespaces) {
  if (callee.type === "Identifier") return runnerNames.has(callee.name);
  const chain = memberChain(callee);
  return chain.length === 2 && runnerNamespaces.has(chain[0]) && runnerNames.has(chain[1]);
}

function memberChain(node) {
  if (node?.type === "Identifier") return [node.name];
  if (node?.type !== "MemberExpression" || node.computed) return [];
  const parent = memberChain(node.object);
  const property = identifierName(node.property);
  return property ? [...parent, property] : [];
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    ["TSSatisfiesExpression", "TSAsExpression", "TypeCastExpression", "ParenthesizedExpression"].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

function hasExplicitType(node) {
  if (node.id?.typeAnnotation) return true;
  if (["TSSatisfiesExpression", "TSAsExpression", "TypeCastExpression"].includes(node.init?.type)) return true;
  return (node.leadingComments ?? []).some((comment) => /@(?:type|satisfies)\b/.test(comment.value));
}

function namedProperties(node) {
  const properties = new Map();
  for (const property of node.properties) {
    if (property.type !== "ObjectProperty" || property.computed) continue;
    const name = propertyName(property);
    if (name) properties.set(name, property);
  }
  return properties;
}

function propertyName(node) {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.key?.type === "Identifier") return node.key.name;
  if (node.key?.type === "StringLiteral") return node.key.value;
  return undefined;
}

function identifierName(node) {
  return node?.type === "Identifier" ? node.name : undefined;
}

function containsFunction(node) {
  let found = false;
  walk(node, (current) => {
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(current.type)) {
      found = true;
    }
  });
  return found;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["type", "loc", "start", "end", "extra", "errors"].includes(key)) continue;
    walk(value, visit);
  }
}

function unique(values) {
  return [...new Set(values)];
}

async function collectTestFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;

    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(entryPath);
    } else if (testFilePattern.test(entry.name)) {
      testFiles.push(entryPath);
    }
  }
}
