#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const repository = "yoshizawa56/muximo";
const installRoot = resolve(process.env.MUXIMO_INSTALL_DIR ?? join(homedir(), ".local", "libexec", "muximo"));
const installBinary = join(installRoot, "muximo");
const installMuximod = join(installRoot, "muximod");
const commandDirectory = resolve(process.env.MUXIMO_BIN_DIR ?? join(homedir(), ".local", "bin"));
const commandPath = join(commandDirectory, "muximo");
const args = new Set(process.argv.slice(2));
const fromBuild = args.has("--from-build");
const tag = valueAfter("--tag") ?? process.env.MUXIMO_RELEASE_TAG;
const asset = releaseAsset();
const muximodAsset = muximodReleaseAsset();
const temporaryRoot = mkdtempSync(join(tmpdir(), "muximo-install-"));
const temporaryBinary = join(temporaryRoot, asset);
const temporaryMuximod = join(temporaryRoot, muximodAsset);

try {
  mkdirSync(installRoot, { recursive: true, mode: 0o755 });
  if (fromBuild) {
    const source = resolve(optionalValueAfter("--from-build") ?? process.env.MUXIMO_BUILD_BINARY ?? "dist/muximo");
    const muximodSource = resolve(
      optionalValueAfter("--from-muximod-build") ??
        process.env.MUXIMO_MUXIMOD_BUILD_BINARY ??
        join(dirname(source), deriveMuximodName(basename(source))),
    );
    if (!existsSync(source)) throw new Error(`local production binary not found: ${source}`);
    if (!existsSync(muximodSource)) throw new Error(`local muximod process binary not found: ${muximodSource}`);
    writeFileSync(temporaryBinary, readFileSync(source));
    writeFileSync(temporaryMuximod, readFileSync(muximodSource));
    process.stdout.write(`Installing local production build: ${source}\n`);
  } else {
    const baseUrl = tag
      ? `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`
      : `https://github.com/${repository}/releases/latest/download`;
    const [binary, muximod, checksumResponse] = await Promise.all([
      fetch(`${baseUrl}/${asset}`),
      fetch(`${baseUrl}/${muximodAsset}`),
      fetch(`${baseUrl}/SHA256SUMS.txt`),
    ]);
    if (!binary.ok) throw new Error(`could not download ${baseUrl}/${asset}: HTTP ${binary.status}`);
    if (!muximod.ok) throw new Error(`could not download ${baseUrl}/${muximodAsset}: HTTP ${muximod.status}`);
    if (!checksumResponse.ok)
      throw new Error(`could not download ${baseUrl}/SHA256SUMS.txt: HTTP ${checksumResponse.status}`);
    const checksumText = await checksumResponse.text();
    const binaryData = Buffer.from(await binary.arrayBuffer());
    const muximodData = Buffer.from(await muximod.arrayBuffer());
    verifyChecksum(checksumText, asset, binaryData);
    verifyChecksum(checksumText, muximodAsset, muximodData);
    writeFileSync(temporaryBinary, binaryData);
    writeFileSync(temporaryMuximod, muximodData);
    process.stdout.write(`Installing ${tag ?? "latest stable"} release: ${asset} and ${muximodAsset}\n`);
  }

  chmodSync(temporaryBinary, 0o755);
  chmodSync(temporaryMuximod, 0o755);
  renameSync(temporaryBinary, installBinary);
  renameSync(temporaryMuximod, installMuximod);
  installCommandLink();
  process.stdout.write(`Installed production binary: ${installBinary}\n`);
  process.stdout.write(`Installed private server process: ${installMuximod}\n`);
  process.stdout.write(`Installed production command: ${commandPath}\n`);
  process.stdout.write(
    "Use 'muximo' for the production command. The private muximod process is managed by muximo and has no public CLI.\n",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function releaseAsset() {
  return `muximo-${releasePlatform()}`;
}

function muximodReleaseAsset() {
  return `muximod-${releasePlatform()}`;
}

function releasePlatform() {
  const sourceTarget = `${platform()}-${arch()}`;
  const operatingSystem = { darwin: "macos", linux: "linux" }[platform()];
  const architecture = { arm64: "arm64", x64: "x64" }[arch()];
  if (!operatingSystem || !architecture) throw new Error(`unsupported platform: ${sourceTarget}`);
  return `${operatingSystem}-${architecture}`;
}

function verifyChecksum(contents, filename, data) {
  const expected = checksumFor(contents, filename);
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${filename}: expected ${expected}, got ${actual}`);
}

function checksumFor(contents, filename) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].replace(/^.*\//, "") === filename) return match[1].toLowerCase();
  }
  throw new Error(`checksum for ${filename} was not found in SHA256SUMS.txt`);
}

function deriveMuximodName(name) {
  return name === "muximo" ? "muximod" : name.replace(/^muximo(?=-|$)/u, "muximod");
}

function installCommandLink() {
  mkdirSync(commandDirectory, { recursive: true, mode: 0o755 });
  const temporaryLink = join(commandDirectory, `.muximo-link-${process.pid}`);
  rmSync(temporaryLink, { force: true });
  symlinkSync(installBinary, temporaryLink);
  try {
    renameSync(temporaryLink, commandPath);
  } finally {
    rmSync(temporaryLink, { force: true });
  }
}

function valueAfter(option) {
  const index = process.argv.indexOf(option);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function optionalValueAfter(option) {
  const index = process.argv.indexOf(option);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}
