import { describe, expect, it } from 'vitest';
import {
  mermaidToPlantUml,
  isMermaidConvertedPlantUml,
  MERMAID_SOURCE_MARKER,
} from './mermaid-to-plantuml.js';
import { plantumlToMermaid } from './plantuml-to-mermaid.js';
import { markdownToNoteJson } from './md-to-note.js';
import { jsonBytesToMarkdown } from './json-to-md.js';

// ── helpers ──────────────────────────────────────────

function fullRoundtrip(md: string): string {
  const json = markdownToNoteJson(md);
  const buf = new TextEncoder().encode(json);
  return jsonBytesToMarkdown(buf);
}

// ── mermaidToPlantUml ────────────────────────────────

describe('mermaidToPlantUml — flowchart basics', () => {
  it('converts graph LR with styled nodes and undirected edge', () => {
    const mermaid = `graph LR
    A["🏠 生活 ×1"] --- B["🔧 工具 ×2"]
    style A fill:#2d6a4f,color:#fff,stroke:#1b4332
    style B fill:#1d3557,color:#fff,stroke:#0d1b2a`;

    const result = mermaidToPlantUml(mermaid);
    expect(result).toContain(MERMAID_SOURCE_MARKER);
    expect(result).toContain('@startuml');
    expect(result).toContain('@enduml');
    expect(result).toContain('left to right direction');
    expect(result).toContain('rectangle "🏠 生活 ×1" as A');
    expect(result).toContain('rectangle "🔧 工具 ×2" as B');
    expect(result).toContain('A -- B');
    expect(result).not.toContain('A --> B');
  });

  it('converts directed edge --> correctly', () => {
    const result = mermaidToPlantUml('graph TD\n    A["Start"] --> B["End"]');
    expect(result).toContain('top to bottom direction');
    expect(result).toContain('A --> B');
    expect(result).not.toMatch(/A -- B/);
  });

  it('converts flowchart keyword same as graph', () => {
    const result = mermaidToPlantUml('flowchart LR\n    X --> Y');
    expect(result).toContain('left to right direction');
    expect(result).toContain('X --> Y');
  });

  it('handles RL direction', () => {
    const result = mermaidToPlantUml('graph RL\n    A --> B');
    expect(result).toContain('right to left direction');
  });

  it('handles BT direction (no PlantUML equivalent)', () => {
    const result = mermaidToPlantUml('graph BT\n    A --> B');
    expect(result).not.toContain('direction');
    expect(result).toContain('@startuml');
  });

  it('handles nodes with no edges', () => {
    const result = mermaidToPlantUml('graph LR\n    A["Alone"]');
    expect(result).toContain('rectangle "Alone" as A');
    expect(result).not.toContain('-->');
    expect(result).not.toContain('--');
  });
});

describe('mermaidToPlantUml — edge styles', () => {
  it('dashed directed edge -.-> becomes ..>', () => {
    const result = mermaidToPlantUml('graph LR\n    A -.-> B');
    expect(result).toContain('A ..> B');
  });

  it('thick directed edge ==> stays ==>', () => {
    const result = mermaidToPlantUml('graph LR\n    A ==> B');
    expect(result).toContain('A ==> B');
  });

  it('invisible edge ~~~ becomes -[hidden]-', () => {
    const result = mermaidToPlantUml('graph LR\n    A ~~~ B');
    expect(result).toContain('A -[hidden]- B');
  });

  it('labeled directed edge', () => {
    const result = mermaidToPlantUml('graph LR\n    A -- yes --> B');
    expect(result).toContain(': yes');
    expect(result).toContain('A --> B');
  });
});

describe('mermaidToPlantUml — complex graph', () => {
  it('handles multiple nodes and edges', () => {
    const mermaid = `graph TD
    A["Start"] --> B["Process"]
    B --> C["Decision"]
    C --> D["End"]
    C --> A`;

    const result = mermaidToPlantUml(mermaid);
    expect(result).toContain('rectangle "Start" as A');
    expect(result).toContain('rectangle "Process" as B');
    expect(result).toContain('rectangle "Decision" as C');
    expect(result).toContain('rectangle "End" as D');
    expect(result).toContain('A --> B');
    expect(result).toContain('B --> C');
    expect(result).toContain('C --> D');
    expect(result).toContain('C --> A');
  });

  it('node label defined on first occurrence, reused later', () => {
    const mermaid = `graph LR
    A["First"] --> B["Second"]
    B --> A`;

    const result = mermaidToPlantUml(mermaid);
    const rectangleMatches = result.match(/rectangle/g) ?? [];
    expect(rectangleMatches).toHaveLength(2);
  });

  it('skips mermaid comments (%%)', () => {
    const mermaid = `graph LR
    %% this is a comment
    A --> B`;
    const result = mermaidToPlantUml(mermaid);
    expect(result).not.toContain('%%');
    expect(result).toContain('A --> B');
  });
});

