export type SchemaSummary = {
  type: string;
  description?: string;
  fields?: Record<string, SchemaSummary>;
  requiredFields?: string[];
  optionalFields?: string[];
  argsScaffold?: Record<string, unknown>;
  exampleArgs?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Minimal shape of a Zod schema for introspection (accessing internal _def). */
interface ZodLike {
  _def?: {
    typeName?: string;
    description?: string;
    type?: unknown;
    shape?: (() => Record<string, ZodLike>) | Record<string, ZodLike>;
    innerType?: ZodLike;
    element?: ZodLike;
    valueType?: ZodLike;
    values?: string[];
    entries?: Record<string, unknown>;
    options?: ZodLike[];
    defaultValue?: (() => unknown) | unknown;
  };
  def?: ZodLike['_def'];
  description?: string;
}

/** Minimal shape of a tool with a Zod parameters schema. */
interface ToolLike {
  parameters?: ZodLike;
}

interface SafeParseSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

const OPTIONAL_ZOD_TYPE_NAMES = new Set<string>(['ZodOptional', 'ZodDefault', 'ZodNullable', 'optional', 'default', 'nullable']);

interface ToolRegistryLike {
  get(name: string): { parameters?: unknown } | undefined;
}

export interface ToolArgsValidationResult {
  registryAvailable: boolean;
  toolFound: boolean;
  schemaValidated: boolean;
  errors: string[];
}

export function zodShapeDescribe(zt: ZodLike | null | undefined): SchemaSummary {
  if (!zt || typeof zt !== 'object') return { type: 'unknown' };
  try {
    const def = getZodDef(zt);
    const typeName = getZodTypeName(def);
    const description = getZodDescription(zt, def);
    if (typeName === 'ZodObject' || typeName === 'object') {
      const shape = getObjectShape(def);
      const fields: Record<string, SchemaSummary> = {};
      const requiredFields: string[] = [];
      const optionalFields: string[] = [];
      const argsScaffold: Record<string, unknown> = {};
      const exampleArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        const field = zodShapeDescribe(value);
        fields[key] = field;
        const optional = isOptionalLike(value);
        if (optional) optionalFields.push(key); else requiredFields.push(key);
        if (!optional) argsScaffold[key] = scaffoldValue(field);
        exampleArgs[key] = exampleValue(field);
      }
      return { type: 'object', description, fields, requiredFields, optionalFields, argsScaffold, exampleArgs };
    }
    if (typeName === 'ZodOptional' || typeName === 'optional') {
      const inner = getInnerSchema(def);
      return { ...zodShapeDescribe(inner), optional: true, description: description ?? describeInner(inner) };
    }
    if (typeName === 'ZodDefault' || typeName === 'default') {
      const inner = getInnerSchema(def);
      return { ...zodShapeDescribe(inner), default: getDefaultValue(def), optional: true, description: description ?? describeInner(inner) };
    }
    if (typeName === 'ZodNullable' || typeName === 'nullable') {
      const inner = getInnerSchema(def);
      return { ...zodShapeDescribe(inner), nullable: true, description: description ?? describeInner(inner) };
    }
    if (typeName === 'ZodArray' || typeName === 'array') return { type: 'array', items: zodShapeDescribe(getArrayElement(def)), description };
    if (typeName === 'ZodEnum' || typeName === 'enum') return { type: 'enum', values: getEnumValues(def), description };
    if (typeName === 'ZodString' || typeName === 'string') return { type: 'string', description };
    if (typeName === 'ZodNumber' || typeName === 'number') return { type: 'number', description };
    if (typeName === 'ZodBoolean' || typeName === 'boolean') return { type: 'boolean', description };
    if (typeName === 'ZodRecord' || typeName === 'record') return { type: 'record', valueType: zodShapeDescribe(getRecordValueType(def)), description };
    if (typeName === 'ZodUnion' || typeName === 'union') return { type: 'union', options: getUnionOptions(def).map(zodShapeDescribe), description };
    return { type: typeName || 'unknown', description };
  } catch {/* expected: fallback to default */
    return { type: 'unknown' };
  }
}

export function getToolScaffold(tool: ToolLike | null | undefined): { requiredFields: string[]; optionalFields: string[]; argsScaffold: Record<string, unknown>; exampleArgs: Record<string, unknown>; parameters: SchemaSummary } {
  const parameters = zodShapeDescribe(tool?.parameters);
  return {
    requiredFields: parameters.requiredFields ?? [],
    optionalFields: parameters.optionalFields ?? [],
    argsScaffold: parameters.argsScaffold ?? {},
    exampleArgs: parameters.exampleArgs ?? {},
    parameters,
  };
}

