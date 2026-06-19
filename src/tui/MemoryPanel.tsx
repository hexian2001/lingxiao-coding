import { Box, Text } from 'ink';
import { PanelFrame } from './components/PanelFrame.js';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import { t } from '../i18n.js';

export interface TuiMemoryAssetSummary {
  form: 'skill' | 'command' | 'agent';
  name: string;
  path: string;
  bytes: number;
  updatedAt: number;
}

export interface TuiMemoryPipelineSummary {
  kind: 'dream' | 'distill';
  enabled: boolean;
  autoIntervalDays: number;
  sessionLookbackDays: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  due: boolean;
}

export interface TuiMemoryStatus {
  enabled: boolean;
  workspace: string;
  memoryPath: string;
  memoryExists: boolean;
  memoryBytes: number;
  memoryLines: number;
  checkpointsIndexed: number;
  assets: TuiMemoryAssetSummary[];
  pipelines: {
    dream: TuiMemoryPipelineSummary;
    distill: TuiMemoryPipelineSummary;
  };
}

function formatDate(value: number | null): string {
  if (!value) return t('tui.memory.never');
  return new Date(value).toLocaleString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function PipelineLine({ pipeline }: { pipeline: TuiMemoryPipelineSummary }) {
  const color = !pipeline.enabled
    ? tuiTheme.semantic.text.secondary
    : pipeline.due
      ? tuiTheme.semantic.status.warning
      : tuiTheme.semantic.status.completed;
  return (
    <Box flexDirection="column">
      <Text color={color} bold>{t('tui.memory.kind.' + pipeline.kind)} {pipeline.due ? t('tui.memory.pipeline_due') : t('tui.memory.pipeline_scheduled')}</Text>
      <Text color={tuiTheme.semantic.panel.help}>
        {t('tui.memory.pipeline_interval', pipeline.autoIntervalDays, pipeline.sessionLookbackDays)}
      </Text>
      <Text color={tuiTheme.semantic.text.secondary}>
        {t('tui.memory.pipeline_last', formatDate(pipeline.lastRunAt))}
      </Text>
    </Box>
  );
}

export function MemoryPanel({
  status,
  width,
}: {
  status: TuiMemoryStatus | null;
  width: number;
}) {
  const inner = Math.max(24, width - 6);
  return (
    <PanelFrame title={t('tui.memory.title')} width={width} border paddingX={1}>
      {!status ? (
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.memory.loading_hint')}</Text>
      ) : (
        <Box flexDirection="column">
          <Text color={tuiTheme.semantic.text.secondary} wrap="truncate-end">
            {truncateDisplayText(status.workspace, inner)}
          </Text>
          <Text color={tuiTheme.semantic.panel.help} wrap="truncate-end">
            MEMORY.md {status.memoryExists ? t('tui.memory.memory_lines', status.memoryLines, formatBytes(status.memoryBytes)) : t('tui.memory.memory_not_created')}
          </Text>
          <Text color={tuiTheme.semantic.panel.help} wrap="truncate-end">
            {t('tui.memory.checkpoints_assets', status.checkpointsIndexed, status.assets.length)}
          </Text>
          <Box marginTop={1} flexDirection="row" gap={4}>
            <PipelineLine pipeline={status.pipelines.dream} />
            <PipelineLine pipeline={status.pipelines.distill} />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={tuiTheme.semantic.panel.title}>{t('tui.memory.recent_assets')}</Text>
            {status.assets.slice(0, 8).length === 0 ? (
              <Text color={tuiTheme.semantic.text.secondary}>{t('tui.memory.no_assets')}</Text>
            ) : status.assets.slice(0, 8).map((asset) => (
              <Text key={`${asset.form}:${asset.path}`} color={tuiTheme.semantic.text.secondary} wrap="truncate-end">
                [{asset.form}] {truncateDisplayText(asset.name, Math.max(12, inner - 10))}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={tuiTheme.semantic.text.accent}>
              {t('tui.memory.run_hint')}
            </Text>
          </Box>
        </Box>
      )}
    </PanelFrame>
  );
}
