import type { AppServerOptions } from "../codex/appServerClient";
import type { JsonValue } from "../codex/errors";
import { invalidParams } from "../errors";

interface ExperimentalToolSpec {
  canonicalName: string;
  aliases: string[];
  featureFlags: string[];
}

const TOOL_SPECS: ExperimentalToolSpec[] = [
  {
    canonicalName: "ask-user-question",
    aliases: [
      "ask-user-question",
      "ask_user_question",
      "askuserquestion",
      "request-user-input",
      "request_user_input",
      "requestuserinput",
    ],
    featureFlags: ["default_mode_request_user_input"],
  },
  {
    canonicalName: "request-permissions",
    aliases: [
      "request-permissions",
      "request_permissions",
      "requestpermissions",
    ],
    featureFlags: ["request_permissions_tool"],
  },
];

const ALIAS_TO_SPEC = new Map<string, ExperimentalToolSpec>();
for (const spec of TOOL_SPECS) {
  for (const alias of spec.aliases) {
    ALIAS_TO_SPEC.set(alias, spec);
  }
}

export const SUPPORTED_EXPERIMENTAL_TOOLS = TOOL_SPECS.map((spec) => spec.canonicalName);

export function parseExperimentalTools(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (value === true) {
    throw invalidParams(
      `--experimental-tools requires a comma-separated value (${SUPPORTED_EXPERIMENTAL_TOOLS.join(", ")})`,
    );
  }

  const rawParts = Array.isArray(value)
    ? value.flatMap((part) => splitCsv(part))
    : splitCsv(value);
  if (rawParts.length === 0) return [];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const part of rawParts) {
    const normalized = normalizeAlias(part);
    const spec = ALIAS_TO_SPEC.get(normalized);
    if (!spec) {
      throw invalidParams(
        `unsupported experimental tool '${part}'; supported values: ${SUPPORTED_EXPERIMENTAL_TOOLS.join(", ")}`,
      );
    }
    if (seen.has(spec.canonicalName)) continue;
    seen.add(spec.canonicalName);
    deduped.push(spec.canonicalName);
  }
  return deduped;
}

export function buildExperimentalToolThreadConfig(tools: string[]): Record<string, JsonValue> | null {
  const features: Record<string, JsonValue> = {};
  for (const spec of specsForTools(tools)) {
    for (const featureFlag of spec.featureFlags) {
      features[featureFlag] = true;
    }
  }
  return Object.keys(features).length > 0 ? { features } : null;
}

export function buildExperimentalToolAppServerOptions(tools: string[]): AppServerOptions | undefined {
  const configOverrides = Array.from(new Set(
    specsForTools(tools).flatMap((spec) => spec.featureFlags.map((flag) => `features.${flag}=true`)),
  ));
  if (configOverrides.length === 0) return undefined;
  return { configOverrides };
}

function specsForTools(tools: string[]): ExperimentalToolSpec[] {
  return tools.map((tool) => {
    const spec = TOOL_SPECS.find((candidate) => candidate.canonicalName === tool);
    if (!spec) {
      throw invalidParams(
        `unsupported experimental tool '${tool}'; supported values: ${SUPPORTED_EXPERIMENTAL_TOOLS.join(", ")}`,
      );
    }
    return spec;
  });
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string") {
    throw invalidParams("experimental tool lists must be strings");
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeAlias(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}
