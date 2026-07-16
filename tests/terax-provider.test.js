'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const terax = require('../provider/terax');

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}];

test('accepts only the strict Terax wrapper', () => {
  const parsed = terax.parseToolCall('{"tool_call":{"name":"read_file","arguments":{"path":"src/app.js","offset":0}}}', tools);
  assert.deepEqual(parsed, {
    toolCall: { name: 'read_file', arguments: '{"path":"src/app.js","offset":0}' },
    error: null,
  });
});

test('normal text is not mistaken for a tool call', () => {
  assert.deepEqual(terax.parseToolCall('The file is already correct.', tools), { toolCall: null, error: null });
});

test('rejects legacy, XML, fenced, alternate, and prose-wrapped calls', () => {
  const invalidCalls = [
    'TOOL_CALL: read_file\narguments: {"path":"a.js"}',
    '<tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</tool_call>',
    '```json\n{"tool_call":{"name":"read_file","arguments":{"path":"a.js"}}}\n```',
    '{"name":"read_file","arguments":{"path":"a.js"}}',
    'Calling now: {"tool_call":{"name":"read_file","arguments":{"path":"a.js"}}}',
  ];
  for (const value of invalidCalls) {
    assert.ok(terax.parseToolCall(value, tools).error, value);
  }
});

test('rejects unknown tools and schema-invalid arguments', () => {
  assert.equal(
    terax.parseToolCall('{"tool_call":{"name":"write_file","arguments":{"path":"a.js"}}}', tools).error.code,
    'unknown_terax_tool',
  );
  assert.equal(
    terax.parseToolCall('{"tool_call":{"name":"read_file","arguments":{"offset":-1,"extra":true}}}', tools).error.code,
    'invalid_terax_arguments',
  );
});

test('prompt names only runtime-provided tools and forbids alternate formats', () => {
  const prompt = terax.formatToolDefinitions(tools);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /Never emit XML/);
  assert.doesNotMatch(prompt, /write_file/);
});
