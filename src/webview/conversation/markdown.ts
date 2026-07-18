const INLINE_TOKEN = /(`[^`\n]+`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/u;

export function renderMarkdown(target: HTMLElement, source: string): void {
  if (target.dataset.markdownSource === source) {
    return;
  }
  target.dataset.markdownSource = source;
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```([^`]*)$/u.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const language = fence[1]?.trim();
      if (language && /^[\w+-]+$/u.test(language)) code.className = `language-${language}`;
      code.textContent = codeLines.join('\n');
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1]?.length ?? 1}`);
      appendInline(element, heading[2] ?? '');
      fragment.append(element);
      index += 1;
      continue;
    }

    if (/^>\s?/u.test(line)) {
      const quote = document.createElement('blockquote');
      const values: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index] ?? '')) {
        values.push((lines[index] ?? '').replace(/^>\s?/u, ''));
        index += 1;
      }
      appendInline(quote, values.join('\n'));
      fragment.append(quote);
      continue;
    }

    const listMatch = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u.exec(line);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const itemMatch = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u.exec(lines[index] ?? '');
        if (!itemMatch || Boolean(itemMatch[2]) !== ordered) break;
        const item = document.createElement('li');
        appendInline(item, itemMatch[3] ?? '');
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && isParagraphContinuation(lines[index] ?? '')) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    const paragraph = document.createElement('p');
    appendInline(paragraph, paragraphLines.join('\n'));
    fragment.append(paragraph);
  }

  target.replaceChildren(fragment);
}

function isParagraphContinuation(line: string): boolean {
  return Boolean(
    line.trim() &&
    !/^```/u.test(line) &&
    !/^(#{1,6})\s+/u.test(line) &&
    !/^>\s?/u.test(line) &&
    !/^\s*(?:[-+*]|\d+\.)\s+/u.test(line)
  );
}

function appendInline(parent: HTMLElement, value: string): void {
  let remaining = value;
  while (remaining) {
    const match = INLINE_TOKEN.exec(remaining);
    if (!match || match.index === undefined) {
      appendText(parent, remaining);
      return;
    }
    appendText(parent, remaining.slice(0, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const url = safeLink(match[3]);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        appendInline(link, match[2]);
        parent.append(link);
      } else {
        appendText(parent, match[2]);
      }
    } else {
      const strong = match[4] ?? match[5];
      const emphasis = match[6] ?? match[7];
      const element = document.createElement(strong !== undefined ? 'strong' : 'em');
      appendInline(element, strong ?? emphasis ?? '');
      parent.append(element);
    }
    remaining = remaining.slice(match.index + token.length);
  }
}

function appendText(parent: HTMLElement, value: string): void {
  const parts = value.split('\n');
  parts.forEach((part, index) => {
    if (index > 0) parent.append(document.createElement('br'));
    if (part) parent.append(document.createTextNode(part));
  });
}

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
