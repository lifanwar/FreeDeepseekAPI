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
const MAX_INLINE_NODE_EVAL_CHARS = 240;
const SHELL_TOOL_NAME_RE = /(?:^|[_-])(bash|shell|terminal|powershell|pwsh|cmd|exec|command)(?:[_-](run|exec))?$|^(bash_run|shell_run|terminal_run|powershell_run|pwsh_run|cmd_run)$/i;
const SHELL_COMMAND_KEYS = ['command', 'cmd', 'script'];

const TOOL_ERROR_CODES = Object.freeze({
  TOOL_CALL_SHAPE_INVALID: 'TERAX_TOOL_CALL_SHAPE_INVALID',
  TOOL_CALL_ENVELOPE_INVALID: 'TERAX_TOOL_CALL_ENVELOPE_INVALID',
  SHELL_ARGUMENTS_INVALID_JSON: 'TERAX_SHELL_ARGUMENTS_INVALID_JSON',
  SHELL_NODE_EVAL_UNSAFE: 'TERAX_SHELL_NODE_EVAL_UNSAFE',
  SHELL_COMMAND_INVALID: 'TERAX_SHELL_COMMAND_INVALID',
  TEST_ASSERTION_UNSAFE: 'TERAX_TEST_ASSERTION_UNSAFE',
  TEST_RESULT_UNRELIABLE: 'TERAX_TEST_RESULT_UNRELIABLE',
  TOOL_EXIT_NONZERO: 'TERAX_TOOL_EXIT_NONZERO',
  TOOL_TIMEOUT: 'TERAX_TOOL_TIMEOUT',
  TOOL_RESULT_ERROR: 'TERAX_TOOL_RESULT_ERROR',
  TOOL_OUTPUT_FAILURE: 'TERAX_TOOL_OUTPUT_FAILURE',
  EVIDENCE_CONTRADICTION: 'TERAX_EVIDENCE_CONTRADICTION',
});

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


function makeCodedError(code, message) {
  return `[${code}] ${message}`;
}

function getErrorCode(error) {
  if (typeof error !== 'string') return null;
  const match = error.match(/^\[([A-Z0-9_]+)\]\s*/);
  return match ? match[1] : null;
}

function getRuntimeProfile(platform = process.platform) {
  if (platform === 'win32' || platform === 'windows') {
    return {
      platform: 'win32',
      label: 'Windows',
      likelyShell: 'PowerShell',
    };
  }

  return {
    platform: platform || 'linux',
    label: platform === 'darwin' ? 'macOS/POSIX' : 'Linux/POSIX',
    likelyShell: 'POSIX shell',
  };
}

function findShellCommandKey(tool, args = null) {
  const properties = isPlainObject(tool?.function?.parameters?.properties)
    ? tool.function.parameters.properties
    : {};

  for (const key of SHELL_COMMAND_KEYS) {
    if (isPlainObject(args) && Object.prototype.hasOwnProperty.call(args, key)) {
      return key;
    }
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      return key;
    }
  }

  return null;
}

function isShellExecutionTool(tool) {
  const name = String(tool?.function?.name || '');
  const description = String(tool?.function?.description || '');
  const commandKey = findShellCommandKey(tool);

  if (!commandKey) return false;
  return SHELL_TOOL_NAME_RE.test(name) || /shell|terminal|command|powershell|bash|cmd/i.test(description);
}

function findClosingSingleQuote(value, startIndex = 1) {
  for (let i = startIndex; i < value.length; i += 1) {
    if (value[i] === "'") return i;
  }
  return -1;
}

