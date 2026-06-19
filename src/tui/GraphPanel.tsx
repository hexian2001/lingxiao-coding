/**
 * GraphPanel — 黑板图可视化
 *
 * 展示 BlackboardGraph 的节点和边：
 *   - Origin (起点) / Goal (终点)
 *   - Fact (已确认事实) — 带置信度
 *   - Intent (待探索) — 带状态
 *   - Hint (提示)
 *   - Edges (关系)
 *
 * 快捷键:
 *   ↑/↓   导航节点
 *   Esc    关闭面板
 */

import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import { EmptyState, PanelFrame, SelectedLine } from './components/PanelFrame.js';
import { getGraphNodeVisual } from './design/visuals.js';
import { t } from '../i18n.js';

// ── Types ──

interface GraphNodeType {
  id: string;
  kind: 'fact' | 'intent' | 'hint' | 'origin' | 'goal';
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  supersededBy?: string;
  confidence?: string;
  intentStatus?: string;
  priority?: number;
}

interface GraphEdgeType {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  createdAt: number;
}

interface GraphPanelProps {
  nodes: GraphNodeType[];
  edges: GraphEdgeType[];
  width?: number;
  cursor?: number;
  enabled?: boolean;
}

// ── Constants ──

// 方寸词汇：置信度按「由淡至浓」填充分级（○→◐→◉），语义即墨色。
const CONFIDENCE_ICON: Record<string, string> = {
  confirmed: '◉',
  likely: '◐',
  tentative: '○',
};

// 意图状态同源：开放○ → 探索◐ → 解决◉；放弃为终端 ✕。
const INTENT_STATUS_ICON: Record<string, string> = {
  open: '○',
  exploring: '◐',
  resolved: '◉',
  abandoned: '✕',
};

const EDGE_ICON: Record<string, string> = {
  supports: '→',
  contradicts: '✕',
  depends_on: '→',
  produces: '⇒',
  consumes: '⇐',
  refines: '⇢',
  supersedes: '»',
};

// ── Helpers ──

// ── Component ──

