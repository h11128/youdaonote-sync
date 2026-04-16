/** Convert Mermaid (flowchart/sequence/pie) to PlantUML with roundtrip marker. */

export const MERMAID_SOURCE_MARKER = "' @source:mermaid";

export function mermaidToPlantUml(mermaidCode: string): string {
  const lines = mermaidCode.trim().split('\n');
  if (!lines.length) return mermaidCode;

  const firstLine = (lines[0] ?? '').trim().toLowerCase();

  if (firstLine.startsWith('graph') || firstLine.startsWith('flowchart')) {
    return convertFlowchart(lines);
  }
  if (firstLine.startsWith('sequencediagram')) {
    return convertSequence(lines);
  }
  if (firstLine.startsWith('pie')) {
    return convertPie(lines);
  }

  return mermaidCode;
}

export function isMermaidConvertedPlantUml(plantumlCode: string): boolean {
  return plantumlCode.includes(MERMAID_SOURCE_MARKER);
}

const DIRECTION_MAP: Record<string, string> = {
  lr: 'left to right direction',
  rl: 'right to left direction',
  td: 'top to bottom direction',
  tb: 'top to bottom direction',
  bt: '',
};

type NodeShape = 'rect' | 'round' | 'diamond' | 'circle' | 'default';

interface FlowNode {
  id: string;
  label: string;
  shape: NodeShape;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  lineStyle: 'solid' | 'dashed' | 'thick' | 'invisible';
  directed: boolean;
}

interface FlowStyle {
  nodeId: string;
  props: Record<string, string>;
}

function detectShape(rect?: string, round?: string, diamond?: string, circle?: string): NodeShape {
  if (rect) return 'rect';
  if (round) return 'round';
  if (diamond) return 'diamond';
  if (circle) return 'circle';
  return 'default';
}

function firstDefined(...values: (string | undefined)[]): string {
  for (const v of values) {
    if (v) return v;
  }
  return '';
}

const STYLE_RE = /^style\s+(\S+)\s+(.+)$/i;
const NODE_ONLY_RE = /^(\S+?)(?:\["([^"]+)"\]|\("([^"]+)"\)|\{"([^"]+)"\}|\(\("([^"]+)"\)\))$/;
const EDGE_RE =
  /^(\S+?)(?:\["([^"]+)"\]|\("([^"]+)"\)|\{"([^"]+)"\}|\(\("([^"]+)"\)\))?\s*(---|-->|-.->|==>|~~~|--\s+[^-].*?-->|--\s+[^-].*?---)\s*(\S+?)(?:\["([^"]+)"\]|\("([^"]+)"\)|\{"([^"]+)"\}|\(\("([^"]+)"\)\))?$/;
const LABELED_ARROW_RE = /^--\s+(.+?)-->$|^--\s+(.+?)---$/;

function parseStyleLine(line: string): FlowStyle | null {
  const m = STYLE_RE.exec(line);
  if (!m) return null;
  const props: Record<string, string> = {};
  for (const part of (m[2] ?? '').split(',')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (k && v) props[k] = v;
  }
  return { nodeId: m[1] ?? '', props };
}

function parseNodeOnlyLine(line: string, nodes: Map<string, FlowNode>): boolean {
  const m = NODE_ONLY_RE.exec(line);
  if (!m) return false;
  const id = m[1] ?? '';
  const label = firstDefined(m[2], m[3], m[4], m[5]);
  const shape = detectShape(m[2], m[3], m[4], m[5]);
  registerNode(nodes, id, label, shape);
  return true;
}

function parseEdgeLine(line: string, nodes: Map<string, FlowNode>, edges: FlowEdge[]): boolean {
  const m = EDGE_RE.exec(line);
  if (!m) return false;

  const fromId = m[1] ?? '';
  const fromLabel = firstDefined(m[2], m[3], m[4], m[5]);
  const fromShape = detectShape(m[2], m[3], m[4], m[5]);
  const arrow = (m[6] ?? '').trim();
  const toId = m[7] ?? '';
  const toLabel = firstDefined(m[8], m[9], m[10], m[11]);
  const toShape = detectShape(m[8], m[9], m[10], m[11]);

  registerNode(nodes, fromId, fromLabel, fromShape);
  registerNode(nodes, toId, toLabel, toShape);

  const directed = arrow.includes('>');
  const lineStyle = classifyLineStyle(arrow);
  const edgeLabel = extractEdgeLabel(arrow);

  edges.push({ from: fromId, to: toId, label: edgeLabel, lineStyle, directed });
  return true;
}

function classifyLineStyle(arrow: string): FlowEdge['lineStyle'] {
  if (arrow.includes('-.')) return 'dashed';
  if (arrow.startsWith('==')) return 'thick';
  if (arrow.startsWith('~~~')) return 'invisible';
  return 'solid';
}

function extractEdgeLabel(arrow: string): string {
  const m = LABELED_ARROW_RE.exec(arrow);
  return firstDefined(m?.[1], m?.[2]);
}

