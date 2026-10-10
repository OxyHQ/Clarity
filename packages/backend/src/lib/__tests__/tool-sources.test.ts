import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/chat-repository.js', () => ({}));

import { carryOverToolInvocations } from '../conversation-saver.js';
import { compactToolResult, createToolSourceCollector } from '../tool-sources.js';

describe('compactToolResult', () => {
  it('keeps only links, bounded, and drops non-web URLs', () => {
    expect(
      compactToolResult({
        results: [
          { url: 'https://example.com/a', title: 'A', snippet: 'x'.repeat(1000), raw: 'dropped' },
          { url: 'javascript:alert(1)', title: 'bad' },
          { title: 'no url' },
        ],
      }),
    ).toEqual({
      results: [{ url: 'https://example.com/a', title: 'A', snippet: `${'x'.repeat(300)}…` }],
    });
  });

  it('keeps a read page as a link with a short excerpt, and research sources with their ids', () => {
    expect(
      compactToolResult({
        action: 'read',
        url: 'https://example.com/p',
        title: 'P',
        content: 'y'.repeat(5000),
      }),
    ).toEqual({
      action: 'read',
      url: 'https://example.com/p',
      title: 'P',
      content: `${'y'.repeat(200)}…`,
    });
    expect(
      compactToolResult({
        report: 'long',
        sources: [{ id: 3, url: 'https://r.example/x', title: 'R' }],
      }),
    ).toEqual({ sources: [{ id: 3, url: 'https://r.example/x', title: 'R' }] });
  });

  it('keeps nothing for a result without links', () => {
    expect(compactToolResult({ answer: 42 })).toBeNull();
    expect(compactToolResult('text')).toBeNull();
  });
});

describe('createToolSourceCollector', () => {
  it('pairs streamed tool calls with their results, from both stream shapes', () => {
    const collector = createToolSourceCollector();
    collector.observe('', {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: 'c1',
                function: { name: 'webSearch', arguments: '{"query":"faircoin","limit":5}' },
              },
            ],
          },
        },
      ],
    });
    collector.observe('alia.tool_result', {
      tool_call_id: 'c1',
      name: 'webSearch',
      output: { results: [{ url: 'https://example.com/a', title: 'A' }] },
    });
    collector.observe('', {
      choices: [
        {
          delta: { tool_result: { tool_call_id: 'c2', name: 'calculator', output: { value: 4 } } },
        },
      ],
    });
    collector.observe('', {
      choices: [
        {
          delta: {
            tool_result: {
              tool_call_id: 'c3',
              name: 'browse',
              output: { action: 'read', url: 'https://example.com/b' },
            },
          },
        },
      ],
    });

    expect(collector.invocations()).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'webSearch',
        state: 'result',
        args: { query: 'faircoin' },
        result: { results: [{ url: 'https://example.com/a', title: 'A' }] },
      },
      {
        toolCallId: 'c3',
        toolName: 'browse',
        state: 'result',
        result: { action: 'read', url: 'https://example.com/b' },
      },
    ]);
  });
});

describe('carryOverToolInvocations', () => {
  const links = [
    { toolCallId: 'c1', toolName: 'webSearch', state: 'result', result: { results: [] } },
  ];

  it('keeps stored links on a resent, unchanged answer', () => {
    const history = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: 'answer' },
    ];
    const stored = [
      { role: 'user', content: 'q', toolInvocations: [] },
      { role: 'assistant', content: 'answer', toolInvocations: links },
    ];
    expect(carryOverToolInvocations(history, stored)[1].toolInvocations).toBe(links);
  });

  it('keeps nothing once the history no longer matches', () => {
    const history = [
      { role: 'user' as const, content: 'edited q' },
      { role: 'assistant' as const, content: 'other' },
    ];
    const stored = [
      { role: 'user', content: 'q', toolInvocations: [] },
      { role: 'assistant', content: 'answer', toolInvocations: links },
    ];
    expect(carryOverToolInvocations(history, stored)[1].toolInvocations).toBeUndefined();
  });
});
