import { describe, expect, it } from 'vitest';

import {
  decodeHtmlEntities, looksLikeHtml, markdownToPlainText, toJobMarkdown,
} from '../markdown.js';
import { descriptionFingerprint } from '../taxonomy.js';

/** Converting twice must equal converting once: feed listings are normalized twice. */
function convert(value: string): string {
  const once = toJobMarkdown(value);
  expect(toJobMarkdown(once)).toBe(once);
  return once;
}

describe('HTML to the job Markdown contract', () => {
  it('turns headings, paragraphs and lists into Markdown', () => {
    expect(convert('<h3>About</h3><p>We build <strong>maps</strong>.</p><ul><li>Ship</li><li>Learn <em>fast</em></li></ul>'))
      .toBe('### About\n\nWe build **maps**.\n\n- Ship\n- Learn _fast_');
  });

  it('numbers ordered lists from their start attribute', () => {
    expect(convert('<ol><li>One</li><li>Two</li></ol><ol start="4"><li>Four</li></ol>'))
      .toBe('1. One\n2. Two\n\n4. Four');
  });

  it('nests lists, including items wrapped in paragraphs and lists placed directly in lists', () => {
    expect(convert('<ul><li><p>Parent</p><ul><li>Child</li></ul></li><li>Next</li></ul>'))
      .toBe('- Parent\n  - Child\n- Next');
    expect(convert('<ol><li>Step</li><ul><li>Detail</li></ul></ol>'))
      .toBe('1. Step\n   - Detail');
    expect(convert('<ul><li><p>First</p><p>Second</p></li></ul>'))
      .toBe('- First\\\n  Second');
  });

  it('keeps line breaks and splits paragraphs on a double break', () => {
    expect(convert('<p>Line one<br>Line two<br/><br />Next paragraph</p>'))
      .toBe('Line one\\\nLine two\n\nNext paragraph');
  });

  it('keeps absolute http(s) links and drops every other target but keeps its text', () => {
    expect(convert('<p><a href="https://acme.example/apply?x=1">Apply</a> or <a href="javascript:alert(1)">click</a>'
      + ' or <a href="data:text/html,hi">data</a> or <a href="/relative">relative</a></p>'))
      .toBe('[Apply](https://acme.example/apply?x=1) or click or data or relative');
    expect(convert('<a href="https://acme.example/a_(b) c">x</a>')).toBe('[x](https://acme.example/a_%28b%29%20c)');
  });

  it('decodes named and numeric entities', () => {
    expect(convert('<p>Caf&eacute; &mdash; we&#8217;re &#x1F680; R&amp;D &nbsp;team</p>'))
      .toBe('Café — we’re 🚀 R&D team');
  });

  it('removes script, style and iframe contents entirely', () => {
    const output = convert('<p>Hello</p><script>alert("x")</script><style>p{color:red}</style><iframe src="https://evil.example">frame</iframe><p>World</p>');
    expect(output).toBe('Hello\n\nWorld');
  });

  it('never lets raw HTML survive, even when the source escaped it as text', () => {
    const output = convert('<p>Use &lt;script&gt;alert(1)&lt;/script&gt; and 5 &lt; 6</p><div onclick="x()">Unknown <blink>tags</blink> keep text</div>');
    expect(output).not.toMatch(/(?<!\\)<[a-zA-Z/]/);
    expect(markdownToPlainText(output)).toBe('Use <script>alert(1)</script> and 5 < 6\n\nUnknown tags keep text');
  });

  it('escapes text that would otherwise read as Markdown syntax', () => {
    const output = convert('<p># not a heading</p><p>- not a list</p><p>2026. A year</p><p>*stars* and [brackets] and snake_case</p>');
    expect(output).toBe('\\# not a heading\n\n\\- not a list\n\n2026\\. A year\n\n\\*stars\\* and \\[brackets\\] and snake_case');
    expect(markdownToPlainText(output)).toBe('# not a heading\n\n- not a list\n\n2026. A year\n\n*stars* and [brackets] and snake_case');
  });

  it('moves whitespace outside emphasis so it still renders', () => {
    expect(convert('<p><strong>Location: </strong>Remote</p>')).toBe('**Location:** Remote');
  });

  it('repairs mojibake before converting', () => {
    expect(convert('<p>At ExtraHop, weâre hiring</p>')).toBe('At ExtraHop, we’re hiring');
  });
});

