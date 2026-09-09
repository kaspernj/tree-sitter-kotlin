const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { mkdir, mkdtemp, readdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { describe, it } = require("node:test");

const executeFile = promisify(execFile);
const root = path.join(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const packageLock = require(path.join(root, "package-lock.json"));
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const buildWorkflow = readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8");
const publicationWorkflows = [
  ".github/workflows/deploy-to-crates-io.yml",
  ".github/workflows/deploy-to-github.yml",
  ".github/workflows/deploy-to-npm.yml",
];

function parsePackResult(output) {
  const start = Math.max(output.lastIndexOf("\n["), output.startsWith("[") ? 0 : -1);

  assert.notEqual(start, -1, output);
  const parsed = JSON.parse(output.slice(start === 0 ? 0 : start + 1));

  assert.equal(parsed.length, 1);
  return parsed[0];
}

function isolatedNpmEnvironment(cache, userConfig, globalConfig) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:npm_config_|NODE_AUTH_TOKEN$|NPM_TOKEN$|NODE_PATH$)/iu.test(name)));

  return {
    ...environment,
    npm_config_audit: "false",
    npm_config_cache: cache,
    npm_config_fund: "false",
    npm_config_globalconfig: globalConfig,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: userConfig,
  };
}

describe("Node package contract", () => {
  it("declares the exact qualified runtime without production parser-generation tooling", () => {
    assert.equal(process.versions.node.split(".")[0], "24");
    assert.equal(packageJson.version, "0.4.0");
    assert.equal(packageJson.scripts.install, "node-gyp-build");
    assert.equal(
      packageJson.scripts["test:node"],
      "node --test bindings/node/binding_test.js test/package_contract_test.js",
    );
    assert.equal(packageJson.peerDependencies["tree-sitter"], "^0.25.1");
    assert.deepEqual(packageJson.peerDependenciesMeta, { "tree-sitter": { optional: true } });
    assert.equal(packageJson.devDependencies["tree-sitter"], "0.25.1");
    assert.equal(packageJson.dependencies["tree-sitter-cli"], undefined);
    assert.equal(packageLock.packages[""].peerDependencies["tree-sitter"], "^0.25.1");
    assert.deepEqual(packageLock.packages[""].peerDependenciesMeta, { "tree-sitter": { optional: true } });
    assert.equal(packageLock.packages[""].devDependencies["tree-sitter"], "0.25.1");

    const scripts = JSON.stringify(packageJson.scripts);

    assert.doesNotMatch(packageJson.scripts.install, /generate|https?:|curl|wget|fetch/iu);
    assert.doesNotMatch(scripts, /preinstall|postinstall/iu);
    assert.match(readFileSync(path.join(root, "src/parser.c"), "utf8"), /#define LANGUAGE_VERSION 14/u);
    assert.match(readFileSync(path.join(root, "bindings/node/binding.cc"), "utf8"), /language\.TypeTag\(&LANGUAGE_TYPE_TAG\)/u);
    assert.match(readFileSync(path.join(root, "bindings/node/binding.cc"), "utf8"), /exports\["language"\] = language/u);
    assert.match(buildWorkflow, /node-version: ['"]24['"]/u);
    assert.match(buildWorkflow, /run: npm run test:node/u);
    for (const relativePath of [
      "binding.gyp",
      "bindings/node/binding.cc",
      "bindings/node/index.d.ts",
      "bindings/node/index.js",
      "src/node-types.json",
      "src/parser.c",
      "src/scanner.c",
      "src/tree_sitter/parser.h",
    ]) {
      assert.ok(readFileSync(path.join(root, relativePath)).byteLength > 0, relativePath);
    }
  });

  it("keeps Semantifold source tags outside every inherited publication workflow", () => {
    for (const relativePath of publicationWorkflows) {
      const workflow = readFileSync(path.join(root, relativePath), "utf8");

      assert.match(workflow, /tags:\n\s+- ['"]\*['"]\n\s+- ['"]!v\*-semantifold\.\*['"]/u, relativePath);
    }
    assert.match(
      readme,
      /https:\/\/github\.com\/kaspernj\/tree-sitter-kotlin\/archive\/<40-character-commit-sha>\.tar\.gz/u,
    );
  });

  it("cold-installs and reinstalls the packed binding with no parser CLI", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tree-sitter-kotlin-consumer-"));
    const packDirectory = path.join(temporaryRoot, "pack");
    const consumerDirectory = path.join(temporaryRoot, "consumer");
    const userConfig = path.join(temporaryRoot, "empty-user.npmrc");
    const globalConfig = path.join(temporaryRoot, "empty-global.npmrc");

    try {
      await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory), writeFile(userConfig, ""), writeFile(globalConfig, "")]);
      const packed = await executeFile("npm", ["pack", "--json", "--pack-destination", packDirectory], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
      });
      const packResult = parsePackResult(packed.stdout);
      const packedFiles = new Set(packResult.files.map(({ path: filename }) => filename));

      for (const filename of [
        "binding.gyp",
        "bindings/node/binding.cc",
        "bindings/node/index.d.ts",
        "bindings/node/index.js",
        "src/node-types.json",
        "src/parser.c",
        "src/scanner.c",
        "src/tree_sitter/parser.h",
      ]) {
        assert.equal(packedFiles.has(filename), true, filename);
      }
      assert.equal([...packedFiles].some((filename) => filename.includes("tree-sitter-cli")), false);

      const tarball = path.join(packDirectory, packResult.filename);

      await writeFile(path.join(consumerDirectory, "package.json"), `${JSON.stringify({
        dependencies: {
          "tree-sitter": "0.25.1",
          "tree-sitter-kotlin": `file:${tarball}`,
        },
        name: "tree-sitter-kotlin-qualified-consumer",
        private: true,
        version: "1.0.0",
      }, null, 2)}\n`);
      await writeFile(path.join(consumerDirectory, "verify.cjs"), `
const assert = require("node:assert/strict");
const Parser = require("tree-sitter");
const Kotlin = require("tree-sitter-kotlin");
assert.equal(require("tree-sitter/package.json").version, "0.25.1");
const parser = new Parser();
parser.setLanguage(Kotlin);
const accepted = parser.parse("fun main() { println(\\\"😀\\\") }\\n").rootNode;
assert.equal(accepted.type, "source_file");
assert.equal(accepted.hasError, false);
const recovered = parser.parse("fun broken(): Long { return 1L + }\\n").rootNode;
assert.equal(recovered.hasError, true);
process.stdout.write("qualified\\n");
`);

      for (const command of ["install", "ci"]) {
        const cache = path.join(temporaryRoot, `cache-${command}`);

        await mkdir(cache);
        const environment = isolatedNpmEnvironment(cache, userConfig, globalConfig);
        const configured = JSON.parse((await executeFile("npm", ["config", "list", "--json"], {
          cwd: consumerDirectory,
          env: environment,
        })).stdout);

        assert.equal(configured.registry, "https://registry.npmjs.org/");
        assert.equal(configured.userconfig, userConfig);
        assert.equal(configured.globalconfig, globalConfig);
        assert.equal(configured.cache, cache);
        assert.equal(configured["install-links"], false);
        assert.equal(Object.keys(configured).some((name) => name.endsWith(":registry")), false);

        const installed = await executeFile("npm", [command], {
          cwd: consumerDirectory,
          env: environment,
          maxBuffer: 20 * 1024 * 1024,
        });

        assert.doesNotMatch(installed.stderr, /ERESOLVE|legacy-peer-deps|overrid|tree-sitter generate/iu);
        const listed = JSON.parse((await executeFile("npm", ["ls", "--all", "--json"], {
          cwd: consumerDirectory,
          env: environment,
          maxBuffer: 20 * 1024 * 1024,
        })).stdout);

        assert.equal(listed.problems, undefined);
        assert.equal(listed.dependencies["tree-sitter"].version, "0.25.1");
        assert.equal(listed.dependencies["tree-sitter-kotlin"].version, "0.4.0");
        assert.equal(JSON.stringify(listed).includes("tree-sitter-cli"), false);
        const verified = await executeFile(process.execPath, ["verify.cjs"], {
          cwd: consumerDirectory,
          env: environment,
        });

        assert.equal(verified.stdout, "qualified\n");
        assert.ok((await readdir(cache)).length > 0);
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
