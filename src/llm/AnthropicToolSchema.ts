type JsonRecord = Record<string, unknown>;

const COMPOSITION_KEYS = new Set(['oneOf', 'anyOf', 'allOf']);
const DROP_KEYS = new Set([
  '$schema',
  '$defs',
  'definitions',
  'default',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependentRequired',
  'unevaluatedProperties',
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primitiveJsonType(value: unknown): string | undefined {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null) return undefined;
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mergeEnum(left: unknown, right: unknown): unknown[] | undefined {
  const values = [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ];
  if (values.length === 0) return undefined;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function mergeSchema(left: unknown, right: unknown): unknown {
  if (!isRecord(left)) return right;
  if (!isRecord(right)) return left;

  const out: JsonRecord = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (key === 'properties') {
      out.properties = mergeProperties(out.properties, value);
      continue;
    }
    if (key === 'required') {
      const required = [...stringArray(out.required), ...stringArray(value)];
      if (required.length > 0) out.required = Array.from(new Set(required));
      continue;
    }
    if (key === 'enum') {
      const merged = mergeEnum(out.enum, value);
      if (merged) out.enum = merged;
      continue;
    }
    if (key === 'type') {
      if (out.type === undefined) out.type = value;
      else if (out.type !== value) delete out.type;
      continue;
    }
    if (out[key] === undefined) {
      out[key] = value;
    }
  }
  return out;
}

function mergeProperties(left: unknown, right: unknown): JsonRecord {
  const out: JsonRecord = isRecord(left) ? { ...left } : {};
  if (!isRecord(right)) return out;
  for (const [key, value] of Object.entries(right)) {
    out[key] = key in out ? mergeSchema(out[key], value) : value;
  }
  return out;
}

function commonRequired(variants: JsonRecord[]): string[] {
  if (variants.length === 0) return [];
  const sets = variants.map((variant) => new Set(stringArray(variant.required)));
  if (sets.some((set) => set.size === 0)) return [];
  return Array.from(sets[0]).filter((field) => sets.every((set) => set.has(field)));
}

function mergeCompositionVariants(variants: JsonRecord[]): JsonRecord {
  if (variants.length === 0) return {};

  const objectLike = variants.some((variant) => variant.type === 'object' || isRecord(variant.properties));
  if (!objectLike) {
    let merged: unknown = {};
    for (const variant of variants) merged = mergeSchema(merged, variant);
    return isRecord(merged) ? merged : {};
  }

  const properties: JsonRecord = {};
  for (const variant of variants) {
    Object.assign(properties, mergeProperties(properties, variant.properties));
  }

  const out: JsonRecord = {
    type: 'object',
    properties,
  };
  const required = commonRequired(variants).filter((field) => field in properties);
  if (required.length > 0) out.required = required;
  if (variants.every((variant) => variant.additionalProperties === false)) {
    out.additionalProperties = false;
  }
  return out;
}

function normalizeRequired(schema: JsonRecord): void {
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const required = stringArray(schema.required).filter((field) => !properties || field in properties);
  if (required.length > 0) schema.required = Array.from(new Set(required));
  else delete schema.required;
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!isRecord(value)) return value;

  const compositionVariants: JsonRecord[] = [];
  const base: JsonRecord = {};

  for (const [key, nested] of Object.entries(value)) {
    if (COMPOSITION_KEYS.has(key)) {
      if (Array.isArray(nested)) {
        compositionVariants.push(...nested.map(normalizeSchema).filter(isRecord));
      }
      continue;
    }
    if (DROP_KEYS.has(key)) continue;
    if (key === 'const') {
      base.enum = mergeEnum(base.enum, [nested]);
      const type = primitiveJsonType(nested);
      if (type && base.type === undefined) base.type = type;
      continue;
    }
    base[key] = normalizeSchema(nested);
  }

  const merged = compositionVariants.length > 0
    ? mergeSchema(base, mergeCompositionVariants(compositionVariants))
    : base;
  const record = isRecord(merged) ? merged : {};
  normalizeRequired(record);
  return record;
}

export function normalizeAnthropicToolInputSchema(schema: unknown): JsonRecord {
  const normalized = normalizeSchema(schema);
  const out = isRecord(normalized) ? normalized : {};
  if (out.type !== 'object') out.type = 'object';
  if (!isRecord(out.properties)) out.properties = {};
  normalizeRequired(out);
  return out;
}