function analyzeNodeEvalCommand(command) {
  const match = String(command).match(/(?:^|[;&|]\s*)node(?:\.exe)?\s+(?:-e|--eval)(?:\s+|=)([\s\S]*)/i);
  if (!match) return null;

  const payload = match[1].trim();
  if (!payload) {
    return {
      code: TOOL_ERROR_CODES.SHELL_NODE_EVAL_UNSAFE,
      message: 'node -e/--eval has no JavaScript payload.',
    };
  }

  if (!payload.startsWith("'")) {
    return {
      code: TOOL_ERROR_CODES.SHELL_NODE_EVAL_UNSAFE,
      message:
        'node -e/--eval must not use an unquoted or double-quoted payload. '
        + 'That form is unsafe across JSON, PowerShell, and POSIX shell parsing.',
    };
  }

  const closingIndex = findClosingSingleQuote(payload, 1);
  if (closingIndex < 0) {
    return {
      code: TOOL_ERROR_CODES.SHELL_NODE_EVAL_UNSAFE,
      message: 'node -e/--eval has an unterminated single-quoted payload.',
    };
  }

  const body = payload.slice(1, closingIndex);
  const trailing = payload.slice(closingIndex + 1).trim();

  if (trailing) {
    return {
      code: TOOL_ERROR_CODES.SHELL_NODE_EVAL_UNSAFE,
      message: 'node -e/--eval contains trailing shell text after its JavaScript payload.',
    };
  }

  if (body.length > MAX_INLINE_NODE_EVAL_CHARS || /[\r\n]/.test(body)) {
    return {
      code: TOOL_ERROR_CODES.SHELL_NODE_EVAL_UNSAFE,
      message:
        `node -e/--eval payload is too complex for a portable tool call (${body.length} characters). `
        + 'Write the JavaScript to a temporary .js file and execute that file instead.',
    };
  }

  return null;
}

function validateShellCommand(tool, args, options = {}) {
  if (!isShellExecutionTool(tool) || !isPlainObject(args)) return null;

  const commandKey = findShellCommandKey(tool, args);
  const command = commandKey ? args[commandKey] : null;
  if (typeof command !== 'string') return null;

  if (!command.trim()) {
    return {
      code: TOOL_ERROR_CODES.SHELL_COMMAND_INVALID,
      message: `${commandKey} must not be empty.`,
    };
  }

  if (command.includes('\u0000')) {
    return {
      code: TOOL_ERROR_CODES.SHELL_COMMAND_INVALID,
      message: `${commandKey} contains a NUL character.`,
    };
  }

  const nodeEvalIssue = analyzeNodeEvalCommand(command);
  if (nodeEvalIssue) {
    const runtime = getRuntimeProfile(options.platform);
    return {
      ...nodeEvalIssue,
      message: `${nodeEvalIssue.message} Runtime: ${runtime.label}; likely shell: ${runtime.likelyShell}.`,
    };
  }

  return null;
}


function isFileWriteTool(tool) {
  const name = String(tool?.function?.name || '');
  const description = String(tool?.function?.description || '');
  const properties = isPlainObject(tool?.function?.parameters?.properties)
    ? tool.function.parameters.properties
    : {};

  const hasPath = Object.prototype.hasOwnProperty.call(properties, 'path');
  const hasContent = Object.prototype.hasOwnProperty.call(properties, 'content');
  if (!hasPath || !hasContent) return false;

  return /(?:^|[_-])(write|create)(?:[_-](file|text))?$|^(write_file|create_file)$/i.test(name)
    || /write|create.+file/i.test(description);
}