describe('mermaidToPlantUml — sequence diagram', () => {
  it('converts basic sequence', () => {
    const mermaid = `sequenceDiagram
    Alice ->> Bob: Hello
    Bob -->> Alice: Hi back`;

    const result = mermaidToPlantUml(mermaid);
    expect(result).toContain(MERMAID_SOURCE_MARKER);
    expect(result).toContain('@startuml');
    expect(result).toContain('Alice ->> Bob : Hello');
    expect(result).toContain('Bob -->> Alice : Hi back');
    expect(result).toContain('@enduml');
  });

  it('preserves participant declarations', () => {
    const result = mermaidToPlantUml(
      'sequenceDiagram\n    participant Alice\n    Alice ->> Bob: Hi',
    );
    expect(result).toContain('participant Alice');
  });
});

describe('mermaidToPlantUml — unsupported & edge cases', () => {
  it('returns original for unsupported diagram type (gantt)', () => {
    const gantt = 'gantt\n    title Project\n    section A\n    Task1 :a1, 2024-01-01, 30d';
    expect(mermaidToPlantUml(gantt)).toBe(gantt);
  });

  it('returns original for empty input', () => {
    expect(mermaidToPlantUml('')).toBe('');
  });

  it('always includes marker', () => {
    expect(isMermaidConvertedPlantUml(mermaidToPlantUml('graph LR\n    A --> B'))).toBe(true);
  });
});

// ── isMermaidConvertedPlantUml ───────────────────────

describe('isMermaidConvertedPlantUml', () => {
  it('returns true when marker present', () => {
    expect(isMermaidConvertedPlantUml(`${MERMAID_SOURCE_MARKER}\n@startuml\n@enduml`)).toBe(true);
  });

  it('returns false for plain plantuml', () => {
    expect(isMermaidConvertedPlantUml('@startuml\nA -> B\n@enduml')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isMermaidConvertedPlantUml('')).toBe(false);
  });
});

// ── plantumlToMermaid ────────────────────────────────

describe('plantumlToMermaid — reverse conversion', () => {
  it('converts LR flowchart with colors back to mermaid', () => {
    const puml = `' @source:mermaid
@startuml
left to right direction
rectangle "🏠 生活 ×1" as A #2d6a4f;text:fff
rectangle "🔧 工具 ×2" as B #1d3557;text:0d1b2a
A -- B
@enduml`;

    const result = plantumlToMermaid(puml);
    expect(result).toContain('graph LR');
    expect(result).toContain('A["🏠 生活 ×1"]');
    expect(result).toContain('B["🔧 工具 ×2"]');
    expect(result).toContain('A --- B');
  });

  it('converts directed edge back', () => {
    const puml = `' @source:mermaid
@startuml
top to bottom direction
rectangle "A" as A
rectangle "B" as B
A --> B
@enduml`;

    const result = plantumlToMermaid(puml);
    expect(result).toContain('graph TD');
    expect(result).toContain('A --> B');
  });

  it('converts dashed edge back', () => {
    const puml = `' @source:mermaid
@startuml
rectangle "A" as A
rectangle "B" as B
A ..> B
@enduml`;

    const result = plantumlToMermaid(puml);
    expect(result).toContain('A -.-> B');
  });

  it('converts labeled edge back', () => {
    const puml = `' @source:mermaid
@startuml
rectangle "A" as A
rectangle "B" as B
A --> B : yes
@enduml`;

    const result = plantumlToMermaid(puml);
    expect(result).toContain('A -->|yes| B');
  });

  it('handles nodes without colors', () => {
    const puml = `' @source:mermaid
@startuml
rectangle "Hello" as X
@enduml`;

    const result = plantumlToMermaid(puml);
    expect(result).toContain('X["Hello"]');
    expect(result).not.toContain('style X');
  });

  it('returns original if no marker', () => {
    const puml = '@startuml\nA -> B\n@enduml';
    expect(plantumlToMermaid(puml)).toBe(puml);
  });

  it('restores styles with fill and color', () => {
    const puml = `' @source:mermaid
@startuml
rectangle "Node" as N #ff0000;text:ffffff
@enduml`;

    const result = plantumlToMermaid(puml);
    expect(result).toContain('style N fill:#ff0000,color:#ffffff');
  });
});

