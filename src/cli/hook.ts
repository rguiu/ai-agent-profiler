import { existsSync } from "node:fs";
import {
  ensureHooksInstalled,
  hooksPath,
  uninstallHooks,
} from "../hook/install.js";
import { REGISTRY } from "../hook/filter-runner.js";

export function hook(args: string[]): void {
  const sub = args[0];

  if (sub === "install") {
    ensureHooksInstalled();
    console.log(`hooks installed: ${hooksPath()}`);
    return;
  }

  if (sub === "uninstall") {
    if (uninstallHooks()) {
      console.log("hooks uninstalled");
    } else {
      console.log("no hooks found to uninstall");
    }
    return;
  }

  if (sub === "status") {
    const installed = existsSync(hooksPath());
    console.log(`hooks: ${installed ? "installed" : "not installed"}`);
    console.log(`path:   ${hooksPath()}`);
    return;
  }

  if (sub === "list") {
    for (const [cmd, subs] of Object.entries(REGISTRY)) {
      console.log(`${cmd}:`);
      for (const [subName, entry] of Object.entries(subs)) {
        const label = subName || "(default)";
        console.log(`  ${label.padEnd(10)} ${entry.description}`);
      }
    }
    return;
  }

  if (sub === "measure") {
    const enabled = args[1] === "on" || args[1] === "off";
    if (!enabled) {
      console.log(
        "aap hook measure — enable/disable per-call byte measurement\n",
      );
      console.log("  aap hook measure on     enable (sets AAP_HOOK_MEASURE=1)");
      console.log("  aap hook measure off    disable");
      return;
    }
    const state = args[1] === "on" ? "1" : "0";
    process.env.AAP_HOOK_MEASURE = state;
    console.log(`measurement ${args[1] === "on" ? "enabled" : "disabled"}`);
    console.log("  metrics written to ~/.aap/metrics/<session>.jsonl");
    console.log(
      "  requires --hooks and AAP_HOOK_METRICS_DIR to be set (use aap run --hooks)",
    );
    return;
  }

  console.log("aap hook — tool output filtering\n");
  console.log("  aap hook install     install wrappers to ~/.aap/bin/");
  console.log("  aap hook uninstall   remove wrappers from ~/.aap/bin/");
  console.log("  aap hook status      show installation status");
  console.log("  aap hook list        list all filtered commands");
  console.log("  aap hook measure     enable/disable per-call measurement");
}
