/**
 * SettingsPanel — 交互式配置面板
 *
 * 展示当前运行时配置分组，支持：
 *   - ↑/↓ 导航选中行（由外部 cursor 控制）
 *   - Enter 激活编辑（boolean 直接 toggle，其他进入内联输入）
 *   - 鼠标点击行 → 选中 + 编辑
 *   - 编辑模式下 Enter 保存 / Esc 取消
 */
import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { PanelFrame } from './components/PanelFrame.js';
import { t } from '../i18n.js';
import { config } from '../config.js';

// ── Types ──

export interface SettingsEntry {
  /** 显示用标签 */
  label: string;
  /** config 路径 (用于 setConfigValue) */
  path: string;
  /** 值类型 */
  type: 'string' | 'number' | 'boolean' | 'enum';
  /** enum 可选值 */
  enumValues?: string[];
}

export interface SettingsGroupDef {
  title: string;
  entries: SettingsEntry[];
}

export interface SettingsEditState {
  editing: boolean;
  editText: string;
  editCursor: number;
}

/** Transient feedback message shown after save operations. */
export interface SettingsFeedback {
  text: string;
  type: 'success' | 'error';
}

export const EMPTY_SETTINGS_EDIT: SettingsEditState = {
  editing: false,
  editText: '',
  editCursor: 0,
};

// ── Config Definitions ──

export function getSettingsGroupDefs(): SettingsGroupDef[] {
  return [
    {
      title: t('tui.settings.group.llm'),
      entries: [
        { label: 'provider', path: 'llm.provider', type: 'enum', enumValues: ['openai', 'anthropic', 'auto'] },
        { label: 'leader_model', path: 'llm.leader_model', type: 'string' },
        { label: 'agent_model', path: 'llm.agent_model', type: 'string' },
        { label: 'streaming', path: 'llm.enable_streaming', type: 'boolean' },
        { label: 'max_retries', path: 'llm.max_retries', type: 'number' },
      ],
    },
    {
      title: t('tui.settings.group.agents'),
      entries: [
        { label: 'max_concurrent', path: 'agents.max_concurrent', type: 'number' },
        { label: 'max_iterations', path: 'agents.max_iterations', type: 'number' },
        { label: 'max_runtime_min', path: 'agents.max_runtime_minutes', type: 'number' },
      ],
    },
    {
      title: t('tui.settings.group.security'),
      entries: [
        { label: 'permission_mode', path: 'security.permission_mode', type: 'enum', enumValues: ['yolo', 'networked', 'dev', 'strict'] },
        { label: 'hardened_mode', path: 'security.hardened_mode', type: 'boolean' },
        { label: 'sandbox_auto', path: 'security.auto_allow_bash_if_sandboxed', type: 'boolean' },
        { label: 'cmd_guard', path: 'security.dangerous_command_guard', type: 'boolean' },
      ],
    },
    {
      title: t('tui.settings.group.ui'),
      entries: [
        { label: 'language', path: 'ui.language', type: 'enum', enumValues: ['zh', 'en'] },
        { label: 'suggestions', path: 'ui.prompt_suggestion_enabled', type: 'boolean' },
      ],
    },
  ];
}

/** Flatten all settings entries into an ordered list for cursor indexing. */
export function getFlatSettingsEntries(): SettingsEntry[] {
  return getSettingsGroupDefs().flatMap(g => g.entries);
}

/** Total number of selectable settings rows. */
export function getSettingsItemCount(): number {
  return getFlatSettingsEntries().length;
}

/**
 * Given a click row offset within the settings panel content area,
 * return the flat item index or -1 if not on an item.
 *
 * Layout per group:
 *   1 row: group title
 *   N rows: entries
 *   1 row: blank spacer (except last group)
 */
export function getSettingsItemAtRow(row: number): number {
  const groups = getSettingsGroupDefs();
  let currentRow = 0;
  let flatIndex = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    currentRow++; // group title row
    for (let ei = 0; ei < groups[gi].entries.length; ei++) {
      if (currentRow === row) return flatIndex;
      currentRow++;
      flatIndex++;
    }
    if (gi < groups.length - 1) currentRow++; // spacer
  }
  return -1;
}

/** Get the display value for a settings entry. */
function getEntryDisplayValue(entry: SettingsEntry): string {
  const raw = getValueByPath(entry.path);
  if (entry.type === 'boolean') return raw === true ? '[*]' : '[ ]';
  if (entry.type === 'enum') return String(raw ?? '-');
  return String(raw ?? '-');
}

/** Type prefix icon for visual differentiation. */
function getTypePrefix(entry: SettingsEntry): string {
  switch (entry.type) {
    case 'boolean': return ' ';  // boolean indicator is part of the display value [*]/[ ]
    case 'enum': return '~';     // cycle indicator
    case 'number': return '#';
    case 'string': return ' ';
    default: return ' ';
  }
}

