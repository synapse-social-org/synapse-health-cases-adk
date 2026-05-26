// Pure helpers for parsing an Expert Research brief into a PDF-friendly tree.
// Kept outside HealthCasesClient.tsx so the heavy `@react-pdf/renderer` import
// can be lazy-loaded only when the user clicks "Download PDF".

export type BriefBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'numbered'; index: number; text: string };

export interface BriefSectionNode {
  id: string;
  title: string;
  blocks: BriefBlock[];
}

export interface ParsedBrief {
  sections: BriefSectionNode[];
  preamble: BriefBlock[];
}

interface SectionHeader {
  id: string;
  heading: string;
  title: string;
  // Legacy heading strings to fall back to when older briefs are loaded
  // (e.g. briefs saved before the Topics section bumped Feedback from 5 to 6).
  legacyHeadings?: readonly string[];
}

const SECTION_HEADERS: SectionHeader[] = [
  {
    id: 'experts',
    heading: '## 1. What Experts Are Saying',
    title: '1. What Experts Are Saying',
  },
  {
    id: 'papers',
    heading: '## 2. Relevant Research Papers',
    title: '2. Relevant Research Papers',
  },
  {
    id: 'researchers',
    heading: '## 3. Relevant Researchers',
    title: '3. Relevant Researchers',
  },
  { id: 'trials', heading: '## 4. Clinical Trials', title: '4. Clinical Trials' },
  {
    id: 'topics',
    heading: '## 5. Topics to Discuss With Your Specialist',
    title: '5. Topics to Discuss With Your Specialist',
  },
  {
    id: 'feedback',
    heading: '## 6. Feedback',
    title: '6. Feedback',
    legacyHeadings: ['## 5. Feedback'],
  },
];

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1$2')
    .replace(/(^|[^_])_(?!\s)([^_]+?)_/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .trim();
}

function parseBlocks(body: string): BriefBlock[] {
  const blocks: BriefBlock[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const text = stripInlineMarkdown(paragraphLines.join(' ').trim());
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraphLines = [];
  };

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*+•]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      const text = stripInlineMarkdown(bulletMatch[1]);
      if (text) blocks.push({ kind: 'bullet', text });
      continue;
    }

    const numberedMatch = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph();
      const text = stripInlineMarkdown(numberedMatch[2]);
      if (text)
        blocks.push({
          kind: 'numbered',
          index: Number(numberedMatch[1]),
          text,
        });
      continue;
    }

    // Skip leftover heading markers we already handled at the section level.
    if (/^#{1,6}\s/.test(line.trim())) {
      flushParagraph();
      const text = stripInlineMarkdown(line.replace(/^#{1,6}\s+/, ''));
      if (text) blocks.push({ kind: 'paragraph', text });
      continue;
    }

    paragraphLines.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

export function parseBrief(content: string): ParsedBrief {
  const normalized = content.replace(/\r\n/g, '\n');
  const result: ParsedBrief = { sections: [], preamble: [] };

  // Find each section's start; sections appear in order of SECTION_HEADERS.
  // For each header, try the canonical heading first, then any legacy
  // headings (used to keep rendering briefs saved before a section was
  // renumbered or renamed).
  const indices = SECTION_HEADERS.map((header) => {
    const candidates = [header.heading, ...(header.legacyHeadings ?? [])];
    let matchedHeading = header.heading;
    let start = -1;
    for (const candidate of candidates) {
      const found = normalized.indexOf(candidate);
      if (found !== -1) {
        matchedHeading = candidate;
        start = found;
        break;
      }
    }
    return { ...header, heading: matchedHeading, start };
  }).filter((entry) => entry.start !== -1);

  if (indices.length === 0) {
    // No structured headings — render everything as a single Brief section so
    // the PDF still has Synapse branding and a recognizable layout.
    result.sections.push({
      id: 'brief',
      title: 'Expert Research',
      blocks: parseBlocks(normalized),
    });
    return result;
  }

  // Preamble = anything before the first known heading.
  const firstStart = indices[0].start;
  if (firstStart > 0) {
    result.preamble = parseBlocks(normalized.slice(0, firstStart));
  }

  for (let i = 0; i < indices.length; i += 1) {
    const entry = indices[i];
    const next = indices[i + 1];
    const sectionStart = entry.start + entry.heading.length;
    const sectionEnd = next ? next.start : normalized.length;
    const body = normalized.slice(sectionStart, sectionEnd).trim();
    result.sections.push({
      id: entry.id,
      title: entry.title,
      blocks: parseBlocks(body),
    });
  }

  return result;
}

export function safeFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${slug || 'expert-research'}-${stamp}.pdf`;
}
