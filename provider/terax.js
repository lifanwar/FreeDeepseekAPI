'use strict';

/**
 * Terax tool-call adapter for FreeDeepseekAPI.
 *
 * This module does not expose an HTTP endpoint. It only:
 * 1. registers the public alias `deepseek-terax` by cloning `deepseek-expert`;
 * 2. builds a stricter tool prompt for Terax;
 * 3. validates model-produced tool calls against the supplied tool allowlist and schema;
 * 4. produces a repair prompt when a malformed or hallucinated tool call is detected.
 */

const MODEL_ID = 'deepseek-terax';
const UPSTREAM_MODEL_ID = 'deepseek-expert';
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOOL_PROMPT_CHARS = 64 * 1024;
const MAX_TEXT_CHARS = 16 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeText(value, maxLength = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').slice(0, maxLength);
}

function safeJsonParse(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Add `deepseek-terax` before FreeDeepseekAPI computes SUPPORTED_MODEL_IDS.
 * The alias is intentionally cloned from `deepseek-expert`, rather than
 * duplicating its web-mode flags. This keeps the alias pinned to Expert mode.
 */
function registerModel(modelConfigs) {
  if (!isPlainObject(modelConfigs)) {
    throw new TypeError('MODEL_CONFIGS must be a plain object.');
  }

  const upstream = modelConfigs[UPSTREAM_MODEL_ID];
  if (!isPlainObject(upstream)) {
    throw new Error(
      `Cannot register ${MODEL_ID}: ${UPSTREAM_MODEL_ID} is missing from MODEL_CONFIGS.`,
    );
  }

  modelConfigs[MODEL_ID] = {
    ...upstream,
    capabilities: {
      ...(isPlainObject(upstream.capabilities) ? upstream.capabilities : {}),
      tools: true,
    },
    real_model: `${upstream.real_model || UPSTREAM_MODEL_ID} (Terax tool-safe alias)`,
    upstream_model: UPSTREAM_MODEL_ID,
    provider: 'terax',
    supported: true,
  };

  return modelConfigs[MODEL_ID];
}

function isTeraxModel(model) {
  return String(model || '').trim().toLowerCase() === MODEL_ID;
}

function normalizeTool(rawTool) {
  if (!isPlainObject(rawTool)) return null;

  let fn = null;
  if (rawTool.type === 'function' && isPlainObject(rawTool.function)) {
    fn = rawTool.function;
  } else if (rawTool.type === 'function' && typeof rawTool.name === 'string') {
    fn = rawTool;
  } else if (typeof rawTool.name === 'string') {
    fn = rawTool;
  }

  const name = String(fn?.name || '').trim();
  if (!TOOL_NAME_RE.test(name)) return null;

  const parameters = isPlainObject(fn.parameters)
    ? fn.parameters
    : isPlainObject(fn.input_schema)
      ? fn.input_schema
      : isPlainObject(fn.inputSchema)
        ? fn.inputSchema
        : { type: 'object', properties: {} };

  return {
    type: 'function',
    function: {
      name,
      description: sanitizeText(fn.description || '', 4_000),
      parameters,
    },
  };
}

function normalizeTools(rawTools) {
  const seen = new Set();
  const tools = [];

  for (const rawTool of asArray(rawTools)) {
    const tool = normalizeTool(rawTool);
    if (!tool) continue;

    const name = tool.function.name;
    if (seen.has(name)) continue;
    seen.add(name);
    tools.push(tool);
  }

  return tools;
}

function normalizeToolChoice(rawChoice, tools) {
  const names = new Set(tools.map((tool) => tool.function.name));

  if (rawChoice === 'none') return { mode: 'none', name: null };
  if (rawChoice === 'required' || rawChoice === 'any') {
    return { mode: 'required', name: null };
  }
  if (rawChoice === 'auto' || rawChoice === undefined || rawChoice === null) {
    return { mode: 'auto', name: null };
  }

  if (isPlainObject(rawChoice)) {
    const requestedName =
      rawChoice.function?.name ||
      rawChoice.name ||
      rawChoice.toolName;

    if (typeof requestedName === 'string' && names.has(requestedName)) {
      return { mode: 'specific', name: requestedName };
    }
  }

  return { mode: 'auto', name: null };
}

function compactToolForPrompt(tool) {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

function formatToolDefinitions(rawTools, rawToolChoice) {
  const tools = normalizeTools(rawTools);
  const choice = normalizeToolChoice(rawToolChoice, tools);

  if (choice.mode === 'none') {
    return [
      '',
      '--- TERAX TOOL POLICY ---',
      'Tools are disabled for this turn.',
      'Answer normally. Do not output tool_call JSON, TOOL_CALL text, or XML tool tags.',
      '--- END TERAX TOOL POLICY ---',
      '',
    ].join('\n');
  }

  if (tools.length === 0) return '';

  let choiceInstruction =
    'Use a tool only when it is necessary. Otherwise answer normally.';

  if (choice.mode === 'required') {
    choiceInstruction = 'You must call exactly one listed tool.';
  } else if (choice.mode === 'specific') {
    choiceInstruction = `You must call exactly the tool named ${JSON.stringify(choice.name)}.`;
  }

  const definitions = JSON.stringify(
    tools.map(compactToolForPrompt),
    null,
    2,
  ).slice(0, MAX_TOOL_PROMPT_CHARS);

  return [
    '',
    '--- TERAX TOOL-CALL SYSTEM ---',
    'You are connected to Terax through an OpenAI-compatible tools interface.',
    choiceInstruction,
    '',
    'When calling a tool, output exactly one JSON object and nothing else:',
    '{"tool_call":{"name":"exact_tool_name","arguments":{}}}',
    '',
    'Hard rules:',
    '1. Use only a tool name present in AVAILABLE_TOOLS below.',
    '2. Never invent, rename, abbreviate, or translate a tool name.',
    '3. Arguments must be one JSON object that satisfies that tool JSON Schema.',
    '4. Do not wrap the JSON in Markdown, XML, prose, or code fences.',
    '5. Request at most one tool per assistant turn.',
    '6. Do not claim that a tool ran. Wait for the actual tool result message.',
    '7. Keep arguments minimal. Do not insert large file contents unless required.',
    '',
    `AVAILABLE_TOOLS=${definitions}`,
    '--- END TERAX TOOL-CALL SYSTEM ---',
    '',
  ].join('\n');
}

function extractBalancedJsonAt(text, startIndex) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\' && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') braceDepth += 1;
    if (char === '}') braceDepth -= 1;
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth -= 1;

    if (braceDepth === 0 && bracketDepth === 0) {
      return text.slice(startIndex, i + 1);
    }
  }

  return null;
}