function getValueByPath(path: string): unknown {
  const keys = path.split('.');
  let current: unknown = config;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ── Component ──

interface SettingsPanelProps {
  width: number;
  cursor: number;
  editState: SettingsEditState;
  feedback?: SettingsFeedback | null;
}

export const SettingsPanel: FunctionComponent<SettingsPanelProps> = ({ width, cursor, editState, feedback }) => {
  const groups = getSettingsGroupDefs();
  const innerWidth = Math.max(20, width - 4);
  const LABEL_WIDTH = 16;
  const helpText = editState.editing ? t('tui.settings.help_edit') : t('tui.settings.help_nav');
  let flatIndex = 0;

  return (
    <PanelFrame title={t('tui.settings.title')} width={width} help={helpText}>
      {/* Save feedback banner */}
      {feedback && (
        <Box paddingLeft={1} marginBottom={0}>
          <Text color={feedback.type === 'success' ? tuiTheme.semantic.status.success : tuiTheme.semantic.status.error}>
            {feedback.type === 'success' ? '[ok] ' : '[!] '}{feedback.text}
          </Text>
        </Box>
      )}
      {groups.map((group, gi) => (
        <Box key={group.title} flexDirection="column" marginTop={gi > 0 ? 1 : 0}>
          <Text bold color={tuiTheme.semantic.text.accent}>{group.title}</Text>
          {group.entries.map((entry) => {
            const idx = flatIndex++;
            const isSelected = idx === cursor;
            const isEditing = isSelected && editState.editing;
            const displayValue = getEntryDisplayValue(entry);
            const prefix = getTypePrefix(entry);

            return (
              <Box key={entry.path} paddingLeft={1}>
                <Text color={isSelected ? tuiTheme.semantic.text.primary : tuiTheme.semantic.text.secondary}>
                  {isSelected ? '>' : ' '}
                </Text>
                <Text color={tuiTheme.semantic.text.secondary} dimColor={!isSelected}>
                  {prefix}
                </Text>
                <Text
                  color={isSelected ? tuiTheme.semantic.text.primary : tuiTheme.semantic.text.secondary}
                  bold={isSelected}
                  wrap="truncate-end"
                >
                  {entry.label.padEnd(LABEL_WIDTH)}
                </Text>
                {isEditing ? (
                  <EditField text={editState.editText} cursor={editState.editCursor} maxWidth={innerWidth - LABEL_WIDTH - 6} />
                ) : (
                  <Text
                    color={entry.type === 'boolean'
                      ? (displayValue === '[*]' ? tuiTheme.semantic.status.success : tuiTheme.semantic.text.secondary)
                      : entry.type === 'enum'
                        ? tuiTheme.semantic.status.info
                        : tuiTheme.semantic.text.primary}
                    wrap="truncate-end"
                  >
                    {displayValue.slice(0, innerWidth - LABEL_WIDTH - 6)}
                  </Text>
                )}
                {/* Show enum hint for selected enum item */}
                {isSelected && !isEditing && entry.type === 'enum' && entry.enumValues && (
                  <Text color={tuiTheme.semantic.text.secondary} dimColor>
                    {' '}({entry.enumValues.length})
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
      {/* Selected item detail */}
      {(() => {
        const entries = getFlatSettingsEntries();
        const selected = entries[cursor];
        if (!selected) return null;
        const rawValue = getValueByPath(selected.path);
        return (
          <Box marginTop={1} paddingLeft={1} flexDirection="column">
            <Text color={tuiTheme.semantic.panel.border}>{'─'.repeat(Math.max(8, width - 6))}</Text>
            <Text color={tuiTheme.semantic.text.secondary}>
              {selected.path} = {String(rawValue ?? 'undefined')}
            </Text>
            {selected.type === 'enum' && selected.enumValues && (
              <Text color={tuiTheme.semantic.text.secondary} dimColor>
                {t('tui.settings.options')}{selected.enumValues.join(' | ')}
              </Text>
            )}
          </Box>
        );
      })()}
    </PanelFrame>
  );
};

/** Inline edit field with visible block caret and boundary markers. */
function EditField({ text, cursor, maxWidth }: { text: string; cursor: number; maxWidth: number }) {
  const safeMax = Math.max(1, maxWidth - 2); // -2 for boundary brackets
  // Sliding window: ensure cursor is always visible within the viewport
  let start = 0;
  if (cursor >= safeMax) {
    start = cursor - safeMax + 1;
  }
  const visible = text.slice(start, start + safeMax);
  const pos = cursor - start;
  const before = visible.slice(0, pos);
  const atCursor = visible[pos] || ' ';
  const after = visible.slice(pos + 1);
  const hasOverflow = text.length > safeMax;
  return (
    <Text>
      <Text color={tuiTheme.semantic.panel.border}>{start > 0 ? '<' : '['}</Text>
      <Text color={tuiTheme.semantic.text.primary}>{before}</Text>
      <Text backgroundColor={tuiTheme.semantic.status.info} color="#000000" bold>{atCursor}</Text>
      <Text color={tuiTheme.semantic.text.primary}>{after}</Text>
      <Text color={tuiTheme.semantic.panel.border}>{hasOverflow && start + safeMax < text.length ? '>' : ']'}</Text>
    </Text>
  );
}
