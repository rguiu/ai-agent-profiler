import type { SessionToolCall } from "../store/index.js";
import { categorize, classifyCommand } from "./commands.js";

export interface SearchReadChain {
  searchRequestId: string;
  searchCommand: string;
  searchCategory: string;
  readRequestId: string;
  readFile: string;
  readTool: string;
  stepsBetween: number;
}

function isReadLike(name: string): boolean {
  return /read|cat|view|open/i.test(name);
}

function pathFromArgs(args: string | null): string | null {
  if (!args) return null;
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    for (const key of ["file_path", "filePath", "path", "filename", "file"]) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    /* arguments were not valid JSON */
  }
  return null;
}

function extractCommand(argsJson: string | null): string | null {
  if (!argsJson) return null;
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const value = obj[key];
      if (typeof value === "string") return value;
    }
  } catch {
    /* arguments were not valid JSON */
  }
  return null;
}

function splitTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of command) {
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function extractSearchDir(command: string): string | null {
  const tokens = splitTokens(command);
  if (tokens.length < 2) return null;
  const program = (tokens[0] ?? "").split("/").pop() ?? "";
  const isRgLike = program === "rg" || program === "grep";
  const positional = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (positional.length === 0) return null;
  if (program === "find") return positional[0] ?? null;
  if (program === "ls") {
    return positional.length > 0 && !positional[0]?.startsWith("-")
      ? (positional[0] ?? ".")
      : ".";
  }
  if (isRgLike && positional.length >= 2) {
    for (let i = positional.length - 1; i >= 0; i--) {
      const tok = positional[i] ?? "";
      if (
        tok.startsWith("/") ||
        tok.startsWith("./") ||
        tok.startsWith("../") ||
        tok === "."
      ) {
        return tok;
      }
    }
    return positional.at(-1) ?? null;
  }
  for (let i = positional.length - 1; i >= 0; i--) {
    const tok = positional[i] ?? "";
    if (tok.includes("/") || tok === "." || tok === "..") return tok;
  }
  return positional[0] ?? null;
}

function pathWithinDir(filePath: string, searchDir: string): boolean {
  const normalizedFile = filePath.replace(/\/$/, "");
  const normalizedDir = searchDir.replace(/\/$/, "");
  if (normalizedFile === normalizedDir) return true;
  if (normalizedFile.startsWith(normalizedDir + "/")) return true;
  if (normalizedDir === ".") return true;
  if (!normalizedDir.startsWith("/") && normalizedFile.startsWith("/")) {
    const suffix = normalizedDir === "." ? "" : normalizedDir;
    const segments = normalizedFile.split("/").filter(Boolean);
    for (let i = 0; i <= segments.length; i++) {
      const tail = segments.slice(i).join("/");
      if (tail === suffix || tail.startsWith(suffix + "/")) return true;
    }
  }
  return false;
}

export function detectSearchReadChains(
  toolCalls: SessionToolCall[],
): SearchReadChain[] {
  const chains: SearchReadChain[] = [];
  const requests = new Map<string, number>();
  const orderedIds: string[] = [];
  for (const tc of toolCalls) {
    if (!requests.has(tc.request_id)) {
      requests.set(tc.request_id, orderedIds.length);
      orderedIds.push(tc.request_id);
    }
  }

  const searchOps: Array<{
    requestId: string;
    requestIdx: number;
    command: string;
    category: string;
    dir: string;
  }> = [];

  for (const tc of toolCalls) {
    const name = tc.name.toLowerCase();
    if (name !== "bash" && name !== "shell" && name !== "sh") continue;
    const command = extractCommand(tc.arguments);
    if (!command) continue;
    const classified = classifyCommand(command);
    const category = categorize(classified);
    if (category !== "search") continue;
    const dir = extractSearchDir(command);
    if (!dir) continue;
    searchOps.push({
      requestId: tc.request_id,
      requestIdx: requests.get(tc.request_id) ?? 0,
      command,
      category,
      dir,
    });
  }

  const readOps: Array<{
    requestId: string;
    requestIdx: number;
    tool: string;
    file: string;
  }> = [];

  for (const tc of toolCalls) {
    if (!isReadLike(tc.name)) continue;
    const file = pathFromArgs(tc.arguments);
    if (!file) continue;
    readOps.push({
      requestId: tc.request_id,
      requestIdx: requests.get(tc.request_id) ?? 0,
      tool: tc.name,
      file,
    });
  }

  for (const search of searchOps) {
    for (const read of readOps) {
      if (read.requestIdx < search.requestIdx) continue;
      if (!pathWithinDir(read.file, search.dir)) continue;
      chains.push({
        searchRequestId: search.requestId,
        searchCommand: search.command,
        searchCategory: search.category,
        readRequestId: read.requestId,
        readFile: read.file,
        readTool: read.tool,
        stepsBetween: read.requestIdx - search.requestIdx,
      });
    }
  }

  return chains;
}
