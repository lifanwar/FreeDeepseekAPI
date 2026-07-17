'use strict';

const MODEL_ID = 'deepseek-terax';
const CALL_EXAMPLE = '{"tool_call":{"name":"<exact_tool_name>","arguments":{}}}';
const RAW_TOOL_LOG_LIMIT = 20_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTeraxModel(model) {
  return String(model || '').toLowerCase() === MODEL_ID;
}

function toolFunctions(tools = []) {
  return tools
    .filter(tool => tool && tool.type === 'function' && isPlainObject(tool.function))
    .map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    }))
    .filter(tool => typeof tool.name === 'string' && tool.name.length > 0);
}

function formatToolDefinitions(tools) {
  const functions = toolFunctions(tools);
  if (functions.length === 0) return '';

  return `

--- TERAX STRICT TOOL CONTRACT ---
You are in a Terax tool loop. The runtime executes tools; you only request them.
Work: inspect -> understand -> act -> verify. Reuse existing code and choose the smallest correct change. Fix root causes, not symptoms.

When a tool is needed, output exactly one JSON object and nothing else:
${CALL_EXAMPLE}

Rules:
- One tool call per response.
- Use only an exact tool name listed below.
- arguments must be a JSON object matching that tool's JSON Schema, including required fields and types.
- Never invent tools, parameters, paths, results, IDs, capabilities, or success.
- Never emit XML, Markdown fences, TOOL_CALL:, function_call, prose around JSON, or alternate wrappers.
- If no valid tool is needed, answer normally without a tool-call-shaped object.
- Trust only actual tool results. If a call is rejected, correct the reported format/name/arguments instead of repeating it.

Authoritative tools:
${JSON.stringify(functions)}
--- END TERAX STRICT TOOL CONTRACT ---`;
}

function formatHistoricalToolCall(toolCall) {
  let args = toolCall && toolCall.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (_) {
      args = {};
    }
  }
  if (!isPlainObject(args)) args = {};
  return JSON.stringify({ tool_call: { name: toolCall.name, arguments: args } });
}

function invalid(code, message) {
  return { toolCall: null, error: { code, message } };
}

function rejectToolCall(code, message, raw, tools) {
  const originalRaw = String(raw || '').trim();
  const normalizedRaw = normalizeTeraxToolText(originalRaw);

  if (process.env.TERAX_LOG_REJECTED_TOOLS !== '0') {
    let parsed = null;

    try {
      parsed = JSON.parse(normalizedRaw);
    } catch (_) {
      // Tetap log raw response saat JSON benar-benar rusak.
    }

    const call =
      isPlainObject(parsed) && isPlainObject(parsed.tool_call)
        ? parsed.tool_call
        : null;

    const truncate = value => {
      const text = String(value || '');

      return text.length > RAW_TOOL_LOG_LIMIT
        ? `${text.slice(0, RAW_TOOL_LOG_LIMIT)}...[truncated ${
            text.length - RAW_TOOL_LOG_LIMIT
          } chars]`
        : text;
    };

    const logEntry = {
      code,
      message,
      attemptedTool:
        call && typeof call.name === 'string'
          ? call.name
          : null,
      attemptedArguments:
        call && Object.hasOwn(call, 'arguments')
          ? call.arguments
          : null,
      allowedTools: toolFunctions(tools).map(tool => tool.name),
      raw: truncate(originalRaw),
    };

    if (normalizedRaw !== originalRaw) {
      logEntry.normalizedRaw = truncate(normalizedRaw);
    }

    console.error(
      '[TERAX TOOL CALL REJECTED]',
      JSON.stringify(logEntry, null, 2)
    );
  }

  return invalid(code, message);
}