function findJsonObjects(text) {
  const results = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\' && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && char === '{') {
      const candidate = extractBalancedJsonAt(text, i);
      if (candidate) {
        results.push(candidate);
        i += candidate.length - 1;
      }
    }
  }

  return results;
}

function coerceToolCallObject(value) {
  if (!isPlainObject(value)) return null;

  const wrappedCandidate =
    value.tool_call || value.tool || value.function_call || value.function;
  const hasDirectCallShape =
    typeof value.name === 'string' &&
    (Object.prototype.hasOwnProperty.call(value, 'arguments') ||
      Object.prototype.hasOwnProperty.call(value, 'input'));
  const candidate = wrappedCandidate || (hasDirectCallShape ? value : null);
  if (!isPlainObject(candidate)) return null;

  const fn = isPlainObject(candidate.function) ? candidate.function : candidate;
  const name = fn.name || candidate.name || value.name;
  let args =
    fn.arguments ??
    candidate.arguments ??
    candidate.input ??
    value.arguments ??
    value.input ??
    {};

  if (typeof name !== 'string' || !name.trim()) return null;

  if (typeof args === 'string') {
    const parsed = safeJsonParse(args);
    if (parsed === null) {
      return {
        name: name.trim(),
        arguments: null,
        argumentError: 'arguments is not valid JSON',
      };
    }
    args = parsed;
  }

  if (!isPlainObject(args)) {
    return {
      name: name.trim(),
      arguments: null,
      argumentError: 'arguments must be a JSON object',
    };
  }

  return { name: name.trim(), arguments: args, argumentError: null };
}

