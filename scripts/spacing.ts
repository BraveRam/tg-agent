import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";

const write = process.argv.includes("--write");

const roots = ["agent", "scripts", "tests", "evals"];

let failures = 0;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (path.startsWith("agent/skills/eve") || entry.name === "userbot-schema.ts") return [];

    return entry.isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function isBoundary(statement: ts.Node): boolean {
  return (
    ts.isIfStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isTryStatement(statement) ||
    ts.isSwitchStatement(statement) ||
    ts.isReturnStatement(statement) ||
    ts.isFunctionDeclaration(statement)
  );
}

function importGroup(declaration: ts.ImportDeclaration): number {
  const specifier = (declaration.moduleSpecifier as ts.StringLiteral).text;

  if (specifier.startsWith("node:")) return 0;

  if (specifier.startsWith(".") || specifier.startsWith("#")) return 2;

  return 1;
}

function requiresPadding(previous: ts.Node, next: ts.Node, parent: ts.Node): boolean {
  if (ts.isSourceFile(parent)) {
    if (ts.isImportDeclaration(previous) && ts.isImportDeclaration(next)) {
      return importGroup(previous) !== importGroup(next);
    }

    return true;
  }

  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return true;

  if (ts.isObjectLiteralExpression(parent)) {
    return ts.isMethodDeclaration(previous) || ts.isMethodDeclaration(next);
  }

  if (ts.isVariableStatement(previous) && ts.isVariableStatement(next)) return false;

  return (
    isBoundary(previous) ||
    isBoundary(next) ||
    ts.isVariableStatement(previous) ||
    ts.isVariableStatement(next)
  );
}

for (const filename of roots.flatMap(files)) {
  const source = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const positions = new Set<number>();

  function visit(node: ts.Node): void {
    const siblings =
      ts.isSourceFile(node) || ts.isBlock(node)
        ? node.statements
        : ts.isClassDeclaration(node) || ts.isClassExpression(node)
          ? node.members
          : ts.isObjectLiteralExpression(node)
            ? node.properties
            : undefined;

    if (siblings) {
      for (let i = 1; i < siblings.length; i++) {
        const previous = siblings[i - 1];
        const next = siblings[i];

        if (!requiresPadding(previous, next, node)) continue;

        const gap = source.slice(previous.end, next.getStart(tree));

        if (/\r?\n[\t ]*\r?\n/.test(gap)) continue;

        const newline = source.indexOf("\n", previous.end);
        const position = newline >= 0 && newline < next.getStart(tree) ? newline + 1 : previous.end;

        positions.add(position);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(tree);

  if (!positions.size) continue;

  if (write) {
    let formatted = source;

    for (const position of [...positions].sort((a, b) => b - a)) {
      formatted = formatted.slice(0, position) + "\n" + formatted.slice(position);
    }

    writeFileSync(filename, formatted);
  } else {
    for (const position of positions) {
      const { line } = tree.getLineAndCharacterOfPosition(position);

      console.error(
        `${relative(process.cwd(), filename)}:${line + 1}: Missing blank line between logical blocks`,
      );
      failures++;
    }
  }
}

if (failures) process.exitCode = 1;
