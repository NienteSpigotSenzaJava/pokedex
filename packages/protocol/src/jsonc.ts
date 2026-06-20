export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

export function stripJsonc(text: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  // walk once so comments are replaced with spaces without disturbing line numbers in parse errors.
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';

    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      } else output += ' ';
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        blockComment = false;
      } else output += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }

    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      lineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      blockComment = true;
      continue;
    }

    output += char;
  }

  return removeTrailingCommas(output);
}

function removeTrailingCommas(text: string): string {
  let output = '';
  let quote = '';
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';

    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }

    if (char === ',') {
      let nextIndex = index + 1;
      while (/\s/.test(text[nextIndex] ?? '')) nextIndex += 1;
      if (['}', ']'].includes(text[nextIndex] ?? '')) continue;
    }

    output += char;
  }

  return output;
}
