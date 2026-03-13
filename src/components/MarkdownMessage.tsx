'use client';

import { useEffect, useState } from 'react';

type MarkdownMessageProps = {
  content: string;
  className?: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineToHtml(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html;
}

function isTableHeader(line: string, next: string): boolean {
  if (!line.includes('|')) return false;
  return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(next);
}

function splitTableRow(line: string): string[] {
  const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return clean.split('|').map((cell) => cell.trim());
}

function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const res = await fetch('https://kroki.io/mermaid/svg', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: chart,
        });

        if (!res.ok) {
          throw new Error(`Render service failed (${res.status})`);
        }

        const svgText = await res.text();
        if (!cancelled) {
          setSvg(svgText);
          setError('');
        }
      } catch (err) {
        if (!cancelled) {
          setSvg('');
          setError(err instanceof Error ? err.message : 'Diagram render failed');
        }
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div className="markdown-mermaid-fallback">
        <div className="font-semibold">Diagram render error</div>
        <div>{error}</div>
        <pre>{chart}</pre>
      </div>
    );
  }

  if (!svg) return <div className="text-xs text-slate-500">Rendering diagram…</div>;

  return (
    <div
      className="markdown-mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
      aria-label="Rendered diagram"
    />
  );
}

export default function MarkdownMessage({
  content,
  className,
}: MarkdownMessageProps) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      i += 1;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const code = buf.join('\n');

      if (lang === 'mermaid') {
        blocks.push(<MermaidDiagram key={`mermaid-${blocks.length}`} chart={code} />);
      } else if (lang === 'svg') {
        blocks.push(
          <div
            key={`svg-${blocks.length}`}
            className="markdown-mermaid"
            dangerouslySetInnerHTML={{ __html: code }}
          />,
        );
      } else {
        blocks.push(
          <pre key={`code-${blocks.length}`}>
            <code>{code}</code>
          </pre>,
        );
      }
      continue;
    }

    if (
      i + 1 < lines.length &&
      isTableHeader(lines[i], lines[i + 1].trim()) &&
      splitTableRow(lines[i]).length > 1
    ) {
      const header = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={`table-${blocks.length}`} className="markdown-table-wrap">
          <table>
            <thead>
              <tr>
                {header.map((h, idx) => (
                  <th key={idx}>
                    <span dangerouslySetInnerHTML={{ __html: inlineToHtml(h) }} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ridx) => (
                <tr key={ridx}>
                  {header.map((_, cidx) => (
                    <td key={cidx}>
                      <span
                        dangerouslySetInnerHTML={{
                          __html: inlineToHtml(row[cidx] ?? ''),
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={`h-${blocks.length}`}>
          <span dangerouslySetInnerHTML={{ __html: inlineToHtml(text) }} />
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {items.map((item, idx) => (
            <li key={idx}>
              <span dangerouslySetInnerHTML={{ __html: inlineToHtml(item) }} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, '').trim());
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          {items.map((item, idx) => (
            <li key={idx}>
              <span dangerouslySetInnerHTML={{ __html: inlineToHtml(item) }} />
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const para: string[] = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(
        i + 1 < lines.length &&
        isTableHeader(lines[i], lines[i + 1].trim()) &&
        splitTableRow(lines[i]).length > 1
      )
    ) {
      para.push(lines[i].trim());
      i += 1;
    }

    blocks.push(
      <p key={`p-${blocks.length}`}>
        <span dangerouslySetInnerHTML={{ __html: inlineToHtml(para.join(' ')) }} />
      </p>,
    );
  }

  return <div className={className}>{blocks}</div>;
}