function looksLikeToolAttempt(text) {
  return /TOOL_CALL\s*:|<\/?tool_call\b|```(?:json)?[\s\S]*(?:tool_call|function_call)|["'](?:tool_call|function_call)["']|\{\s*["'](?:tool|function)["']|\{\s*["']name["']\s*:/i.test(text);
}

function hasToolLikeShape(value) {
  if (!isPlainObject(value)) return false;
  return ['tool_call', 'tool', 'function_call', 'function'].some(key => Object.hasOwn(value, key))
    || (Object.hasOwn(value, 'name') && (Object.hasOwn(value, 'arguments') || Object.hasOwn(value, 'input')));
}

function resolveRef(schema, root) {
  if (!schema || typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return schema;
  let current = root;
  for (const rawPart of schema.$ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return current;
}

function valueTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

// ponytail: validates the structural JSON Schema used by Terax tools; add a full validator if conditional/format keywords become runtime requirements.
function validateSchema(value, schema, path = '$', root = schema, depth = 0) {
  if (schema === true || schema === undefined) return null;
  if (schema === false) return `${path} is not allowed`;
  if (!isPlainObject(schema)) return `${path} has an invalid schema`;
  if (depth > 64) return `${path} exceeds schema recursion limit`;

  if (schema.$ref) {
    const resolved = resolveRef(schema, root);
    if (!resolved) return `${path} references an unknown schema`;
    return validateSchema(value, resolved, path, root, depth + 1);
  }

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      const error = validateSchema(value, child, path, root, depth + 1);
      if (error) return error;
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some(child => !validateSchema(value, child, path, root, depth + 1));
    if (!valid) return `${path} does not match any allowed schema`;
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(child => !validateSchema(value, child, path, root, depth + 1)).length;
    if (matches !== 1) return `${path} must match exactly one allowed schema`;
  }

  if (schema.not && !validateSchema(value, schema.not, path, root, depth + 1)) {
    return `${path} matches a forbidden schema`;
  }

  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) {
    return `${path} must equal ${JSON.stringify(schema.const)}`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}`;
  }

  if (value === null && schema.nullable === true) return null;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => valueTypeMatches(value, type))) {
      return `${path} must be ${types.join(' or ')}`;
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} is too short`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} is too long`;
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `${path} does not match the required pattern`;
      } catch (_) {
        return `${path} has an invalid pattern schema`;
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} is below minimum`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} is above maximum`;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return `${path} is below exclusiveMinimum`;
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return `${path} is above exclusiveMaximum`;
    if (typeof schema.multipleOf === 'number' && schema.multipleOf !== 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON) {
      return `${path} must be a multiple of ${schema.multipleOf}`;
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} has too few items`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.uniqueItems) {
      const unique = new Set(value.map(item => JSON.stringify(item)));
      if (unique.size !== value.length) return `${path} must contain unique items`;
    }
    if (Array.isArray(schema.prefixItems)) {
      for (let i = 0; i < schema.prefixItems.length && i < value.length; i++) {
        const error = validateSchema(value[i], schema.prefixItems[i], `${path}[${i}]`, root, depth + 1);
        if (error) return error;
      }
    }
    if (schema.items && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const error = validateSchema(value[i], schema.items, `${path}[${i}]`, root, depth + 1);
        if (error) return error;
      }
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    }
    for (const [key, childValue] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const error = validateSchema(childValue, properties[key], `${path}.${key}`, root, depth + 1);
        if (error) return error;
        continue;
      }
      let matchedPattern = false;
      if (isPlainObject(schema.patternProperties)) {
        for (const [pattern, childSchema] of Object.entries(schema.patternProperties)) {
          let matches = false;
          try {
            matches = new RegExp(pattern).test(key);
          } catch (_) {
            return `${path} has an invalid patternProperties schema`;
          }
          if (matches) {
            matchedPattern = true;
            const error = validateSchema(childValue, childSchema, `${path}.${key}`, root, depth + 1);
            if (error) return error;
          }
        }
      }
      if (!matchedPattern && schema.additionalProperties === false) return `${path}.${key} is not allowed`;
      if (!matchedPattern && isPlainObject(schema.additionalProperties)) {
        const error = validateSchema(childValue, schema.additionalProperties, `${path}.${key}`, root, depth + 1);
        if (error) return error;
      }
    }
  }

  return null;
}

function normalizeTeraxToolText(text) {
  let normalized = String(text || '').trim();
  let previous;

  // Hanya hapus wrapper yang dikenal dari terax.app.
  // Teks/prosa sembarang tetap akan ditolak.
  do {
    previous = normalized;

    normalized = normalized
      .replace(/^<env>\s*[\s\S]*?<\/env>\s*/i, '')
      .trim();

    const fencedJson = normalized.match(
      /^```(?:json)?\s*([\s\S]*?)\s*```$/i
    );

    if (fencedJson) {
      normalized = fencedJson[1].trim();
    }
  } while (normalized !== previous);

  return normalized;
}

function parseToolCall(text, tools) {
  if (!text || typeof text !== 'string') {
    return {
      toolCall: null,
      error: null,
    };
  }

  const raw = text.trim();

  if (!raw) {
    return {
      toolCall: null,
      error: null,
    };
  }

  // terax.app dapat menambahkan <env> atau Markdown JSON fence.
  const normalizedRaw = normalizeTeraxToolText(raw);

  let payload;

  try {
    payload = JSON.parse(normalizedRaw);
  } catch (_) {
    return looksLikeToolAttempt(raw)
      ? rejectToolCall(
          'invalid_terax_json',
          `Tool call must contain one valid JSON object matching ${CALL_EXAMPLE}. Terax <env> prefixes and full JSON code fences are accepted.`,
          raw,
          tools
        )
      : {
          toolCall: null,
          error: null,
        };
  }

  if (
    !isPlainObject(payload) ||
    !Object.hasOwn(payload, 'tool_call')
  ) {
    return hasToolLikeShape(payload)
      ? rejectToolCall(
          'invalid_terax_wrapper',
          `Use the tool-call shape ${CALL_EXAMPLE}.`,
          raw,
          tools
        )
      : {
          toolCall: null,
          error: null,
        };
  }

  if (Object.keys(payload).length !== 1) {
    return rejectToolCall(
      'invalid_terax_wrapper',
      'The top-level object may contain only tool_call.',
      raw,
      tools
    );
  }

  const call = payload.tool_call;

  if (
    !isPlainObject(call) ||
    Object.keys(call).length !== 2 ||
    !Object.hasOwn(call, 'name') ||
    !Object.hasOwn(call, 'arguments')
  ) {
    return rejectToolCall(
      'invalid_terax_call',
      'tool_call must contain exactly name and arguments.',
      raw,
      tools
    );
  }

  if (
    typeof call.name !== 'string' ||
    call.name.length === 0
  ) {
    return rejectToolCall(
      'invalid_terax_name',
      'tool_call.name must be a non-empty string.',
      raw,
      tools
    );
  }

  if (!isPlainObject(call.arguments)) {
    return rejectToolCall(
      'invalid_terax_arguments',
      'tool_call.arguments must be a JSON object.',
      raw,
      tools
    );
  }

  const definitions = toolFunctions(tools);

  const definition = definitions.find(
    tool => tool.name === call.name
  );

  if (!definition) {
    return rejectToolCall(
      'unknown_terax_tool',
      `Unknown tool ${JSON.stringify(
        call.name
      )}. Allowed tools: ${
        definitions.map(tool => tool.name).join(', ') || '(none)'
      }.`,
      raw,
      tools
    );
  }

  const schemaError = validateSchema(
    call.arguments,
    definition.parameters
  );

  if (schemaError) {
    return rejectToolCall(
      'invalid_terax_arguments',
      `${call.name} arguments rejected: ${schemaError}.`,
      raw,
      tools
    );
  }

  return {
    toolCall: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
    error: null,
  };
}

function formatRepairInstruction(error) {
  return `[TERAX TOOL CALL REJECTED]\n${error.message}\nIf a tool is still needed, retry once with exactly ${CALL_EXAMPLE}. Output JSON only. Otherwise answer normally. Do not repeat the invalid call.`;
}

module.exports = {
  MODEL_ID,
  isTeraxModel,
  formatToolDefinitions,
  formatHistoricalToolCall,
  parseToolCall,
  formatRepairInstruction,
  validateSchema,
};
