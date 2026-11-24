import { z } from "zod";

// The result shapes, parsed .strict() against what each tool returns. No tool declares an
// outputSchema: it requires structuredContent too, and a host that reads both (Codex) puts the
// payload in context twice. Field meanings are in skills/delegate/reference.md.
export const delegateOutputShape = {
  result: z.string(),
  resultSource: z.enum(["pre-tool-fallback", "unfinished-tool", "none"]).optional(),
  effectiveModel: z.string().optional(),
  effectiveEffort: z.record(z.string(), z.string()).optional(),
  stopReason: z.string().optional(),
  usage: z.object({
    scope: z.literal("turn"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedReadTokens: z.number().optional(),
    cachedWriteTokens: z.number().optional(),
    thoughtTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).strict().optional(),
  context: z.object({ used: z.number(), size: z.number() }).strict().optional(),
  sessionId: z.string(),
  filesReportedByEditTools: z.array(z.string()).optional(),
  questions: z.array(z.object({
    question: z.string(),
    options: z.array(z.string()),
    multiSelect: z.boolean().optional(),
    recommended: z.string().optional(),
  }).strict()).optional(),
  execution: z.object({
    toolCalls: z.record(z.string(), z.number()),
    commands: z.array(z.object({
      command: z.string(),
      exitCode: z.number().optional(),
      status: z.string().optional(),
      runs: z.number().optional(),
    }).strict()).optional(),
    commandsOmitted: z.number().optional(),
  }).strict().optional(),
  resumed: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  protocolWarnings: z.array(z.string()).optional(),
  plan: z.object({
    path: z.string(),
    overview: z.string().optional(),
    detail: z.string().optional(),
  }).optional(),
  artifacts: z.array(z.object({
    path: z.string(),
    summary: z.string().optional(),
  })).optional(),
};

// Relayed agent fields stay unknown, so an odd value is a diagnostic, not a failed call. Its own
// shape because .strict() on agent does not look inside it.
export const doctorHandshakeShape = {
  ok: z.boolean(),
  error: z.string().optional(),
  protocolVersion: z.unknown().optional(),
  agentCapabilities: z.unknown().optional(),
  models: z.array(z.unknown()).optional(),
  currentModel: z.unknown().optional(),
  modes: z.array(z.unknown()).optional(),
  tier: z.unknown().optional(),
  // Built here, not relayed, so it gets a real type.
  currentModelOptions: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    category: z.string().optional(),
    values: z.array(z.string()),
    currentValue: z.string().optional(),
  })).optional(),
};

export const doctorAgentShape = {
  found: z.boolean(),
  command: z.string(),
  version: z.string().nullable(),
  error: z.string().optional(),
  handshake: z.object(doctorHandshakeShape).passthrough().optional(),
};

// agent is split out because a top-level .strict() does not look inside a nested object.
export const doctorOutputShape = {
  plugin: z.object({ version: z.string() }).passthrough(),
  client: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    capabilities: z.record(z.string(), z.unknown()),
    protocolVersion: z.string().optional(),
  }).passthrough(),
  agent: z.object(doctorAgentShape).passthrough(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    cwd: z.string(),
    transport: z.literal("stdio"),
  }),
  env: z.record(z.string(), z.unknown()),
};
