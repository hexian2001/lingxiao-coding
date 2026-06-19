import { Box, Text } from 'ink';
import type { FunctionComponent } from 'react';
import { tuiTheme } from './theme.js';
import { t } from '../i18n.js';
import { EmptyState, PanelFrame } from './components/PanelFrame.js';
import { getPhaseVisual } from './design/visuals.js';
import { truncateDisplayText } from './utils.js';

export interface WorkNoteItem {
  id: string;
  agentId: string;
  taskId: string;
  timestamp: number;
  phase: string;
  summary: string;
  details?: string;
  blockers?: string[];
}

interface WorkNotesPanelProps {
  notes: WorkNoteItem[];
  maxNotes?: number;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

export const WorkNotesPanel: FunctionComponent<WorkNotesPanelProps> = ({ notes, maxNotes = 20 }) => {
  const displayNotes = notes.slice(0, maxNotes);

  if (displayNotes.length === 0) {
    return (
      <PanelFrame title={t('tui.worknotes.title')}>
        <EmptyState text={t('tui.worknotes.empty')} />
      </PanelFrame>
    );
  }

  return (
    <PanelFrame title={t('tui.worknotes.title')} meta={t('tui.worknotes.count', displayNotes.length)}>
      {displayNotes.map((note) => (
        <Box key={note.id} flexDirection="column" marginBottom={1}>
          <Box>
            {(() => {
              const visual = getPhaseVisual(note.phase);
              return (
                <>
                  <Text color={tuiTheme.semantic.text.secondary}>{formatTimestamp(note.timestamp)}</Text>
                  <Text color={tuiTheme.semantic.text.secondary}> | </Text>
                  <Text bold color={visual.color}>
                    {`[${visual.icon}] ${visual.label}`}
                  </Text>
                </>
              );
            })()}
            <Text color={tuiTheme.semantic.text.secondary}> | </Text>
            <Text color={tuiTheme.semantic.runtime.agent}>{` ${note.agentId}`}</Text>
            <Text color={tuiTheme.semantic.text.secondary}>{` [${note.taskId}]`}</Text>
          </Box>
          <Box>
            <Text color={tuiTheme.semantic.text.primary}>{`  ${note.summary}`}</Text>
          </Box>
          {note.blockers && note.blockers.length > 0 && (
            <Box>
              <Text color={tuiTheme.semantic.status.failed}>{`  ${t('tui.worknotes.blockers')}${note.blockers.join(', ')}`}</Text>
            </Box>
          )}
          {note.details && (
            <Box>
              <Text color={tuiTheme.semantic.text.secondary}>{`     ${truncateDisplayText(note.details, 120)}`}</Text>
            </Box>
          )}
        </Box>
      ))}
    </PanelFrame>
  );
};