function parseLegacyToolCall(text) {
  const nameMatch = text.match(/(?:^|\n)\s*TOOL_CALL\s*:\s*([A-Za-z0-9_-]{1,128})/i);
  if (!nameMatch) return null;

  const afterName = text.slice((nameMatch.index || 0) + nameMatch[0].length);
  const argumentsMatch = afterName.match(/(?:^|\n)\s*arguments\s*:\s*/i);
  if (!argumentsMatch) {
    return {
      name: nameMatch[1],
      arguments: null,
      argumentError: 'legacy TOOL_CALL has no arguments object',
    };
  }

  const argumentStart = (argumentsMatch.index || 0) + argumentsMatch[0].length;
  const remainder = afterName.slice(argumentStart).trimStart();
  if (!remainder.startsWith('{')) {
    return {
      name: nameMatch[1],
      arguments: null,
      argumentError: 'legacy TOOL_CALL arguments must start with {',
    };
  }

  const rawJson = extractBalancedJsonAt(remainder, 0);
  const args = rawJson ? safeJsonParse(rawJson) : null;
  return {
    name: nameMatch[1],
    arguments: isPlainObject(args) ? args : null,
    argumentError: isPlainObject(args) ? null : 'legacy TOOL_CALL arguments is invalid JSON',
  };
}

function extractToolCallCandidate(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { found: false, candidate: null };
  }

  const trimmed = text.trim();
  const xmlMatch = trimmed.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const rawCandidates = [];

  if (xmlMatch) rawCandidates.push(xmlMatch[1].trim());
  for (const match of fencedMatches) rawCandidates.push(match[1].trim());
  if (trimmed.startsWith('{')) {
    const balanced = extractBalancedJsonAt(trimmed, 0);
    if (balanced) rawCandidates.push(balanced);
  }
  rawCandidates.push(...findJsonObjects(trimmed));

  for (const raw of rawCandidates) {
    const parsed = safeJsonParse(raw);
    const candidate = coerceToolCallObject(parsed);
    if (candidate) return { found: true, candidate };
  }

  const legacy = parseLegacyToolCall(trimmed);
  if (legacy) return { found: true, candidate: legacy };

  const looksLikeToolCall =
    /<tool_call>|TOOL_CALL\s*:|"tool_call"\s*:|"function_call"\s*:/i.test(trimmed);

  return { found: looksLikeToolCall, candidate: null };
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function validateSchema(value, schema, path = '$', depth = 0) {
  if (!isPlainObject(schema) || depth > 20) return [];
  const errors = [];

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return errors;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(schema.const, value)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];

  if (declaredTypes.length > 0 && !declaredTypes.some((type) => schemaTypeMatches(value, type))) {
    errors.push(`${path} must be type ${declaredTypes.join(' or ')}`);
    return errors;
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const branches = schema.anyOf.map((branch) => validateSchema(value, branch, path, depth + 1));
    if (!branches.some((branchErrors) => branchErrors.length === 0)) {
      errors.push(`${path} does not satisfy anyOf`);
      return errors;
    }
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const validCount = schema.oneOf
      .map((branch) => validateSchema(value, branch, path, depth + 1))
      .filter((branchErrors) => branchErrors.length === 0)
      .length;
    if (validCount !== 1) {
      errors.push(`${path} must satisfy exactly one oneOf branch`);
      return errors;
    }
  }

  if (isPlainObject(value)) {
    const required = asArray(schema.required).filter((item) => typeof item === 'string');
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, childValue] of Object.entries(value)) {
      if (isPlainObject(properties[key])) {
        errors.push(...validateSchema(childValue, properties[key], `${path}.${key}`, depth + 1));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(
          ...validateSchema(
            childValue,
            schema.additionalProperties,
            `${path}.${key}`,
            depth + 1,
          ),
        );
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) => {
      errors.push(...validateSchema(item, schema.items, `${path}[${index}]`, depth + 1));
    });
  }

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path} is shorter than minLength ${schema.minLength}`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path} is longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path} does not match pattern ${schema.pattern}`);
        }
      } catch {
        // Ignore an invalid schema pattern. The caller supplied the schema.
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }

  return errors;
}

