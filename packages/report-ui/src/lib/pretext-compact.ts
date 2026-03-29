import { layoutNextLine, prepareWithSegments } from '@chenglou/pretext';

const DEFAULT_FONT = '500 13px "Outfit"';
const DEFAULT_LINE_HEIGHT = 18;
const MINIMUM_WIDTH = 40;

type LayoutCursor = {
  segmentIndex: number;
  graphemeIndex: number;
};

interface CompactTextOptions {
  maxWidth: number;
  maxLines?: number;
  font?: string;
}

const preparedCache = new Map<string, unknown>();

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function supportsCanvasMeasurement(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const canvas = document.createElement('canvas');
  return Boolean(canvas.getContext('2d'));
}

function fallbackCompactText(text: string, maxWidth: number, maxLines: number): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return '';
  }
  const approximateCharactersPerLine = Math.max(10, Math.floor(maxWidth / 7));
  const maxCharacters = approximateCharactersPerLine * Math.max(1, maxLines);
  if (normalized.length <= maxCharacters) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxCharacters - 3)).trimEnd()}...`;
}

function withEllipsis(text: string): string {
  const base = text.replace(/[.\s]+$/g, '').trimEnd();
  return `${base || text.trimEnd()}...`;
}

function getPreparedText(text: string, font: string): unknown {
  const key = `${font}\n${text}`;
  const cached = preparedCache.get(key);
  if (cached) {
    return cached;
  }
  const prepared = prepareWithSegments(text, font);
  preparedCache.set(key, prepared as unknown);
  if (preparedCache.size > 400) {
    const firstKey = preparedCache.keys().next().value;
    if (typeof firstKey === 'string') {
      preparedCache.delete(firstKey);
    }
  }
  return prepared as unknown;
}

export function compactTextWithPretext(text: string, options: CompactTextOptions): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return '';
  }

  const maxLines = Math.max(1, options.maxLines ?? 2);
  const maxWidth = Math.max(MINIMUM_WIDTH, Math.floor(options.maxWidth));
  const font = options.font ?? DEFAULT_FONT;

  if (!supportsCanvasMeasurement()) {
    return fallbackCompactText(normalized, maxWidth, maxLines);
  }

  try {
    const prepared = getPreparedText(normalized, font);
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
    const lines: string[] = [];

    for (let index = 0; index < maxLines; index += 1) {
      const line = layoutNextLine(prepared as Parameters<typeof layoutNextLine>[0], cursor, maxWidth);
      if (!line) {
        break;
      }
      lines.push(line.text.trimEnd());
      cursor = line.end;
    }

    if (lines.length === 0) {
      return normalized;
    }

    const remainder = layoutNextLine(prepared as Parameters<typeof layoutNextLine>[0], cursor, maxWidth);
    if (remainder) {
      const lastIndex = lines.length - 1;
      lines[lastIndex] = withEllipsis(lines[lastIndex]);
    }

    return lines.join(' ');
  } catch {
    return fallbackCompactText(normalized, maxWidth, maxLines);
  }
}

export function compactSummaryText(text: string, maxWidth: number): string {
  return compactTextWithPretext(text, {
    maxWidth,
    maxLines: 2,
    font: DEFAULT_FONT,
  });
}

export function compactSummaryLineHeight(): number {
  return DEFAULT_LINE_HEIGHT;
}
