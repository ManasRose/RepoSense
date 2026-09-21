// MODULE B — Code Parser
// Input:  [{ filePath, content, language }]  (Module A output)
// Output: [{ filePath, name, type, startLine, endLine, code }]

const babelParser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const JS_LANGS = new Set(["javascript", "typescript"]);

/** Render a simple member expression like `res.send` or `module.exports.foo` as text. */
function memberName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression"
  ) {
    const obj = memberName(node.object);
    const prop = node.computed
      ? "[...]"
      : node.property?.name || node.property?.value;
    return obj && prop ? `${obj}.${prop}` : prop || obj;
  }
  return null;
}

const isFn = (n) =>
  n &&
  (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression");

/**
 * Parse a single JS/TS file into function/class units using Babel AST.
 * Any lines NOT covered by an extracted unit are kept as fallback blocks,
 * so no code is silently dropped from the index.
 */
function parseJsFile(filePath, content) {
  const units = [];

  let ast;
  try {
    ast = babelParser.parse(content, {
      sourceType: "unambiguous",
      plugins: [
        "jsx",
        "typescript",
        "classProperties",
        "decorators-legacy",
        "optionalChaining",
      ],
      errorRecovery: true,
    });
  } catch (err) {
    return naiveSplit(filePath, content);
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      pushUnit(
        units,
        filePath,
        content,
        path.node,
        path.node.id?.name || "anonymous",
        "function",
      );
    },
    ClassDeclaration(path) {
      pushUnit(
        units,
        filePath,
        content,
        path.node,
        path.node.id?.name || "anonymous",
        "class",
      );
    },
    VariableDeclarator(path) {
      // covers `const foo = () => {}` and `const foo = function () {}`
      const init = path.node.init;
      if (isFn(init)) {
        pushUnit(
          units,
          filePath,
          content,
          path.node,
          path.node.id?.name || "anonymous",
          "function",
        );
      }
    },
    AssignmentExpression(path) {
      // covers `res.send = function send() {}`, `exports.foo = () => {}`,
      // `module.exports = function () {}` (CommonJS / prototype-assignment style)
      if (!isFn(path.node.right)) return;
      const name = memberName(path.node.left) || "anonymous";
      const stmt = path.parentPath.isExpressionStatement()
        ? path.parent
        : path.node;
      pushUnit(units, filePath, content, stmt, name, "function");
    },
    ObjectProperty(path) {
      // covers `{ handler: function () {} }` / `{ handler: () => {} }`
      if (!isFn(path.node.value)) return;
      const key = path.node.key?.name || path.node.key?.value || "property";
      pushUnit(units, filePath, content, path.node, key, "function");
    },
    ObjectMethod(path) {
      pushUnit(
        units,
        filePath,
        content,
        path.node,
        path.node.key?.name || "method",
        "method",
      );
    },
    ClassMethod(path) {
      pushUnit(
        units,
        filePath,
        content,
        path.node,
        path.node.key?.name || "method",
        "method",
      );
    },
  });

  if (units.length === 0) return naiveSplit(filePath, content);

  const kept = dedupeOverlapping(units);
  return [...kept, ...uncoveredBlocks(filePath, content, kept)].sort(
    (a, b) => a.startLine - b.startLine,
  );
}

function pushUnit(units, filePath, content, node, name, type) {
  if (!node.loc) return;
  const startLine = node.loc.start.line;
  const endLine = node.loc.end.line;
  const code = content
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");

  // skip trivially small units (e.g. one-liner variable, noisy)
  if (endLine - startLine < 1 && code.length < 30) return;

  units.push({ filePath, name, type, startLine, endLine, code });
}

/**
 * Avoid heavily nested duplicate ranges (e.g. an arrow fn assigned inside a class method
 * both getting captured). Keep the outer-most unit when ranges fully overlap.
 */
function dedupeOverlapping(units) {
  const sorted = [...units].sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine,
  );
  const kept = [];
  for (const unit of sorted) {
    const containedByExisting = kept.some(
      (k) => unit.startLine >= k.startLine && unit.endLine <= k.endLine,
    );
    if (!containedByExisting) kept.push(unit);
  }
  return kept;
}

/**
 * Lines between/around extracted units (imports, top-level statements, describe/it
 * callbacks, comments) become fallback blocks so they stay searchable.
 */
function uncoveredBlocks(filePath, content, keptSorted) {
  const lines = content.split("\n");
  const blocks = [];
  let cursor = 1; // next line (1-indexed) not yet covered

  const addGap = (from, to) => {
    if (to < from) return;
    const gapText = lines.slice(from - 1, to).join("\n");
    blocks.push(...naiveSplit(filePath, gapText, from - 1));
  };

  for (const unit of keptSorted) {
    addGap(cursor, unit.startLine - 1);
    cursor = Math.max(cursor, unit.endLine + 1);
  }
  addGap(cursor, lines.length);
  return blocks;
}

/**
 * Fallback for non-JS/TS languages or unparseable files:
 * split by blank-line-separated blocks. `lineOffset` shifts reported line numbers
 * when splitting only a slice of a larger file.
 */
function naiveSplit(filePath, content, lineOffset = 0) {
  const lines = content.split("\n");
  const units = [];
  let blockStart = 0;
  let blockLines = [];

  const flush = (endIdx) => {
    if (blockLines.length === 0) return;
    const code = blockLines.join("\n");
    if (code.trim().length < 20) {
      blockLines = [];
      return;
    } // skip near-empty blocks
    units.push({
      filePath,
      name: null,
      type: "block",
      startLine: lineOffset + blockStart + 1,
      endLine: lineOffset + endIdx,
      code,
    });
    blockLines = [];
  };

  lines.forEach((line, idx) => {
    if (line.trim() === "") {
      flush(idx);
      blockStart = idx + 1;
    } else {
      blockLines.push(line);
    }
  });
  flush(lines.length);

  return units;
}

/**
 * Parse all ingested files into code units.
 * @param {Array} files - Module A output
 * @returns {Array} code units - Module B output
 */
function parseFiles(files) {
  const allUnits = [];
  for (const file of files) {
    const units = JS_LANGS.has(file.language)
      ? parseJsFile(file.filePath, file.content)
      : naiveSplit(file.filePath, file.content);
    allUnits.push(...units);
  }
  return allUnits;
}

module.exports = { parseFiles, parseJsFile, naiveSplit };