describe('plain text and Markdown pass through', () => {
  it('preserves line structure and normalizes whitespace', () => {
    expect(convert('Intro line\r\nSecond line   \r\n\r\n\r\n\r\nNext')).toBe('Intro line\nSecond line\n\nNext');
  });

  it('keeps Markdown exactly as written', () => {
    const body = '## Role\n\nYou will:\n\n- Build **things**\n- Read [docs](https://acme.example/docs)\n\n1. First\n2. Second';
    expect(convert(body)).toBe(body);
  });

  it('turns bullet glyphs into list items and a two-space break into a hard break', () => {
    expect(convert('• One\n• Two')).toBe('- One\n- Two');
    expect(convert('Line  \nNext')).toBe('Line\\\nNext');
  });

  it('escapes markup-like text that is not a known HTML tag', () => {
    expect(looksLikeHtml('Work at <company>')).toBe(false);
    expect(convert('Work at <company> on <https://acme.example>')).toBe('Work at \\<company> on <https://acme.example>');
  });

  it('does not mistake HTML shown inside code for markup', () => {
    expect(looksLikeHtml('Know `<div>` well')).toBe(false);
    expect(looksLikeHtml('<p>Real</p>')).toBe(true);
  });
});

describe('markdownToPlainText', () => {
  it('removes Markdown syntax and link targets', () => {
    expect(markdownToPlainText('### About\n\n- **Bold** and _em_ and [link](https://acme.example)\n1. Item\\\n   more'))
      .toBe('About\n\nBold and em and link\nItem\nmore');
  });

  it('keeps intraword underscores and decodes entities', () => {
    expect(markdownToPlainText('snake_case &amp; R&amp;D')).toBe('snake_case & R&D');
  });

  it('is empty for nothing', () => {
    expect(markdownToPlainText(undefined)).toBe('');
  });

  it('decodes entities without touching unknown ones', () => {
    expect(decodeHtmlEntities('&eacute; &#233; &#xE9; &notreal;')).toBe('é é é &notreal;');
  });
});

describe('fingerprint stability across formats', () => {
  const sentences = 'You will design and operate the systems that keep our maps fresh for millions of people every day. ';

  it('fingerprints the same content identically whether it arrived as HTML, Markdown or plain text', () => {
    const html = `<h3>About the role</h3><p>${sentences.repeat(2)}</p><ul><li>Own the <strong>ingestion</strong> pipeline</li><li>Mentor <a href="https://acme.example/team">the team</a></li></ul>`;
    const markdown = `### About the role\n\n${sentences.repeat(2).trim()}\n\n- Own the **ingestion** pipeline\n- Mentor [the team](https://acme.example/team)`;
    const plain = `About the role\n${sentences.repeat(2)}\nOwn the ingestion pipeline\nMentor the team`;
    const fingerprint = descriptionFingerprint(toJobMarkdown(html));
    expect(fingerprint).toBeDefined();
    expect(descriptionFingerprint(toJobMarkdown(markdown))).toBe(fingerprint);
    expect(descriptionFingerprint(toJobMarkdown(plain))).toBe(fingerprint);
  });

  it('still separates edited descriptions', () => {
    const base = `<p>${sentences.repeat(3)}</p>`;
    expect(descriptionFingerprint(toJobMarkdown(base)))
      .not.toBe(descriptionFingerprint(toJobMarkdown(`${base}<p>Relocation offered.</p>`)));
  });
});