function inspectToolCall(text, rawTools, rawToolChoice) {
  const tools = normalizeTools(rawTools);
  const choice = normalizeToolChoice(rawToolChoice, tools);
  const extracted = extractToolCallCandidate(text);

  if (choice.mode === 'none') {
    if (extracted.found) {
      return {
        found: true,
        call: null,
        error: 'A tool call was produced while tool_choice is none.',
      };
    }
    return { found: false, call: null, error: null };
  }

  if (!extracted.candidate) {
    const missingRequired = choice.mode === 'required' || choice.mode === 'specific';
    return {
      found: extracted.found,
      call: null,
      error: missingRequired
        ? 'The model did not produce the required tool call.'
        : extracted.found
          ? 'The model produced a malformed tool call.'
          : null,
    };
  }

  const { name, arguments: args, argumentError } = extracted.candidate;
  const tool = tools.find((item) => item.function.name === name);

  if (!tool) {
    return {
      found: true,
      call: null,
      error: `Unknown or hallucinated tool ${JSON.stringify(name)}.`,
    };
  }

  if (choice.mode === 'specific' && name !== choice.name) {
    return {
      found: true,
      call: null,
      error: `Expected tool ${JSON.stringify(choice.name)}, received ${JSON.stringify(name)}.`,
    };
  }

  if (argumentError || !isPlainObject(args)) {
    return {
      found: true,
      call: null,
      error: argumentError || 'Tool arguments must be a JSON object.',
    };
  }

  const schemaErrors = validateSchema(args, tool.function.parameters);
  if (schemaErrors.length > 0) {
    return {
      found: true,
      call: null,
      error: `Arguments for ${name} violate its schema: ${schemaErrors.slice(0, 6).join('; ')}`,
    };
  }

  return {
    found: true,
    call: {
      name,
      arguments: JSON.stringify(args),
    },
    error: null,
  };
}

function shouldRepair(rawToolChoice, inspection) {
  if (!inspection || inspection.call) return false;
  if (inspection.error) return true;

  return rawToolChoice === 'required' || rawToolChoice === 'any';
}

function buildRepairInstruction(error, rawTools, rawToolChoice) {
  const tools = normalizeTools(rawTools);
  const choice = normalizeToolChoice(rawToolChoice, tools);

  if (choice.mode === 'none') {
    return [
      '[TERAX TOOL REPAIR]',
      `The previous output was rejected: ${sanitizeText(error || 'tools are disabled', 2_000)}`,
      'Tools are disabled for this turn.',
      'Answer the user normally. Do not output tool-call JSON, TOOL_CALL text, or XML tool tags.',
    ].join('\n');
  }

  const allowedNames = tools.map((tool) => tool.function.name);
  const expected = choice.mode === 'specific'
    ? `Use exactly ${JSON.stringify(choice.name)}.`
    : `Allowed names: ${JSON.stringify(allowedNames)}.`;

  return [
    '[TERAX TOOL REPAIR]',
    `The previous tool-call output was rejected: ${sanitizeText(error || 'invalid tool call', 2_000)}`,
    expected,
    'Return exactly one valid JSON object and no other text:',
    '{"tool_call":{"name":"exact_tool_name","arguments":{}}}',
    'The arguments object must satisfy the selected tool JSON Schema.',
    'Never invent a tool name. Keep arguments minimal.',
  ].join('\n');
}

module.exports = {
  MODEL_ID,
  UPSTREAM_MODEL_ID,
  registerModel,
  isTeraxModel,
  normalizeTools,
  normalizeToolChoice,
  formatToolDefinitions,
  inspectToolCall,
  shouldRepair,
  buildRepairInstruction,
  validateSchema,
};
