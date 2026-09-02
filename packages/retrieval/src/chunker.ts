import { Node, SyntaxKind, type SourceFile, type Statement } from "ts-morph";

export interface Chunk {
  index: number;
  kind: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

/** Embedding inputs are capped; a very large declaration is truncated, not dropped. */
const MAX_CHARS = 8_000;

const DECLARATION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.VariableStatement,
]);

/**
 * Splits on declaration boundaries rather than a fixed window.
 *
 * A fixed-size window cuts through the middle of a function, so the retrieved
 * fragment is half a signature and half an unrelated body — it embeds badly
 * and reads worse in a prompt. Declarations are the unit a reviewer reasons in.
 */
export function chunkFile(sourceFile: SourceFile): Chunk[] {
  const chunks: Chunk[] = [];

  for (const statement of sourceFile.getStatements()) {
    if (!DECLARATION_KINDS.has(statement.getKind())) continue;

    const content = statement.getText().slice(0, MAX_CHARS);
    if (content.trim().length === 0) continue;

    chunks.push({
      index: chunks.length,
      kind: statement.getKindName(),
      symbol: symbolName(statement),
      startLine: statement.getStartLineNumber(),
      endLine: statement.getEndLineNumber(),
      content,
    });
  }

  // A file with no declarations still gets one chunk so structural retrieval
  // can fetch its content. But a barrel is tagged as such: its text is nothing
  // but re-exports, and it is pure noise in semantic results.
  if (chunks.length === 0) {
    const text = sourceFile.getFullText().trim();
    if (text.length > 0) {
      chunks.push({
        index: 0,
        kind: isBarrel(sourceFile) ? "Barrel" : "SourceFile",
        symbol: null,
        startLine: 1,
        endLine: sourceFile.getEndLineNumber(),
        content: text.slice(0, MAX_CHARS),
      });
    }
  }

  return chunks;
}

/** True when every statement is an import or a re-export. */
function isBarrel(sourceFile: SourceFile): boolean {
  const statements = sourceFile.getStatements();
  if (statements.length === 0) return false;
  return statements.every(
    (s) =>
      s.getKind() === SyntaxKind.ImportDeclaration ||
      s.getKind() === SyntaxKind.ExportDeclaration,
  );
}

function symbolName(statement: Statement): string | null {
  if (Node.isVariableStatement(statement)) {
    return statement.getDeclarations()[0]?.getName() ?? null;
  }
  if (Node.isNameable(statement) || Node.isNamed(statement)) {
    return statement.getName() ?? null;
  }
  return null;
}

/**
 * What actually gets embedded. The path and symbol are prepended so a search
 * for "invoice total" can match a function whose body never says "invoice".
 */
export function embeddingText(path: string, chunk: Chunk): string {
  const header = chunk.symbol ? `${path} — ${chunk.kind} ${chunk.symbol}` : path;
  return `${header}\n\n${chunk.content}`;
}
