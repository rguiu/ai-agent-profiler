import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureHooksInstalled, hooksPath } from "../hook/install.js";

const HOOK_MODE_FILE = join(homedir(), ".aap", "hook-mode");

type HookMode = "off" | "normal" | "aggressive";

export function hook(args: string[], cfg?: unknown): void {
  const sub = args[0];

  if (sub === "install") {
    ensureHooksInstalled();
    console.log(`hooks installed: ${hooksPath()}`);
    console.log('run "aap hook mode" to see current mode');
    return;
  }

  if (sub === "mode") {
    const mode = args[1] as HookMode | undefined;
    if (mode && ["off", "normal", "aggressive"].includes(mode)) {
      writeFileSync(HOOK_MODE_FILE, `${mode}\n`, "utf8");
      console.log(`hook mode set to: ${mode}`);
    } else {
      const current = existsSync(HOOK_MODE_FILE)
        ? readFileSync(HOOK_MODE_FILE, "utf8").trim()
        : "normal";
      console.log(`hook mode: ${current}`);
      console.log('usage: aap hook mode [off|normal|aggressive]');
    }
    return;
  }

  if (sub === "status") {
    const installed = existsSync(hooksPath());
    const mode = existsSync(HOOK_MODE_FILE)
      ? readFileSync(HOOK_MODE_FILE, "utf8").trim()
      : "normal";
    console.log(`hooks: ${installed ? "installed" : "not installed"}`);
    console.log(`mode:   ${mode}`);
    console.log(`path:   ${hooksPath()}`);
    return;
  }

  console.log("aap hook — tool output filtering\n");
  console.log("  aap hook install     install hooks to ~/.aap/hooks.sh");
  console.log("  aap hook mode [MODE] get/set filtering (off|normal|aggressive)");
  console.log("  aap hook status      show installation status");
}
