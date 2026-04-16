/**
 * Convert PlantUML (that was auto-generated from Mermaid) back to Mermaid syntax.
 *
 * Only handles diagrams containing the `' @source:mermaid` marker.
 * This is the reverse of mermaid-to-plantuml.ts.
 */

import { MERMAID_SOURCE_MARKER } from './mermaid-to-plantuml.js';

interface PumlNode {
  id: string;
  label: string;
  color: string | undefined;
  textColor: string | undefined;
}

interface PumlEdge {
  from: string;
  to: string;
  label: string;
  style: string;
}

const DIR_RE = /^(left to right|right to left|top to bottom) direction$/i;
const RECT_RE = /^rectangle\s+"([^"]+)"\s+as\s+(\S+)(?:\s+#([^;\s]+)(?:;text:(\S+))?)?$/;
const EDGE_RE =
  /^(\S+)\s+(--|-->|\.\.>|\.\.|==>|==|-\[hidden\]->|-\[hidden\]-)\s+(\S+)(?:\s*:\s*(.+))?$/;

export function plantumlToMermaid(pumlCode: string): string {
  if (!pumlCode.includes(MERMAID_SOURCE_MARKER)) return pumlCode;

  const lines = pumlCode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== MERMAID_SOURCE_MARKER && l !== '@startuml' && l !== '@enduml');

  const { direction, nodes, edges } = parseLines(lines);
  return formatMermaid(direction, nodes, edges);
}

function parseLines(lines: string[]): {
  direction: string;
  nodes: PumlNode[];
  edges: PumlEdge[];
} {
  let direction = 'TD';
  const nodes: PumlNode[] = [];
  const edges: PumlEdge[] = [];

  for (const line of lines) {
    const dirMatch = DIR_RE.exec(line);
    if (dirMatch) {
      direction = mapDirection(dirMatch[1] ?? '');
      continue;
    }

    const rectMatch = RECT_RE.exec(line);
    if (rectMatch) {
      nodes.push({
        id: rectMatch[2] ?? '',
        label: rectMatch[1] ?? '',
        color: rectMatch[3] ? `#${rectMatch[3]}` : undefined,
        textColor: rectMatch[4] ? `#${rectMatch[4]}` : undefined,
      });
      continue;
    }

    const edgeMatch = EDGE_RE.exec(line);
    if (edgeMatch) {
      edges.push({
        from: edgeMatch[1] ?? '',
        to: edgeMatch[3] ?? '',
        label: edgeMatch[4] ?? '',
        style: mapEdgeStyle(edgeMatch[2] ?? ''),
      });
    }
  }

  return { direction, nodes, edges };
}

function mapDirection(d: string): string {
  const lower = d.toLowerCase();
  if (lower === 'left to right') return 'LR';
  if (lower === 'right to left') return 'RL';
  return 'TD';
}

function mapEdgeStyle(arrow: string): string {
  if (arrow === '--') return '---';
  if (arrow === '..>' || arrow === '..') return arrow === '..' ? '-.-' : '-.->';
  if (arrow === '==>' || arrow === '==') return arrow === '==' ? '===' : '==>';
  if (arrow === '-[hidden]->' || arrow === '-[hidden]-') return '~~~';
  return '-->';
}

function formatMermaid(direction: string, nodes: PumlNode[], edges: PumlEdge[]): string {
  const out: string[] = [`graph ${direction}`];

  for (const node of nodes) {
    out.push(`    ${node.id}["${node.label}"]`);
  }

  for (const edge of edges) {
    const edgeLine = edge.label
      ? `    ${edge.from} ${edge.style}|${edge.label}| ${edge.to}`
      : `    ${edge.from} ${edge.style} ${edge.to}`;
    out.push(edgeLine);
  }

  for (const node of nodes) {
    if (node.color) {
      const parts = [`fill:${node.color}`];
      if (node.textColor) parts.push(`color:${node.textColor}`);
      out.push(`    style ${node.id} ${parts.join(',')}`);
    }
  }

  return out.join('\n');
}
