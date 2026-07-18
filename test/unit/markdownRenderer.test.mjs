import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../../src/webview/conversation/markdown.ts';

class FakeNode {
  constructor(kind, tagName = '') {
    this.kind = kind;
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.href = '';
    this.target = '';
    this.rel = '';
    this.value = '';
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.kind === 'fragment') this.children.push(...node.children);
      else this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  set textContent(value) {
    this.children = value ? [new FakeText(value)] : [];
  }

  get textContent() {
    return this.children.map((child) => child.textContent).join('');
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super('text');
    this.value = value;
  }

  set textContent(value) {
    this.value = value;
  }

  get textContent() {
    return this.value;
  }
}

class FakeDocument {
  createDocumentFragment() {
    return new FakeNode('fragment');
  }

  createElement(tagName) {
    return new FakeNode('element', tagName);
  }

  createTextNode(value) {
    return new FakeText(value);
  }
}

test('renders supported Markdown as explicit DOM nodes', () => {
  const target = render([
    '# Heading',
    '',
    '**bold** and *emphasis* with `inline`',
    '',
    '- first',
    '- second',
    '',
    '```ts',
    'const value = "<safe>";',
    '```',
    '',
    '[OpenAI](https://openai.com/docs?q=codex&lang=en)'
  ].join('\n'));
  const html = serialize(target);

  assert.match(html, /<h1>Heading<\/h1>/u);
  assert.match(html, /<strong>bold<\/strong>/u);
  assert.match(html, /<em>emphasis<\/em>/u);
  assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/u);
  assert.match(html, /<code class="language-ts">const value = &quot;&lt;safe&gt;&quot;;<\/code>/u);
  assert.match(html, /href="https:\/\/openai\.com\/docs\?q=codex&amp;lang=en"/u);
  assert.match(html, /target="_blank"/u);
  assert.match(html, /rel="noreferrer noopener"/u);
});

test('keeps HTML executable text inert and rejects unsafe link protocols', () => {
  const target = render([
    '<img src=x onerror="globalThis.compromised=true">',
    '[script](javascript:alert(1))',
    '[mixed case](JaVaScRiPt:alert(2))',
    '[data](data:text/html,<script>alert(3)</script>)',
    '[relative](/trusted-looking-path)',
    '',
    '```html',
    '<script>alert(4)</script>',
    '```'
  ].join('\n'));
  const html = serialize(target);

  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.equal(html.includes('href="data:'), false);
  assert.equal(html.includes('href="/trusted-looking-path"'), false);
  assert.equal(html.includes('<a '), false);
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.compromised=true&quot;&gt;/u);
  assert.match(html, /&lt;script&gt;alert\(4\)&lt;\/script&gt;/u);
  assert.match(html, /script\)/u);
  assert.match(html, /relative<\/p>/u);
});

function render(source) {
  globalThis.document = new FakeDocument();
  const target = document.createElement('div');
  renderMarkdown(target, source);
  return target;
}

function serialize(node) {
  if (node.kind === 'text') return escapeText(node.value);
  const children = node.children.map(serialize).join('');
  if (node.kind === 'fragment') return children;
  const attributes = [
    node.className ? ['class', node.className] : null,
    node.href ? ['href', node.href] : null,
    node.target ? ['target', node.target] : null,
    node.rel ? ['rel', node.rel] : null
  ].filter(Boolean).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  return `<${node.tagName}${attributes}>${children}</${node.tagName}>`;
}

function escapeText(value) {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function escapeAttribute(value) {
  return escapeText(value).replace(/'/gu, '&#39;');
}
