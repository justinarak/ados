#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CanonicalConversionEventInput,
  CreativeLintRequest,
  PlatformDestination,
} from "@ados/schemas";
import { AdOSGateway } from "./app.js";

export interface CliExecutionResult {
  exitCode: number;
  stdout: string;
}

/**
 * Developer CLI Runner (`ados`):
 * Supports:
 * - `ados test-event --file sample_purchase.json [--destinations meta,google]`
 * - `ados lint-creative --file sample_creative.json`
 * - `ados privacy purge-user --identifier <sha256> [--all-platforms]`
 */
export async function runAdOSCli(
  argv: readonly string[],
  gateway: AdOSGateway = new AdOSGateway()
): Promise<CliExecutionResult> {
  const args = [...argv];
  const command = args[0];

  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  };

  if (!command || command === "--help" || command === "-h") {
    return {
      exitCode: 0,
      stdout: [
        "AdOS CLI (v0.2.0-alpha.0) — The Developer-Native Ad Operating System",
        "",
        "Usage:",
        "  ados test-event --file <path.json> [--destinations meta,google,tiktok,reddit]",
        "  ados lint-creative --file <path.json>",
        "  ados privacy purge-user --identifier <sha256> [--all-platforms]",
      ].join("\n"),
    };
  }

  if (command === "test-event") {
    const filePath = getFlag("--file");
    if (!filePath) {
      return { exitCode: 1, stdout: "Error: Missing required --file <path.json> argument" };
    }
    const rawJson = JSON.parse(
      readFileSync(resolve(filePath), "utf8")
    ) as CanonicalConversionEventInput;

    const destFlag = getFlag("--destinations");
    if (destFlag) {
      rawJson.destinations = destFlag
        .split(",")
        .map((d) => d.trim() as PlatformDestination)
        .filter(Boolean);
    }

    const result = await gateway.dispatchConversion(rawJson);
    return {
      exitCode: result.status === "DISPATCHED" ? 0 : 2,
      stdout: JSON.stringify(result, null, 2),
    };
  }

  if (command === "lint-creative") {
    const filePath = getFlag("--file");
    if (!filePath) {
      return { exitCode: 1, stdout: "Error: Missing required --file <path.json> argument" };
    }
    const rawJson = JSON.parse(readFileSync(resolve(filePath), "utf8")) as CreativeLintRequest;
    const report = gateway.lintCreative(rawJson);
    return {
      exitCode: report.valid ? 0 : 2,
      stdout: JSON.stringify(report, null, 2),
    };
  }

  if (command === "privacy" && args[1] === "purge-user") {
    const rawIdentifier = getFlag("--identifier") ?? "";
    const cleanedHash = rawIdentifier.replace(/^sha256:/i, "");
    const result = await gateway.purgeUserIdentifier({
      identifier_sha256: cleanedHash,
      destinations: ["meta", "google", "tiktok", "reddit"],
      reason: "GDPR_ART_17",
    });
    return {
      exitCode: 0,
      stdout: JSON.stringify(result, null, 2),
    };
  }

  return {
    exitCode: 1,
    stdout: `Unknown command: "${args.join(" ")}". Run "ados --help" for usage.`,
  };
}
