import { loadConfig } from "../config/index.js";
import {
  isChunkKind,
  openSearchStore,
  SNIPPET_START,
  SNIPPET_END,
  type ChunkKind,
} from "../search/index.js";

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export function searchCli(args: string[]): void {
  const json = args.includes("--json");
  const errorsOnly = args.includes("--errors");
  const session = flagValue(args, "--session");
  const file = flagValue(args, "--file");
  const tool = flagValue(args, "--tool");
  const provider = flagValue(args, "--provider");
  const project = flagValue(args, "--project");
  const kindRaw = flagValue(args, "--kind");
  const limitRaw = flagValue(args, "--limit");

  let kinds: ChunkKind[] | undefined;
  if (kindRaw !== undefined) {
    if (!isChunkKind(kindRaw)) {
      console.error(
        `invalid --kind "${kindRaw}" (prompt|response|tool_call|tool_result|error)`,
      );
      process.exitCode = 1;
      return;
    }
    kinds = [kindRaw];
  }
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`invalid --limit "${limitRaw}"`);
    process.exitCode = 1;
    return;
  }

  const flagsWithValue = [
    "--session",
    "--file",
    "--tool",
    "--kind",
    "--limit",
    "--provider",
    "--project",
  ];
  const queryTerms: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (flagsWithValue.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    queryTerms.push(arg);
  }
  const query = queryTerms.join(" ");
  if (
    !query &&
    !session &&
    !file &&
    !tool &&
    !errorsOnly &&
    !kinds &&
    !provider &&
    !project
  ) {
    console.error(
      "usage: aap search <query> [--kind k] [--session id] [--file path] [--tool name] [--provider p] [--project p] [--errors] [--limit n] [--json]",
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const search = openSearchStore(config.storage.dir);
  try {
    const hits = search.search({
      query,
      session,
      file,
      tool,
      provider,
      project,
      kinds,
      errorsOnly,
      limit,
    });
    if (json) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }
    if (hits.length === 0) {
      console.log("no matches (run `aap index` if traces were just captured)");
      return;
    }
    for (const hit of hits) {
      const snippet = hit.snippet
        .replaceAll(SNIPPET_START, "«")
        .replaceAll(SNIPPET_END, "»")
        .replace(/\s+/g, " ")
        .trim();
      const tag = hit.tool_name ? `${hit.kind}:${hit.tool_name}` : hit.kind;
      const when = hit.ts ? hit.ts.slice(0, 19).replace("T", " ") : "?";
      console.log(`[${when}] ${tag} session=${hit.session_id.slice(0, 8)}`);
      console.log(`  ${snippet}`);
      if (hit.file_path) console.log(`  file: ${hit.file_path}`);
    }
    console.log(`\n${hits.length} hit(s)`);
  } finally {
    search.close();
  }
}
