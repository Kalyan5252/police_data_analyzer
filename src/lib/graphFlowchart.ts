import { GraphPayload } from '@/lib/graphPayload';

function escapeMermaidText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function safeNodeId(index: number): string {
  return `n${index}`;
}

export function graphToMermaidFlowchart(graph: GraphPayload): string {
  const lines: string[] = ['flowchart LR'];
  const idToNodeAlias = new Map<string, string>();

  graph.nodes.forEach((node, idx) => {
    const alias = safeNodeId(idx);
    idToNodeAlias.set(node.id, alias);
    lines.push(`  ${alias}["${escapeMermaidText(node.title)}"]`);
  });

  graph.edges.forEach((edge) => {
    const from = idToNodeAlias.get(edge.from);
    const to = idToNodeAlias.get(edge.to);
    if (!from || !to) return;
    const label = escapeMermaidText(edge.type || 'RELATED_TO');
    lines.push(`  ${from} -->|"${label}"| ${to}`);
  });

  return lines.join('\n');
}