function convertFlowchart(lines: string[]): string {
  const firstLine = (lines[0] ?? '').trim();
  const dirMatch = /^(?:graph|flowchart)\s+(LR|RL|TD|TB|BT)/i.exec(firstLine);
  const dir = (dirMatch?.[1] ?? 'td').toLowerCase();

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const styles: FlowStyle[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line || line.startsWith('%%')) continue;

    const style = parseStyleLine(line);
    if (style) {
      styles.push(style);
      continue;
    }
    if (parseEdgeLine(line, nodes, edges)) continue;
    parseNodeOnlyLine(line, nodes);
  }

  return buildFlowchartOutput(dir, nodes, edges, styles);
}

function buildFlowchartOutput(
  dir: string,
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
  styles: FlowStyle[],
): string {
  const out: string[] = [MERMAID_SOURCE_MARKER, '@startuml'];
  const dirLine = DIRECTION_MAP[dir];
  if (dirLine) out.push(dirLine);

  const colorMap = buildColorMap(styles);
  for (const [, node] of nodes) {
    const color = colorMap.get(node.id);
    const skinLine = color
      ? `rectangle "${node.label}" as ${node.id} ${color}`
      : `rectangle "${node.label}" as ${node.id}`;
    out.push(skinLine);
  }

  for (const edge of edges) {
    const arrow = resolveArrow(edge);
    const arrowLine = `${edge.from} ${arrow} ${edge.to}`;
    out.push(edge.label ? `${arrowLine} : ${edge.label}` : arrowLine);
  }

  out.push('@enduml');
  return out.join('\n');
}

function resolveArrow(edge: FlowEdge): string {
  if (edge.directed) {
    if (edge.lineStyle === 'dashed') return '..>';
    if (edge.lineStyle === 'thick') return '==>';
    if (edge.lineStyle === 'invisible') return '-[hidden]->';
    return '-->';
  }
  if (edge.lineStyle === 'dashed') return '..';
  if (edge.lineStyle === 'thick') return '==';
  if (edge.lineStyle === 'invisible') return '-[hidden]-';
  return '--';
}

function registerNode(
  nodes: Map<string, FlowNode>,
  id: string,
  label: string,
  shape: NodeShape,
): void {
  const existing = nodes.get(id);
  if (!existing) {
    nodes.set(id, { id, label: label || id, shape });
  } else if (label && !existing.label) {
    existing.label = label;
    existing.shape = shape;
  }
}

function buildColorMap(styles: FlowStyle[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of styles) {
    const fill = s.props.fill;
    const fontColor = s.props.color;
    if (fill) {
      map.set(s.nodeId, `#${stripHash(fill)}` + (fontColor ? `;text:${stripHash(fontColor)}` : ''));
    }
  }
  return map;
}

function stripHash(color: string): string {
  return color.startsWith('#') ? color.slice(1) : color;
}

const SEQ_MSG_RE = /^(\S+)\s*(->>|-->>|->>-|->|-->)\s*(\S+)\s*:\s*(.+)$/;
const SEQ_NOTE_RE = /^note\s+(left|right)\s+of\s+(\S+)\s*:\s*(.+)$/i;

function convertSequence(lines: string[]): string {
  const out: string[] = [MERMAID_SOURCE_MARKER, '@startuml'];
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line || line.startsWith('%%')) continue;

    const msgMatch = SEQ_MSG_RE.exec(line);
    if (msgMatch) {
      const pumlArrow = mapSeqArrow(msgMatch[2] ?? '');
      out.push(`${msgMatch[1]} ${pumlArrow} ${msgMatch[3]} : ${msgMatch[4]}`);
      continue;
    }

    if (/^participant\s+/i.test(line) || /^actor\s+/i.test(line)) {
      out.push(line);
      continue;
    }

    const noteMatch = SEQ_NOTE_RE.exec(line);
    if (noteMatch) {
      out.push(`note ${noteMatch[1]} of ${noteMatch[2]} : ${noteMatch[3]}`);
    }
  }
  out.push('@enduml');
  return out.join('\n');
}

function mapSeqArrow(mermaidArrow: string): string {
  if (mermaidArrow === '->>') return '->>';
  if (mermaidArrow === '-->>') return '-->>';
  if (mermaidArrow === '-->') return '-->';
  return '->';
}

function convertPie(lines: string[]): string {
  const out: string[] = [MERMAID_SOURCE_MARKER, '@startuml'];
  out.push('!include <C4/C4_Context>');

  const slices: { label: string; value: number }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    const sliceMatch = /^"([^"]+)"\s*:\s*([\d.]+)$/.exec(line);
    if (sliceMatch) {
      slices.push({ label: sliceMatch[1] ?? '', value: parseFloat(sliceMatch[2] ?? '0') });
    }
  }

  if (slices.length) {
    out.push('@startjson');
    out.push(JSON.stringify(Object.fromEntries(slices.map((s) => [s.label, s.value])), null, 2));
    out.push('@endjson');
  }

  out.push('@enduml');
  return out.join('\n');
}