function validateTestArtifact(tool, args) {
  if (!isFileWriteTool(tool) || !isPlainObject(args)) return null;

  const pathValue = typeof args.path === 'string' ? args.path : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!content) return null;

  const looksLikeTest = /(?:^|[\\/_.-])(test|tests|spec)(?:[\\/_.-]|$)/i.test(pathValue)
    || /All tests passed|PASS:|node:test|describe\s*\(|test\s*\(/i.test(content);

  if (looksLikeTest && /console\.assert\s*\(/.test(content)) {
    return {
      code: TOOL_ERROR_CODES.TEST_ASSERTION_UNSAFE,
      message:
        'Do not use console.assert() as a test gate. In Node.js it reports assertion failures '
        + 'without reliably making the process exit non-zero. Use node:test with node:assert/strict, '
        + 'or throw on failure and set a non-zero exit code.',
    };
  }

  if (
    looksLikeTest
    && /All tests passed!?/i.test(content)
    && !/(?:node:assert\/strict|require\(['"]assert['"]\)|throw\s+new\s+Error|process\.exitCode\s*=|process\.exit\s*\(\s*[1-9])/i.test(content)
  ) {
    return {
      code: TOOL_ERROR_CODES.TEST_RESULT_UNRELIABLE,
      message:
        'The test script prints a success claim without a reliable failing assertion path. '
        + 'Use node:test and node:assert/strict, then let the test runner control the exit code.',
    };
  }

  return null;
}

function validateToolSemantics(tool, args, options = {}) {
  return validateShellCommand(tool, args, options)
    || validateTestArtifact(tool, args, options)
    || null;
}

function formatShellExecutionPolicy(tools, options = {}) {
  if (!tools.some(isShellExecutionTool)) return '';

  const runtime = getRuntimeProfile(options.platform);
  return [
    '',
    'Shell execution rules:',
    `- API runtime platform: ${runtime.label}. Likely local shell: ${runtime.likelyShell}.`,
    '- Do not infer the actual shell only from a tool name such as bash_run. Trust the tool description and stderr.',
    '- Prefer direct, portable commands such as node <file>, npm test, npx <tool>, and git <subcommand>.',
    '- JSON escaping and shell escaping are separate layers. The tool arguments must first be valid JSON.',
    '- Never send node -e/--eval with a double-quoted or unquoted JavaScript payload.',
    '- A tiny portable inline Node check may use outer single quotes and double quotes inside JavaScript:',
    '  node -e \'require("./provider/terax"); console.log("OK")\'',
    '- For object literals, several statements, multiline code, or long checks, write a temporary .js file and run node <file>.',
    '- For Node.js tests, use node:test with node:assert/strict and run them with node --test <file>.',
    '- Never use console.assert() as the pass/fail gate. It may print a failure while the process still exits with code 0.',
    '- Never print All tests passed unconditionally. Print success only after throwing assertions have completed.',
    '- Do not use shell-specific heredocs when the same request may run on Windows and Linux.',
    '',
    'Tool-result rules:',
    '- Treat the structured tool result as authoritative.',
    '- exit_code === 0 and timed_out !== true means success.',
    '- A non-zero exit_code, timed_out === true, ParserError, SyntaxError, or non-empty fatal error means failure.',
    '- After failure, do not state that the test passed and do not push. Repair the command or code and rerun it.',
    '- Continue to push only after the required test returns exit_code 0.',
  ].join('\n');
}

function inspectToolResult(rawResult) {
  let result = rawResult;

  if (typeof result === 'string') {
    const direct = safeJsonParse(result);
    if (isPlainObject(direct)) {
      result = direct;
    } else {
      result = null;
      for (const candidate of findJsonObjects(rawResult)) {
        const parsed = safeJsonParse(candidate);
        if (isPlainObject(parsed)) {
          result = parsed;
          break;
        }
      }
    }

    if (!isPlainObject(result)) {
      return {
        ok: null,
        mustRetry: false,
        exitCode: null,
        timedOut: false,
        errorCode: null,
        error: null,
      };
    }
  }

  if (!isPlainObject(result)) {
    return {
      ok: null,
      mustRetry: false,
      exitCode: null,
      timedOut: false,
      errorCode: null,
      error: null,
    };
  }

  const rawExitCode = result.exit_code ?? result.exitCode ?? result.code;
  const hasExitCode = rawExitCode !== undefined && rawExitCode !== null && rawExitCode !== '';
  const exitCode = hasExitCode && Number.isFinite(Number(rawExitCode))
    ? Number(rawExitCode)
    : null;
  const timedOut = result.timed_out === true || result.timedOut === true;
  const stdout = sanitizeText(result.stdout || '', 4_000).trim();
  const stderr = sanitizeText(result.stderr || '', 4_000).trim();
  const explicitError = sanitizeText(result.error || result.message || '', 4_000).trim();
  const combinedOutput = [stdout, stderr, explicitError].filter(Boolean).join('\n');
  const fatalDiagnosticPattern = /(?:Assertion failed|ERR_ASSERTION|ParserError|SyntaxError|TypeError:.*is not a function)/i;
  const fatalTestOutputPattern = /(?:^|\n)\s*(?:not ok\b|FAILED TEST\b|Tests? failed\b)/i;
  const hasFatalOutput = fatalDiagnosticPattern.test([stderr, explicitError].filter(Boolean).join('\n'))
    || fatalTestOutputPattern.test(combinedOutput);

  if (timedOut) {
    return {
      ok: false,
      mustRetry: true,
      exitCode,
      timedOut: true,
      errorCode: TOOL_ERROR_CODES.TOOL_TIMEOUT,
      error: makeCodedError(TOOL_ERROR_CODES.TOOL_TIMEOUT, 'The tool timed out.'),
    };
  }

  if (exitCode !== null && exitCode !== 0) {
    const detail = stderr || explicitError;
    return {
      ok: false,
      mustRetry: true,
      exitCode,
      timedOut: false,
      errorCode: TOOL_ERROR_CODES.TOOL_EXIT_NONZERO,
      error: makeCodedError(
        TOOL_ERROR_CODES.TOOL_EXIT_NONZERO,
        `The tool failed with exit_code ${exitCode}${detail ? `: ${detail}` : '.'}`,
      ),
    };
  }

  if (exitCode === 0 && hasFatalOutput) {
    const detail = [stderr, explicitError, stdout]
      .filter(Boolean)
      .join('\n')
      .match(fatalDiagnosticPattern)?.[0]
      || combinedOutput.match(fatalTestOutputPattern)?.[0]?.trim()
      || 'failure marker';
    return {
      ok: false,
      mustRetry: true,
      exitCode: 0,
      timedOut: false,
      errorCode: TOOL_ERROR_CODES.TOOL_OUTPUT_FAILURE,
      error: makeCodedError(
        TOOL_ERROR_CODES.TOOL_OUTPUT_FAILURE,
        `The process returned exit_code 0 but its output contains a failure marker (${detail}). `
          + 'Treat the test as failed and rerun it with a test harness that exits non-zero on assertion failure.',
      ),
    };
  }

  if (result.ok === false || result.success === false || (exitCode === null && explicitError)) {
    return {
      ok: false,
      mustRetry: true,
      exitCode,
      timedOut: false,
      errorCode: TOOL_ERROR_CODES.TOOL_RESULT_ERROR,
      error: makeCodedError(
        TOOL_ERROR_CODES.TOOL_RESULT_ERROR,
        explicitError || stderr || 'The tool reported a failure.',
      ),
    };
  }

  if (exitCode === 0 || result.ok === true || result.success === true) {
    return {
      ok: true,
      mustRetry: false,
      exitCode: exitCode ?? 0,
      timedOut: false,
      errorCode: null,
      error: null,
    };
  }

  return {
    ok: null,
    mustRetry: false,
    exitCode,
    timedOut: false,
    errorCode: null,
    error: null,
  };
}


function contentToText(content) {
  if (typeof content === 'string') return content;
  if (isPlainObject(content)) return JSON.stringify(content);
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isPlainObject(part)) return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join('\n');
}

function inspectLatestToolResult(messages) {
  const list = asArray(messages);

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (!isPlainObject(message)) continue;
    if (message.role !== 'tool' && message.role !== 'function') continue;

    const inspection = inspectToolResult(contentToText(message.content));
    return {
      ...inspection,
      toolName: sanitizeText(message.name || '', 128) || null,
      toolCallId: sanitizeText(message.tool_call_id || '', 256) || null,
    };
  }

  return null;
}

function getLatestToolResultMessage(messages) {
  const list = asArray(messages);

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (!isPlainObject(message)) continue;
    if (message.role !== 'tool' && message.role !== 'function') continue;
    return message;
  }

  return null;
}

function normalizeEvidenceSymbol(value) {
  const text = String(value || '').trim();
  const match = text.match(/[A-Za-z_$][A-Za-z0-9_$.-]*/);
  return match ? match[0].replace(/[.:-]+$/, '') : null;
}

function extractVerifiedEvidence(messages) {
  const message = getLatestToolResultMessage(messages);
  if (!message) return null;

  const resultText = contentToText(message.content);
  const inspection = inspectToolResult(resultText);
  if (inspection.ok !== true) return null;

  const parsed = safeJsonParse(resultText);
  const stdout = isPlainObject(parsed) ? sanitizeText(parsed.stdout || '', MAX_TEXT_CHARS) : resultText;
  const combined = sanitizeText([stdout, isPlainObject(parsed) ? parsed.stderr || '' : ''].filter(Boolean).join('\n'));
  const symbols = new Set();

  const labeledPatterns = [
    /(?:^|\n)\s*(?:PASS|OK)\s*:\s*([^\n]+)/gi,
    /(?:^|\n)\s*([A-Za-z_$][A-Za-z0-9_$.-]*)\s*:\s*true\s*$/gim,
    /typeof\s+(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:===|==)\s*['\"]function['\"]/g,
  ];

  for (const pattern of labeledPatterns) {
    let match;
    while ((match = pattern.exec(combined)) !== null) {
      const symbol = normalizeEvidenceSymbol(match[1]);
      if (symbol && symbol.length <= 128) symbols.add(symbol);
    }
  }

  return {
    ok: true,
    exitCode: inspection.exitCode ?? 0,
    toolName: sanitizeText(message.name || '', 128) || null,
    toolCallId: sanitizeText(message.tool_call_id || '', 256) || null,
    symbols: [...symbols],
    output: combined,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inspectEvidenceContradiction(text, messages) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const evidence = extractVerifiedEvidence(messages);
  if (!evidence) return null;

  const normalized = text.toLowerCase();
  const safeContext = /(?:tidak boleh|jangan|cannot|can't|do not|don't)\s+(?:mengklaim|claim)[\s\S]{0,80}(?:belum ada|tidak ada|missing|not exist|not exported|undefined)/i;
  if (safeContext.test(text)) return null;

  const denial = '(?:belum\\s+ada|tidak\\s+ada|tidak\\s+ditemukan|belum\\s+diekspor|tidak\\s+diekspor|hilang|missing|does\\s+not\\s+exist|do\\s+not\\s+exist|not\\s+exported|undefined|is\\s+not\\s+a\\s+function)';
  const contradicted = [];

  for (const symbol of evidence.symbols) {
    const token = escapeRegExp(symbol);
    const around = new RegExp(`(?:${token}[\\s\\S]{0,120}${denial}|${denial}[\\s\\S]{0,120}${token})`, 'i');
    if (around.test(text)) contradicted.push(symbol);
  }

  const genericFunctionDenial = /(?:fungsi-fungsi|fungsi tersebut|fungsi itu|those functions|these functions)[\s\S]{0,80}(?:memang\s+)?(?:belum ada|tidak ada|missing|do not exist|not exported|undefined)/i;
  if (contradicted.length === 0 && evidence.symbols.length > 0 && genericFunctionDenial.test(text)) {
    contradicted.push(...evidence.symbols.slice(0, 8));
  }

  if (contradicted.length === 0) return null;

  return {
    code: TOOL_ERROR_CODES.EVIDENCE_CONTRADICTION,
    message:
      `The assistant contradicted a successful tool result for: ${contradicted.join(', ')}. `
      + 'A user challenge or correction is not new repository evidence. Read the file, search the repository, or run a failing test before reversing the conclusion.',
    symbols: contradicted,
    evidence,
  };
}

function formatFailedToolResultPolicy(messages) {
  const inspection = inspectLatestToolResult(messages);
  if (!inspection || inspection.ok !== false) return '';

  return [
    '',
    '--- TERAX PREVIOUS TOOL FAILURE ---',
    `The latest tool result failed: ${sanitizeText(inspection.error || 'unknown tool failure', 2_000)}`,
    'This failure is authoritative. Do not describe the failed command as successful.',
    'Do not push, publish, deploy, or continue a success-only workflow yet.',
    'Inspect stderr, correct the command or code, and call the appropriate tool again.',
    'A retry is successful only when exit_code is 0 and timed_out is not true.',
    'If the failure is a shell ParserError or SyntaxError, avoid complex node -e code and use a temporary .js file.',
    '--- END TERAX PREVIOUS TOOL FAILURE ---',
    '',
  ].join('\n');
}


function formatSuccessfulToolResultPolicy(messages) {
  const inspection = inspectLatestToolResult(messages);
  if (!inspection || inspection.ok !== true) return '';

  return [
    '',
    '--- TERAX VERIFIED TOOL EVIDENCE ---',
    `The latest tool completed successfully with exit_code ${inspection.exitCode ?? 0}.`,
    'Treat the actual tool result as evidence. Do not later invent a contradictory file or export state.',
    'A successful command proves only what that command directly checked. Do not broaden the claim beyond its assertions and output.',
    'If you suspect the result was incomplete or the repository changed, call read_file, search, or another test before changing the conclusion.',
    'Never claim that an exercised function is missing unless a later file read or failing test proves it.',
    '--- END TERAX VERIFIED TOOL EVIDENCE ---',
    '',
  ].join('\n');
}

function formatEvidenceDisciplinePolicy() {
  return [
    '',
    'Evidence discipline:',
    '- Before stating that a repository file, function, export, configuration, or test exists or is missing, obtain direct evidence from a current tool result.',
    '- Do not apologize by inventing a new repository state that contradicts a successful read or test.',
    '- A user saying that you hallucinated is not proof that the repository state changed. Verify first, then correct only what the new evidence disproves.',
    '- When evidence conflicts, state the conflict and run read_file, search, or a real test. Do not guess.',
    '- A test is credible only if assertion failure produces a non-zero process exit code.',
    '- For Node.js, prefer node --test with node:assert/strict. Do not use console.assert() for pass/fail.',
  ].join('\n');
}

function compactToolForPrompt(tool) {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

function formatToolDefinitions(rawTools, rawToolChoice, options = {}) {
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

  const shellPolicy = formatShellExecutionPolicy(tools, options);
  const failedToolResultPolicy = formatFailedToolResultPolicy(options.messages);
  const successfulToolResultPolicy = formatSuccessfulToolResultPolicy(options.messages);
  const evidenceDisciplinePolicy = formatEvidenceDisciplinePolicy();

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
    '8. Do not claim a file, function, export, or test state without direct tool evidence.',
    '9. Do not contradict a successful tool result unless a later tool result proves the earlier evidence stale or incomplete.',
    '10. When a tool call is needed, never emit it as Markdown, prose, XML, or a flat tool_call string.',
    '11. A user correction does not override successful tool evidence. Verify with a new tool call before reversing a repository claim.',
    '',
    `AVAILABLE_TOOLS=${definitions}`,
    shellPolicy,
    evidenceDisciplinePolicy,
    failedToolResultPolicy,
    successfulToolResultPolicy,
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

  if (typeof value.tool_call === 'string') {
    let args = value.arguments ?? value.input ?? {};
    let argumentError = null;

    if (typeof args === 'string') {
      const parsed = safeJsonParse(args);
      if (parsed === null) {
        argumentError = 'arguments is not valid JSON';
        args = null;
      } else {
        args = parsed;
      }
    }

    if (args !== null && !isPlainObject(args)) {
      argumentError = 'arguments must be a JSON object';
      args = null;
    }

    return {
      name: value.tool_call.trim(),
      arguments: args,
      argumentError,
      shapeError:
        'tool_call must be an object with name and arguments. '
        + 'The flat shape {"tool_call":"name","arguments":{...}} is invalid.',
      canonical: false,
    };
  }

  const wrappedCandidate = value.tool_call;
  const alternativeWrapper = value.tool || value.function_call || value.function;
  const hasDirectCallShape =
    typeof value.name === 'string'
    && (Object.prototype.hasOwnProperty.call(value, 'arguments')
      || Object.prototype.hasOwnProperty.call(value, 'input'));
  const candidate = wrappedCandidate || alternativeWrapper || (hasDirectCallShape ? value : null);
  if (!isPlainObject(candidate)) return null;

  const fn = isPlainObject(candidate.function) ? candidate.function : candidate;
  const name = fn.name || candidate.name || value.name;
  let args =
    fn.arguments
    ?? candidate.arguments
    ?? candidate.input
    ?? value.arguments
    ?? value.input
    ?? {};
  let argumentError = null;
  let shapeError = null;

  if (typeof name !== 'string' || !name.trim()) return null;

  if (typeof args === 'string') {
    const parsed = safeJsonParse(args);
    if (parsed === null) {
      argumentError = 'arguments is not valid JSON';
      args = null;
    } else {
      args = parsed;
      shapeError = 'arguments must be a JSON object in the model output, not a JSON-encoded string.';
    }
  }

  if (args !== null && !isPlainObject(args)) {
    argumentError = 'arguments must be a JSON object';
    args = null;
  }

  const topLevelKeys = Object.keys(value);
  const canonical =
    isPlainObject(value.tool_call)
    && topLevelKeys.length === 1
    && topLevelKeys[0] === 'tool_call'
    && !isPlainObject(value.tool_call.function)
    && typeof value.tool_call.name === 'string'
    && Object.prototype.hasOwnProperty.call(value.tool_call, 'arguments');

  if (!canonical && !shapeError) {
    shapeError =
      'Use exactly {"tool_call":{"name":"exact_tool_name","arguments":{...}}}. '
      + 'Direct name/arguments objects and alternative wrappers are not accepted for deepseek-terax.';
  }

  return {
    name: name.trim(),
    arguments: args,
    argumentError,
    shapeError,
    canonical,
  };
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
    return { found: false, candidate: null, source: null, envelopeError: null };
  }

  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    const balanced = extractBalancedJsonAt(trimmed, 0);
    if (balanced) {
      const parsed = safeJsonParse(balanced);
      const candidate = coerceToolCallObject(parsed);
      if (candidate) {
        const trailing = trimmed.slice(balanced.length).trim();
        return {
          found: true,
          candidate,
          source: 'json',
          envelopeError: trailing
            ? 'A tool call must be the only output. Remove all text after the JSON object.'
            : null,
        };
      }
    }
  }

  const xmlMatch = trimmed.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (xmlMatch) {
    const parsed = safeJsonParse(xmlMatch[1].trim());
    const candidate = coerceToolCallObject(parsed);
    if (candidate) {
      return {
        found: true,
        candidate,
        source: 'xml',
        envelopeError: 'XML tool-call wrappers are not accepted. Return one raw JSON object only.',
      };
    }
  }

  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const parsed = safeJsonParse(match[1].trim());
    const candidate = coerceToolCallObject(parsed);
    if (candidate) {
      return {
        found: true,
        candidate,
        source: 'fenced-json',
        envelopeError: 'Markdown code fences are not accepted for tool calls. Return one raw JSON object only.',
      };
    }
  }

  for (const raw of findJsonObjects(trimmed)) {
    const parsed = safeJsonParse(raw);
    const candidate = coerceToolCallObject(parsed);
    if (candidate) {
      return {
        found: true,
        candidate,
        source: 'embedded-json',
        envelopeError:
          'The tool-call JSON was embedded in prose or another wrapper. Return one raw JSON object and nothing else.',
      };
    }
  }

  const legacy = parseLegacyToolCall(trimmed);
  if (legacy) {
    return {
      found: true,
      candidate: { ...legacy, shapeError: null, canonical: false },
      source: 'legacy',
      envelopeError:
        'Legacy TOOL_CALL text is not accepted for deepseek-terax. Return one raw JSON object only.',
    };
  }

  const looksLikeToolCall =
    /<tool_call>|TOOL_CALL\s*:|"tool_call"\s*:|"function_call"\s*:|```(?:json)?/i.test(trimmed);

  return {
    found: looksLikeToolCall,
    candidate: null,
    source: null,
    envelopeError: looksLikeToolCall ? 'The model produced a malformed tool-call envelope.' : null,
  };
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

function inspectToolCall(text, rawTools, rawToolChoice, options = {}) {
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
    const contradiction = inspectEvidenceContradiction(text, options.messages);
    if (contradiction) {
      const error = makeCodedError(contradiction.code, contradiction.message);
      return {
        found: false,
        call: null,
        error,
        errorCode: contradiction.code,
        evidence: contradiction.evidence,
      };
    }

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

  const { name, arguments: args, argumentError, shapeError } = extracted.candidate;
  if (shapeError) {
    const error = makeCodedError(TOOL_ERROR_CODES.TOOL_CALL_SHAPE_INVALID, shapeError);
    return {
      found: true,
      call: null,
      error,
      errorCode: TOOL_ERROR_CODES.TOOL_CALL_SHAPE_INVALID,
    };
  }

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
    const shellError = isShellExecutionTool(tool)
      ? makeCodedError(
          TOOL_ERROR_CODES.SHELL_ARGUMENTS_INVALID_JSON,
          `${argumentError || 'Tool arguments must be a JSON object.'} `
            + 'For shell commands, nested quotes must be escaped as JSON before shell parsing.',
        )
      : argumentError || 'Tool arguments must be a JSON object.';

    return {
      found: true,
      call: null,
      error: shellError,
      errorCode: getErrorCode(shellError),
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

  const semanticIssue = validateToolSemantics(tool, args, options);
  if (semanticIssue) {
    const error = makeCodedError(semanticIssue.code, semanticIssue.message);
    return {
      found: true,
      call: null,
      error,
      errorCode: semanticIssue.code,
    };
  }

  if (extracted.envelopeError) {
    const error = makeCodedError(
      TOOL_ERROR_CODES.TOOL_CALL_ENVELOPE_INVALID,
      extracted.envelopeError,
    );
    return {
      found: true,
      call: null,
      error,
      errorCode: TOOL_ERROR_CODES.TOOL_CALL_ENVELOPE_INVALID,
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

function buildRepairInstruction(error, rawTools, rawToolChoice, options = {}) {
  const tools = normalizeTools(rawTools);
  const choice = normalizeToolChoice(rawToolChoice, tools);
  const errorCode = getErrorCode(error);
  const shellFailure = errorCode && errorCode.startsWith('TERAX_SHELL_');
  const testFailure = errorCode && errorCode.startsWith('TERAX_TEST_');
  const envelopeFailure = errorCode === TOOL_ERROR_CODES.TOOL_CALL_ENVELOPE_INVALID
    || errorCode === TOOL_ERROR_CODES.TOOL_CALL_SHAPE_INVALID;
  const evidenceFailure = errorCode === TOOL_ERROR_CODES.EVIDENCE_CONTRADICTION;
  const runtime = getRuntimeProfile(options.platform);

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

  const shellRepair = shellFailure
    ? [
        `Runtime is ${runtime.label}; likely shell is ${runtime.likelyShell}.`,
        'The shell command was rejected before execution because its quoting is not portable or its JSON is malformed.',
        'Do not retry a complex check with node -e/--eval.',
        'Write the JavaScript into a temporary .js file using an available file tool, then call the shell tool with node <temporary-file>.',
        'For a tiny inline check only, use outer single quotes and double quotes inside JavaScript:',
        'node -e \'require("./provider/terax"); console.log("OK")\'',
        'After execution, treat any non-zero exit_code or timed_out=true as failure. Do not push until exit_code is 0.',
      ]
    : [];

  const testRepair = testFailure
    ? [
        'The proposed test is not trustworthy because it can report success without a failing process exit code.',
        'Use node:test and node:assert/strict. Run it with node --test <file>.',
        'Do not use console.assert(). Do not print a final success line unconditionally.',
        'Before claiming an export exists or is missing, directly assert typeof module.exportName === "function".',
      ]
    : [];

  const envelopeRepair = envelopeFailure
    ? [
        'Do not use Markdown fences, prose, XML, legacy TOOL_CALL text, or a flat tool_call string.',
        'The only accepted shape is {"tool_call":{"name":"exact_tool_name","arguments":{...}}}.',
      ]
    : [];

  const verificationTools = tools
    .map((tool) => tool.function.name)
    .filter((name) => /read|search|grep|find|list|bash|shell|terminal|exec|command/i.test(name));

  const evidenceRepair = evidenceFailure
    ? [
        'The previous answer contradicted a successful tool result without new evidence.',
        'Do not agree with a user challenge automatically and do not invent a missing function or export.',
        verificationTools.length > 0
          ? `Verify the disputed repository state with exactly one of these available tools: ${JSON.stringify(verificationTools)}.`
          : 'No dedicated verification tool was identified. Keep the prior tool evidence and state uncertainty instead of reversing it.',
        'A valid reversal requires a later read/search result or a real test that exits non-zero.',
      ]
    : [];

  return [
    '[TERAX TOOL REPAIR]',
    `The previous tool-call output was rejected: ${sanitizeText(error || 'invalid tool call', 2_000)}`,
    expected,
    ...shellRepair,
    ...testRepair,
    ...envelopeRepair,
    ...evidenceRepair,
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
  validateShellCommand,
  validateTestArtifact,
  validateToolSemantics,
  inspectToolResult,
  inspectLatestToolResult,
  extractVerifiedEvidence,
  inspectEvidenceContradiction,
  formatFailedToolResultPolicy,
  formatSuccessfulToolResultPolicy,
  formatEvidenceDisciplinePolicy,
  formatShellExecutionPolicy,
  getRuntimeProfile,
  TOOL_ERROR_CODES,
};
