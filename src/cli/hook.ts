import { existsSync } from "node:fs";
import { ensureHooksInstalled, hooksPath } from "../hook/install.js";

export function hook(args: string[]): void {
  const sub = args[0];

  if (sub === "install") {
    ensureHooksInstalled();
    console.log(`hooks installed: ${hooksPath()}`);
    return;
  }

  if (sub === "status") {
    const installed = existsSync(hooksPath());
    console.log(`hooks: ${installed ? "installed" : "not installed"}`);
    console.log(`path:   ${hooksPath()}`);
    return;
  }

  console.log("aap hook — tool output filtering\n");
  console.log("  aap hook install     install wrappers to ~/.aap/bin/");
  console.log("  aap hook status      show installation status");
}
