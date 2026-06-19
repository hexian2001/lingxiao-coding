import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';

const PluginIdSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_-]*$/, 'plugin id must start with a lowercase letter and contain only a-z, 0-9, _ or -');

const RelativePathSchema = z.string()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith('/') && !value.includes('\0'), 'path must be relative')
  .refine((value) => !value.split(/[\\/]+/).includes('..'), 'path must stay inside the plugin directory');

const AuthorSchema = z.union([
  z.string().max(200),
  z.object({
    name: z.string().max(200).optional(),
    email: z.string().max(200).optional(),
    url: z.string().max(500).optional(),
  }).strict(),
]).optional();

const RepositorySchema = z.union([
  z.string().max(500),
  z.object({
    type: z.string().max(80).optional(),
    url: z.string().max(500).optional(),
    directory: RelativePathSchema.optional(),
  }).strict(),
]).optional();

const InterfaceSchema = z.object({
  displayName: z.string().max(120).optional(),
  shortDescription: z.string().max(300).optional(),
  longDescription: z.string().max(2000).optional(),
  icon: RelativePathSchema.optional(),
  composerIcon: RelativePathSchema.optional(),
  logo: RelativePathSchema.optional(),
  category: z.string().max(80).optional(),
  developerName: z.string().max(120).optional(),
  websiteURL: z.string().max(500).optional(),
  privacyPolicyURL: z.string().max(500).optional(),
  termsOfServiceURL: z.string().max(500).optional(),
  defaultPrompt: z.union([z.string().max(1000), z.array(z.string().max(1000))]).optional(),
  capabilities: z.array(z.string().max(80)).default([]),
  brandColor: z.string().max(40).optional(),
  screenshots: z.array(RelativePathSchema).default([]),
}).strict().default({ capabilities: [], screenshots: [] });

const McpHeaderSchema = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(4000),
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string().max(4000),
  z.array(JsonValueSchema),
  z.record(z.string().max(120), JsonValueSchema),
]));

const MetadataRecordSchema = z.record(z.string().max(120), JsonValueSchema).default({});

const PluginToolDeclarationSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  kind: z.string().max(80).optional(),
  path: RelativePathSchema.optional(),
  capabilities: z.array(z.string().max(80)).default([]),
  metadata: MetadataRecordSchema,
}).strict();

const PluginHookDeclarationSchema = z.object({
  name: z.string().min(1).max(120),
  event: z.string().max(120).optional(),
  description: z.string().max(1000).optional(),
  path: RelativePathSchema.optional(),
  capabilities: z.array(z.string().max(80)).default([]),
  metadata: MetadataRecordSchema,
}).strict();

const PluginScriptDeclarationSchema = z.union([
  z.string().max(2000),
  z.object({
    description: z.string().max(1000).optional(),
    command: z.string().max(2000).optional(),
    args: z.array(z.string().max(500)).default([]),
    cwd: RelativePathSchema.optional(),
    metadata: MetadataRecordSchema,
  }).strict(),
]);

export const PluginMcpServerSchema = z.discriminatedUnion('transport', [
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/).optional(),
    name: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    enabled: z.boolean().default(true),
    transport: z.literal('streamable-http'),
    url: z.string().url(),
    headers: z.array(McpHeaderSchema).default([]),
  }).strict(),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/).optional(),
    name: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    enabled: z.boolean().default(true),
    transport: z.literal('stdio'),
    command: z.string().min(1).max(2000),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: RelativePathSchema.optional(),
  }).strict(),
]);

export const PluginManifestSchema = z.object({
  id: PluginIdSchema.optional(),
  name: PluginIdSchema,
  version: z.string().min(1).max(100).default('0.0.0'),
  description: z.string().max(2000).default(''),
  author: AuthorSchema,
  homepage: z.string().max(500).optional(),
  repository: RepositorySchema,
  license: z.string().max(80).optional(),
  keywords: z.array(z.string().max(80)).default([]),
  interface: InterfaceSchema,
  skills: z.union([RelativePathSchema, z.array(RelativePathSchema)]).optional(),
  mcp: RelativePathSchema.optional(),
  mcpServers: z.array(PluginMcpServerSchema).default([]),
  apps: z.union([RelativePathSchema, z.array(RelativePathSchema)]).optional(),
  assets: z.union([RelativePathSchema, z.array(RelativePathSchema)]).optional(),
  capabilities: z.array(z.string().max(80)).default([]),
  tools: z.array(PluginToolDeclarationSchema).default([]),
  hooks: z.array(PluginHookDeclarationSchema).default([]),
  scripts: z.record(z.string().max(120), PluginScriptDeclarationSchema).default({}),
}).strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginMcpServerManifest = z.infer<typeof PluginMcpServerSchema>;

export interface LoadedPluginManifest {
  manifest: PluginManifest;
  manifestPath: string;
  pluginRoot: string;
}

function candidateManifestPaths(pluginRoot: string): string[] {
  return [
    join(pluginRoot, '.lingxiao-plugin', 'plugin.json'),
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
  ];
}

export function findPluginManifestPath(pluginRoot: string): string | null {
  for (const candidate of candidateManifestPaths(pluginRoot)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadPluginManifest(pluginRoot: string): LoadedPluginManifest | null {
  const resolvedRoot = resolve(pluginRoot);
  const manifestPath = findPluginManifestPath(resolvedRoot);
  if (!manifestPath) return null;
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const parsed = PluginManifestSchema.parse(raw);
  return {
    manifest: {
      ...parsed,
      id: parsed.id || parsed.name,
    },
    manifestPath,
    pluginRoot: resolvedRoot,
  };
}

export function validatePluginManifest(value: unknown): PluginManifest {
  const parsed = PluginManifestSchema.parse(value);
  return {
    ...parsed,
    id: parsed.id || parsed.name,
  };
}
