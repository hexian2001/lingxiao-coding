import type { ReactNode } from 'react';
import { Box } from 'ink';
import { CommandArgPicker, type CommandArgItem } from '../CommandArgPicker.js';
import { QuestionDialog, type QuestionDialogState } from '../QuestionDialog.js';
import { RewindDialog } from '../RewindDialog.js';
import type { RewindDialogState } from '../runtime/keyHandlers/useRewindDialogKeyHandler.js';

interface CommandArgPickerState {
  commandName: string;
  items: CommandArgItem[];
  cursor: number;
  filter: string;
}

interface ModalHostProps {
  termCols: number;
  termRows: number;
  agentQuestionState: QuestionDialogState | null;
  commandArgPickerState: CommandArgPickerState | null;
  rewindDialogState: RewindDialogState | null;
  modalVisible: boolean;
  modalOverlay: ReactNode;
  modalAlign?: 'center' | 'top';
  onQuestionSubmit: (answer: string) => void;
  onQuestionCancel: () => void;
  onCommandArgSelect: (item: CommandArgItem) => void;
  onCommandArgCancel: () => void;
  onRewindCancel: () => void;
}

export function ModalHost({
  termCols,
  termRows,
  agentQuestionState,
  commandArgPickerState,
  rewindDialogState,
  modalVisible,
  modalOverlay,
  modalAlign = 'center',
  onQuestionSubmit,
  onQuestionCancel,
  onCommandArgSelect,
  onCommandArgCancel,
  onRewindCancel,
}: ModalHostProps) {
  if (agentQuestionState) {
    return (
      <Box flexDirection="column" width={termCols} height={termRows} alignItems="center" justifyContent="center">
        <Box flexDirection="column" paddingX={1}>
          <QuestionDialog
            state={agentQuestionState}
            width={Math.min(termCols - 4, 72)}
            onSubmit={onQuestionSubmit}
            onCancel={onQuestionCancel}
          />
        </Box>
      </Box>
    );
  }

  if (commandArgPickerState) {
    return (
      <Box flexDirection="column" width={termCols} height={termRows} alignItems="center" justifyContent="center">
        <Box flexDirection="column" paddingX={1}>
          <CommandArgPicker
            commandName={commandArgPickerState.commandName}
            items={commandArgPickerState.items}
            cursor={commandArgPickerState.cursor}
            filter={commandArgPickerState.filter}
            width={Math.min(termCols - 4, 70)}
            onSelect={onCommandArgSelect}
            onCancel={onCommandArgCancel}
          />
        </Box>
      </Box>
    );
  }

  if (rewindDialogState) {
    // 键处理在 useRewindDialogKeyHandler；此处纯渲染。Esc/取消由 onRewindCancel 关闭。
    return (
      <Box flexDirection="column" width={termCols} height={termRows} alignItems="center" justifyContent="center">
        <Box flexDirection="column" paddingX={1}>
          <RewindDialog state={rewindDialogState} width={Math.min(termCols - 4, 76)} />
        </Box>
      </Box>
    );
  }

  if (modalVisible && modalOverlay) {
    return (
      <Box flexDirection="column" width={termCols} height={termRows} alignItems="center" justifyContent={modalAlign === 'top' ? 'flex-start' : 'center'} paddingTop={modalAlign === 'top' ? 1 : 0}>
        {modalOverlay}
      </Box>
    );
  }

  return null;
}