// ── mermaid → plantuml → mermaid roundtrip ───────────

describe('mermaid ↔ plantuml roundtrip', () => {
  it('preserves node labels and undirected edges', () => {
    const original = `graph LR
    A["🏠 生活 ×1"] --- B["🔧 工具 ×2"]`;

    const puml = mermaidToPlantUml(original);
    expect(isMermaidConvertedPlantUml(puml)).toBe(true);

    const back = plantumlToMermaid(puml);
    expect(back).toContain('graph LR');
    expect(back).toContain('A["🏠 生活 ×1"]');
    expect(back).toContain('B["🔧 工具 ×2"]');
    expect(back).toContain('A --- B');
  });

  it('preserves directed edges', () => {
    const original = 'graph TD\n    A["X"] --> B["Y"]';
    const back = plantumlToMermaid(mermaidToPlantUml(original));
    expect(back).toContain('A --> B');
  });

  it('preserves direction', () => {
    for (const dir of ['LR', 'RL', 'TD']) {
      const original = `graph ${dir}\n    A --> B`;
      const back = plantumlToMermaid(mermaidToPlantUml(original));
      expect(back).toContain(`graph ${dir}`);
    }
  });

  it('preserves multiple edges', () => {
    const original = `graph TD
    A["1"] --> B["2"]
    B --> C["3"]
    C --> A`;

    const back = plantumlToMermaid(mermaidToPlantUml(original));
    expect(back).toContain('A --> B');
    expect(back).toContain('B --> C');
    expect(back).toContain('C --> A');
  });
});

// ── end-to-end: md → noteJSON → md ──────────────────

describe('end-to-end: md with mermaid → note JSON → md', () => {
  it('mermaid block survives full md→JSON→md pipeline', () => {
    const md = `# Title

\`\`\`mermaid
graph LR
    A["Start"] --> B["End"]
\`\`\`

Some text after`;

    const result = fullRoundtrip(md);
    expect(result).toContain('# Title');
    expect(result).toContain('```mermaid');
    expect(result).toContain('graph LR');
    expect(result).toContain('A["Start"]');
    expect(result).toContain('B["End"]');
    expect(result).toContain('Some text after');
  });

  it('mermaid block coexists with normal code block', () => {
    const md = `\`\`\`python
print("hello")
\`\`\`

\`\`\`mermaid
graph TD
    A --> B
\`\`\``;

    const result = fullRoundtrip(md);
    expect(result).toContain('```python');
    expect(result).toContain('print("hello")');
    expect(result).toContain('```mermaid');
    expect(result).toContain('graph TD');
  });

  it('plantuml block roundtrips without conversion', () => {
    const md = `\`\`\`plantuml
@startuml
Alice -> Bob: Hello
@enduml
\`\`\``;

    const result = fullRoundtrip(md);
    expect(result).toContain('```plantuml');
    expect(result).toContain('Alice -> Bob: Hello');
  });

  it('the real diary mermaid block from 2026-04-05', () => {
    const md = `## 领域分布

\`\`\`mermaid
graph LR
    A["🏠 生活 ×1"] --- B["🔧 工具 ×2"]
    style A fill:#2d6a4f,color:#fff,stroke:#1b4332
    style B fill:#1d3557,color:#fff,stroke:#0d1b2a
\`\`\`

## 本周进度`;

    const result = fullRoundtrip(md);
    expect(result).toContain('## 领域分布');
    expect(result).toContain('```mermaid');
    expect(result).toContain('graph LR');
    expect(result).toContain('A["🏠 生活 ×1"]');
    expect(result).toContain('B["🔧 工具 ×2"]');
    expect(result).toContain('## 本周进度');
    expect(result).not.toContain('@startuml');
  });
});