export const GraphPanel: FunctionComponent<GraphPanelProps> = ({
  nodes,
  edges,
  width = 80,
  cursor = 0,
  enabled = true,
}) => {
  const maxW = Math.min(width - 4, 76);
  const innerW = maxW - 4;

  if (!enabled) {
    return (
      <PanelFrame title={t('tui.graph.title')} border width={width}>
        <EmptyState text={t('tui.graph.empty_disabled')} width={innerW} />
      </PanelFrame>
    );
  }

  if (nodes.length === 0) {
    return (
      <PanelFrame title={t('tui.graph.title')} border width={width}>
        <EmptyState text={t('tui.graph.empty')} width={innerW} />
      </PanelFrame>
    );
  }

  // Group nodes by kind
  const origin = nodes.find(n => n.kind === 'origin');
  const goal = nodes.find(n => n.kind === 'goal');
  const facts = nodes.filter(n => n.kind === 'fact' && !n.supersededBy);
  const intents = nodes.filter(n => n.kind === 'intent');
  const hints = nodes.filter(n => n.kind === 'hint');

  // Stats
  const openIntents = intents.filter(n => n.intentStatus === 'open').length;
  const confirmedFacts = facts.filter(n => n.confidence === 'confirmed').length;

  const lines: React.ReactNode[] = [];
  let selectableIdx = 0;

  const pushNodeLine = (key: string, node: GraphNodeType, text: string, color = getGraphNodeVisual(node.kind).color) => {
    const isSelected = selectableIdx === cursor;
    lines.push(
      <Box key={key}>
        <SelectedLine
          selected={isSelected}
          text={text}
          width={innerW}
          color={color}
          prefix={false}
        />
      </Box>,
    );
    selectableIdx++;
  };

  // Origin
  if (origin) {
    const visual = getGraphNodeVisual('origin');
    pushNodeLine('origin', origin, `[${visual.icon}] ${visual.label}: ${truncateDisplayText(origin.title, innerW - 14)}`, visual.color);
  }

  // Goal
  if (goal) {
    const visual = getGraphNodeVisual('goal');
    pushNodeLine('goal', goal, `[${visual.icon}] ${visual.label}: ${truncateDisplayText(goal.title, innerW - 12)}`, visual.color);
  }

  // Blank line
  lines.push(<Box key="blank1"><Text color={tuiTheme.semantic.text.secondary}> </Text></Box>);

  // Facts
  if (facts.length > 0) {
    const visual = getGraphNodeVisual('fact');
    lines.push(
      <Box key="facts-header">
        <Text color={visual.color}>{`[${visual.icon}] ${visual.label} (${facts.length})`}</Text>
      </Box>,
    );

    for (const fact of facts) {
      const icon = CONFIDENCE_ICON[fact.confidence || 'confirmed'] || '○';
      const label = `${icon} ${fact.id}: ${truncateDisplayText(fact.title, innerW - 14)}`;
      pushNodeLine(`fact-${fact.id}`, fact, `  ${label} [${fact.confidence || 'confirmed'}]`, tuiTheme.semantic.status.completed);
    }
  }

  // Intents
  if (intents.length > 0) {
    const visual = getGraphNodeVisual('intent');
    lines.push(
      <Box key="intents-header">
        <Text color={visual.color}>{`[${visual.icon}] ${visual.label} (${intents.length})`}</Text>
      </Box>,
    );

    for (const intent of intents) {
      const icon = INTENT_STATUS_ICON[intent.intentStatus || 'open'] || '○';
      const label = `${icon} ${intent.id}: ${truncateDisplayText(intent.title, innerW - 14)}`;
      pushNodeLine(`intent-${intent.id}`, intent, `  ${label} [${intent.intentStatus || 'open'}]`, visual.color);
    }
  }

  // Hints
  if (hints.length > 0) {
    const visual = getGraphNodeVisual('hint');
    lines.push(
      <Box key="hints-header">
        <Text color={visual.color}>{`[${visual.icon}] ${visual.label} (${hints.length})`}</Text>
      </Box>,
    );

    for (const hint of hints) {
      pushNodeLine(`hint-${hint.id}`, hint, `  ${hint.id}: ${truncateDisplayText(hint.title, innerW - 6)}`, visual.color);
    }
  }

  // Edges
  if (edges.length > 0) {
    lines.push(<Box key="blank2"><Text color={tuiTheme.semantic.text.secondary}> </Text></Box>);

    lines.push(
      <Box key="edges-header">
        <Text color={tuiTheme.semantic.panel.help}>{t('tui.graph.edges_header', edges.length)}</Text>
      </Box>,
    );

    const maxEdges = Math.min(edges.length, 10);
    for (let i = 0; i < maxEdges; i++) {
      const edge = edges[i];
      const icon = EDGE_ICON[edge.edgeType] || '→';
      const label = `${edge.fromNodeId} ${icon}[${edge.edgeType}]${icon} ${edge.toNodeId}`;
      lines.push(
        <Box key={`edge-${edge.id}`}>
          <Text color={tuiTheme.semantic.text.secondary}>
            {`  ${truncateDisplayText(label, innerW - 4)}`}
          </Text>
        </Box>
      );
    }
    if (edges.length > maxEdges) {
      lines.push(
        <Box key="edges-more">
          <Text color={tuiTheme.semantic.panel.help}>{t('tui.graph.more_edges', edges.length - maxEdges)}</Text>
        </Box>,
      );
    }
  }

  return (
    <PanelFrame
      title={t('tui.graph.title')}
      meta={t('tui.graph.meta', nodes.length, confirmedFacts, facts.length, openIntents, edges.length)}
      border
      width={width}
    >
      {lines}
    </PanelFrame>
  );
};

/**
 * 获取 GraphPanel 中可选中的项目列表（用于键盘导航）
 */
export function getGraphSelectableItems(
  nodes: GraphNodeType[],
): Array<{ id: string; kind: string; title: string }> {
  const items: Array<{ id: string; kind: string; title: string }> = [];
  const origin = nodes.find(n => n.kind === 'origin');
  const goal = nodes.find(n => n.kind === 'goal');
  if (origin) items.push({ id: origin.id, kind: 'origin', title: origin.title });
  if (goal) items.push({ id: goal.id, kind: 'goal', title: goal.title });
  // Skip blank line
  for (const n of nodes.filter(n => n.kind === 'fact' && !n.supersededBy)) {
    items.push({ id: n.id, kind: 'fact', title: n.title });
  }
  for (const n of nodes.filter(n => n.kind === 'intent')) {
    items.push({ id: n.id, kind: 'intent', title: n.title });
  }
  for (const n of nodes.filter(n => n.kind === 'hint')) {
    items.push({ id: n.id, kind: 'hint', title: n.title });
  }
  return items;
}
