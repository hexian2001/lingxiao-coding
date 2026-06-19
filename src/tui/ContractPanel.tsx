import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { PanelFrame } from './components/PanelFrame.js';
import { STATUS_ICON } from './design/iconography.js';
import { loadProjectContractEntries } from '../core/ProjectContracts.js';
import type { ContractPackEntry } from '../core/ContractPack.js';

/**
 * 契约 TUI 面板(只读浏览)。直接从项目级 .lingxiao/contracts/ 加载(loadProjectContractEntries),
 * 跨会话复用、契约变更即 persist 到项目级,故面板基本实时。无编辑/创建入口——改契约走正规流程
 * (leader 派 architect / 改源码),避免人类误改 allowedScope 锁死 agent。
 *
 * TODO(版本 diff):同 surface 的历史版本需读黑板 supersede 链(DB graph_nodes),当前面板只展示
 * active 最新版;diff 留待接入历史版本快照后补。
 */
function provenanceMark(entry: ContractPackEntry): { icon: string; color: string; label: string } {
  if (entry.provenance === 'audit') return { icon: STATUS_ICON.cancelled, color: 'yellow', label: '审计' };
  return { icon: STATUS_ICON.completed, color: 'green', label: '声明' }; // declared(含 architect 产出)
}

export function ContractPanel({ width, workspace }: { width?: number; workspace?: string }): React.ReactElement {
  const [entries] = useState<ContractPackEntry[]>(() => loadProjectContractEntries(workspace));
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (!key) return;
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelected((i) => Math.min(Math.max(entries.length - 1, 0), i + 1));
  });

  if (entries.length === 0) {
    return (
      <PanelFrame title="契约" meta="无" help="Esc 关闭" width={width}>
        <Text color="gray">尚未加载项目级契约(.lingxiao/contracts/)。</Text>
        <Text color="gray">architect 产出契约或契约 audit 生成后,会在此显示(跨会话复用)。</Text>
      </PanelFrame>
    );
  }

  const safeSelected = Math.min(selected, entries.length - 1);
  const sel = entries[safeSelected];
  const declaredCount = entries.filter((e) => e.provenance !== 'audit').length;
  const auditCount = entries.length - declaredCount;
  const meta = `${entries.length} 契约 · 声明 ${declaredCount} · 审计 ${auditCount}`;
  const contentPreview = sel.content.length > 240 ? `${sel.content.slice(0, 240)}…(更多见文件)` : sel.content;

  return (
    <PanelFrame title="契约" meta={meta} help="↑↓ 选择 · Esc 关闭" width={width}>
      <Box flexDirection="column">
        {entries.map((entry, i) => {
          const mark = provenanceMark(entry);
          const isSel = i === safeSelected;
          return (
            <Box key={entry.surface} flexDirection="row">
              <Text color={mark.color}>{isSel ? '▸' : ' '} {mark.icon} </Text>
              <Text color={isSel ? 'cyan' : undefined} bold={isSel}>{entry.surface}</Text>
              {entry.version !== undefined && <Text color="gray"> @v{entry.version}</Text>}
              <Text color="gray"> {entry.sha256.slice(0, 8)}</Text>
              <Text color={mark.color}> {mark.label}</Text>
            </Box>
          );
        })}
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">{'─'.repeat(40)}</Text>
          <Text bold>{sel.title}</Text>
          <Text color="gray">sha256={sel.sha256} · 来源={sel.provenance ?? 'declared'} · by={sel.createdBy ?? '(unknown)'}</Text>
          {sel.allowedScope && (
            <Text color="gray">
              allow: {sel.allowedScope.allow.join(', ') || '(空)'} | forbid: {(sel.allowedScope.forbid ?? []).join(', ') || '(无)'} | allowCreate: {String(sel.allowedScope.allowCreate ?? false)}
            </Text>
          )}
          {sel.evidenceRefs && sel.evidenceRefs.length > 0 && (
            <Text color="gray">evidence: {sel.evidenceRefs.join(' | ')}</Text>
          )}
          <Text color="gray">{'─'.repeat(40)}</Text>
          <Text>{contentPreview}</Text>
        </Box>
      </Box>
    </PanelFrame>
  );
}