export function validateToolArgsWithRegistry(
  registry: unknown,
  toolName: string,
  args: unknown,
): ToolArgsValidationResult {
  if (!isToolRegistryLike(registry)) {
    return { registryAvailable: false, toolFound: false, schemaValidated: false, errors: [] };
  }
  const tool = registry.get(toolName);
  if (!tool) {
    return { registryAvailable: true, toolFound: false, schemaValidated: false, errors: [] };
  }
  const parameters = tool.parameters;
  if (!isSafeParseSchema(parameters)) {
    return { registryAvailable: true, toolFound: true, schemaValidated: false, errors: [] };
  }
  const parsed = parameters.safeParse(args ?? {});
  if (parsed.success) {
    return { registryAvailable: true, toolFound: true, schemaValidated: true, errors: [] };
  }
  return {
    registryAvailable: true,
    toolFound: true,
    schemaValidated: true,
    errors: parsed.error.issues.map(formatSchemaIssue),
  };
}

function isToolRegistryLike(value: unknown): value is ToolRegistryLike {
  return !!value && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function';
}

function isSafeParseSchema(value: unknown): value is SafeParseSchema {
  return !!value && typeof value === 'object' && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

function formatSchemaIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
  return `${path}: ${issue.message}`;
}

function isOptionalLike(zt: ZodLike | null | undefined): boolean {
  const typeName = getZodTypeName(getZodDef(zt));
  return typeName !== undefined && OPTIONAL_ZOD_TYPE_NAMES.has(typeName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getZodDef(schema: ZodLike | null | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const rawDef = schema._def ?? schema.def;
  return isRecord(rawDef) ? rawDef : {};
}

function getZodTypeName(def: Record<string, unknown>): string | undefined {
  const typeName = def.typeName ?? def.type;
  return typeof typeName === 'string' ? typeName : undefined;
}

function getZodDescription(schema: ZodLike, def: Record<string, unknown>): string | undefined {
  if (typeof def.description === 'string') return def.description;
  return typeof schema.description === 'string' ? schema.description : undefined;
}

function getObjectShape(def: Record<string, unknown>): Record<string, ZodLike> {
  const rawShape = typeof def.shape === 'function' ? def.shape() : def.shape;
  return isRecord(rawShape) ? rawShape as Record<string, ZodLike> : {};
}

function getInnerSchema(def: Record<string, unknown>): ZodLike | undefined {
  return isRecord(def.innerType) ? def.innerType as ZodLike : undefined;
}

function describeInner(inner: ZodLike | undefined): string | undefined {
  return inner ? getZodDescription(inner, getZodDef(inner)) : undefined;
}

function getArrayElement(def: Record<string, unknown>): ZodLike | undefined {
  if (isRecord(def.element)) return def.element as ZodLike;
  return isRecord(def.type) ? def.type as ZodLike : undefined;
}

function getRecordValueType(def: Record<string, unknown>): ZodLike | undefined {
  return isRecord(def.valueType) ? def.valueType as ZodLike : undefined;
}

function getDefaultValue(def: Record<string, unknown>): unknown {
  return typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
}

function getEnumValues(def: Record<string, unknown>): unknown[] {
  if (Array.isArray(def.values)) return def.values;
  if (isRecord(def.entries)) return Object.values(def.entries);
  return [];
}

function getUnionOptions(def: Record<string, unknown>): ZodLike[] {
  return Array.isArray(def.options) ? def.options.filter((item): item is ZodLike => isRecord(item)) : [];
}

function scaffoldValue(field: SchemaSummary): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'string': return '<string>';
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'record': return {};
    case 'object': return field.argsScaffold ?? {};
    case 'enum': return Array.isArray(field.values) ? field.values[0] : '<enum>';
    default: return null;
  }
}

function exampleValue(field: SchemaSummary): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'string': return 'example';
    case 'number': return 1;
    case 'boolean': return true;
    case 'array': return [];
    case 'record': return { key: 'value' };
    case 'object': return field.exampleArgs ?? field.argsScaffold ?? {};
    case 'enum': return Array.isArray(field.values) ? field.values[0] : 'example';
    default: return null;
  }
}
