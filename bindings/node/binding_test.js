const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const Parser = require("tree-sitter");
const Kotlin = require(".");
const runtime = require("tree-sitter/package.json");

function descendants(root) {
  const pending = [root];
  const nodes = [];

  while (pending.length > 0) {
    const node = pending.pop();

    assert.ok(node);
    nodes.push(node);
    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      const child = node.child(index);

      assert.ok(child);
      pending.push(child);
    }
  }

  return nodes;
}

function parser() {
  const instance = new Parser();

  instance.setLanguage(Kotlin);
  return instance;
}

describe("Node 24 binding with Tree-sitter 0.25.1", () => {
  it("loads the exact runtime and qualified Kotlin language object", () => {
    assert.equal(process.versions.node.split(".")[0], "24");
    assert.equal(runtime.version, "0.25.1");
    assert.equal(Kotlin.name, "kotlin");
    assert.doesNotThrow(() => parser());
  });

  it("deterministically parses typed Kotlin/JVM profile syntax", () => {
    const source = `fun choose(left: Long, right: Long): Long {
  val label: String = "choice"
  var selected: Long = left
  if ((left < right) && (label == "choice")) {
    selected = right
  }
  return selected
}

fun main() {
  println(choose(1L, 2L))
}
`;
    const first = parser().parse(source).rootNode;
    const second = parser().parse(source).rootNode;
    const kinds = new Set(descendants(first).map(({ type }) => type));

    assert.equal(first.type, "source_file");
    assert.equal(first.hasError, false);
    assert.equal(first.toString(), second.toString());
    for (const kind of [
      "function_declaration",
      "property_declaration",
      "assignment",
      "if_expression",
      "jump_expression",
      "call_expression",
      "comparison_expression",
      "conjunction_expression",
      "equality_expression",
      "long_literal",
      "string_literal",
    ]) {
      assert.equal(kinds.has(kind), true, kind);
    }
  });

  it("keeps parser recovery observable", () => {
    const source = "fun broken(left: Long, right: Long): Long { return left + }\n";
    const root = parser().parse(source).rootNode;

    assert.equal(root.hasError, true);
    assert.equal(
      descendants(root).some((node) => node.isError || node.isMissing),
      true,
    );
  });

  it("reports astral Unicode and CRLF ranges in JavaScript UTF-16 offsets", () => {
    const source = "// 😀\r\nfun label(left: String, right: String): String { return \"😀\" }\r\n";
    const root = parser().parse(source).rootNode;
    const literal = descendants(root).find((node) => node.type === "string_literal" && node.text === '"😀"');

    assert.equal(root.hasError, false);
    assert.ok(literal);
    const utf16Start = source.indexOf('"😀"');
    const utf8Start = new TextEncoder().encode(source.slice(0, utf16Start)).length;

    assert.equal(literal.startIndex, utf16Start);
    assert.equal(literal.endIndex, utf16Start + '"😀"'.length);
    assert.notEqual(literal.startIndex, utf8Start);
  });
});
