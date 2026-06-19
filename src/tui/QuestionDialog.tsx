/**
 * QuestionDialog — Agent 提问弹窗（支持多问题向导）
 *
 * 当 Leader Agent 调用 ask_user 工具时，显示此对话框。
 *
 * 单问题模式：
 *   - 无选项：自由文本输入框（Enter 提交）
 *   - 有选项：↑↓ 移动，Space/数字 切换选中，Enter 确认
 *   - 末尾附 "Other" 输入框可补充
 *
 * 多问题向导模式（questions[] 数组）：
 *   - 每次显示一个问题，Tab/Right/Enter 进入下一题，Left/b 返回上题
 *   - 最后一题 Enter 统一提交所有答案
 */
import React from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import { t } from '../i18n.js';

export interface QuestionOption {
  value: string;
  label?: string;
}

export interface QuestionItem {
  question: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

/** Per-step answer */
export interface StepAnswer {
  cursor: number;
  checked: Set<number>;
  inputText: string;   // "Other" / free-text
  /** Caret position within inputText (0..inputText.length). */
  inputCursor: number;
}

export interface QuestionDialogState {
  questions: QuestionItem[];
  /** Current wizard step */
  currentStep: number;
  /** Per-step answers (length == questions.length) */
  stepAnswers: StepAnswer[];
}

interface QuestionDialogProps {
  state: QuestionDialogState;
  onSubmit: (answer: string) => void;
  onCancel: () => void;
  width?: number;
}

const MAX_VISIBLE = 8;

function emptyStepAnswer(): StepAnswer {
  return { cursor: 0, checked: new Set(), inputText: '', inputCursor: 0 };
}

/** Clamp a caret index into [0, text.length]. */
function caretPos(text: string, cursor: number): number {
  return Math.max(0, Math.min(text.length, cursor));
}

/**
 * Render a single-line text field with a visible block caret at `pos`.
 * The caret highlights the character it sits on (or a trailing space when at
 * end), so editing mid-string is actually visible in the terminal.
 */
const TextWithCaret: React.FC<{ text: string; pos: number }> = ({ text, pos }) => {
  const before = text.slice(0, pos);
  const at = text.slice(pos, pos + 1) || ' ';
  const after = text.slice(pos + 1);
  return (
    <Text>
      <Text color={tuiTheme.semantic.text.primary}>{before}</Text>
      <Text color={tuiTheme.semantic.selection.text} backgroundColor={tuiTheme.semantic.selection.background}>{at}</Text>
      <Text color={tuiTheme.semantic.text.primary}>{after}</Text>
    </Text>
  );
};

/** Render one step of the wizard */
const StepPane: React.FC<{
  item: QuestionItem;
  stepAnswer: StepAnswer;
  stepIndex: number;
  totalSteps: number;
  isFinal: boolean;
  contentWidth: number;
}> = ({ item, stepAnswer, stepIndex, totalSteps, isFinal, contentWidth }) => {
  const { options, multiSelect } = item;
  const hasOptions = options && options.length > 0;
  const { cursor, checked, inputText } = stepAnswer;

  const visibleStart = Math.max(0, cursor - Math.floor(MAX_VISIBLE / 2));
  const visibleEnd = Math.min((options?.length || 0), visibleStart + MAX_VISIBLE);
  const visibleItems = hasOptions ? options!.slice(visibleStart, visibleEnd) : [];

  return (
    <Box flexDirection="column">
      {/* Step indicator */}
      {totalSteps > 1 && (
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.text.secondary}>{`[${stepIndex + 1}/${totalSteps}] `}</Text>
          <Text color={tuiTheme.semantic.status.blocked} bold>{truncateDisplayText(item.question, contentWidth - 8)}</Text>
        </Box>
      )}
      {totalSteps === 1 && (
        <Box marginBottom={1}>
          <Text bold color={tuiTheme.semantic.text.primary}>{truncateDisplayText(item.question, contentWidth - 2)}</Text>
        </Box>
      )}

      {hasOptions ? (
        <>
          {visibleItems.map((opt, vi) => {
            const realIdx = visibleStart + vi;
            const isHighlighted = realIdx === cursor;
            const isChecked = multiSelect ? checked.has(realIdx) : false;
            const displayLabel = opt.label || opt.value;
            return (
              <Box key={opt.value + realIdx} flexDirection="row">
                <Text
                  color={isHighlighted ? tuiTheme.semantic.selection.text : tuiTheme.semantic.text.primary}
                  backgroundColor={isHighlighted ? tuiTheme.semantic.selection.background : undefined}
                >
                  {isHighlighted ? '❯ ' : '  '}
                  {multiSelect && (
                    <Text color={isChecked ? tuiTheme.semantic.status.completed : tuiTheme.semantic.text.secondary}>
                      {isChecked ? '[✓] ' : '[ ] '}
                    </Text>
                  )}
                  <Text bold={isHighlighted} color={isHighlighted ? tuiTheme.semantic.selection.text : tuiTheme.semantic.text.accent}>
                    {truncateDisplayText(displayLabel, contentWidth - 8)}
                  </Text>
                </Text>
              </Box>
            );
          })}

          {/* Other input */}
          <Box marginTop={1} flexDirection="row" alignItems="center">
            <Text color={tuiTheme.semantic.text.secondary}>{t('tui.question.other_label')}</Text>
            <Box borderStyle="single" borderColor={inputText ? tuiTheme.semantic.border.focused : tuiTheme.semantic.border.default} paddingX={1}>
              <TextWithCaret text={inputText} pos={caretPos(inputText, stepAnswer.inputCursor)} />
            </Box>
          </Box>

          {/* Help line */}
          <Box marginTop={1}>
            <Text color={tuiTheme.semantic.panel.help}>
              {multiSelect
                ? t('tui.question.help_multi_step', isFinal)
                : t('tui.question.help_single_step', isFinal)}
            </Text>
          </Box>
          {multiSelect && checked.size > 0 && (
            <Text color={tuiTheme.semantic.status.completed}>{t('tui.question.selected_count', checked.size)}</Text>
          )}
        </>
      ) : (
        <>
          <Box
            borderStyle="single"
            borderColor={tuiTheme.semantic.border.focused}
            paddingX={1}
            marginBottom={1}
          >
            <TextWithCaret text={inputText} pos={caretPos(inputText, stepAnswer.inputCursor)} />
          </Box>
          <Box>
            <Text color={tuiTheme.semantic.panel.help}>
              {t('tui.question.help_text_step', isFinal)}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
};

export const QuestionDialog: React.FC<QuestionDialogProps> = ({
  state,
  onSubmit,
  onCancel,
  width = 70,
}) => {
  const { questions, currentStep, stepAnswers } = state;

  const items = questions;

  const safeStep = Math.min(currentStep, items.length - 1);
  const item = items[safeStep]!;
  const stepAnswer = stepAnswers[safeStep] ?? emptyStepAnswer();
  const isFinal = safeStep === items.length - 1;
  const contentWidth = Math.max(30, width - 6);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tuiTheme.semantic.status.blocked}
      paddingX={1}
      paddingY={1}
    >
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={tuiTheme.semantic.status.blocked}>? </Text>
        {items.length > 1
          ? <Text bold color={tuiTheme.semantic.status.blocked}>{t('tui.question.multi_title', items.length)}</Text>
          : <Text bold color={tuiTheme.semantic.text.primary}>{truncateDisplayText(item.question, contentWidth - 2)}</Text>
        }
      </Box>

      <StepPane
        item={item}
        stepAnswer={stepAnswer}
        stepIndex={currentStep}
        totalSteps={items.length}
        isFinal={isFinal}
        contentWidth={contentWidth}
      />
    </Box>
  );
};

QuestionDialog.displayName = 'QuestionDialog';

/**
 * Handle a keypress while QuestionDialog is active.
 * Returns true if the key was consumed.
 */
export function handleQuestionDialogKey(
  key: { name: string; sequence?: string; ctrl?: boolean; meta?: boolean },
  state: QuestionDialogState,
  dispatch: {
    setState: (s: QuestionDialogState) => void;
    onSubmit: (answer: string) => void;
    onCancel: () => void;
  },
): boolean {
  const { setState, onSubmit, onCancel } = dispatch;

  const items = state.questions;

  const { currentStep, stepAnswers } = state;
  // Safe step index — clamp to valid range
  const safeStep = Math.min(currentStep, items.length - 1);
  const item = items[safeStep]!;
  const stepAnswer = stepAnswers[safeStep] ?? emptyStepAnswer();
  const { options, multiSelect } = item;
  const hasOptions = options && options.length > 0;
  const { cursor, checked, inputText } = stepAnswer;
  const isFinal = safeStep === items.length - 1;

  const updateStep = (patch: Partial<StepAnswer>) => {
    const newAnswers = [...stepAnswers];
    newAnswers[safeStep] = { ...stepAnswer, ...patch };
    setState({ ...state, stepAnswers: newAnswers });
  };

  if (key.name === 'escape') {
    onCancel();
    return true;
  }

  // ---- "b" = back — only when options are shown (not in free-text mode)
  // In free-text mode, "b" is treated as a regular character below.
  if (hasOptions && !key.ctrl && !key.meta && key.sequence === 'b') {
    if (safeStep > 0) {
      setState({ ...state, currentStep: safeStep - 1 });
    }
    return true;
  }

  // ---- Tab or right arrow = advance/next
  // ---- Tab (always) / Right arrow (options mode only) = advance/next.
  // In free-text mode Right is reserved for caret movement, so it must NOT
  // advance the wizard there.
  if (key.name === 'tab' || (key.name === 'right' && hasOptions)) {
    const canAdvance = hasOptions
      ? checked.size > 0 || (!multiSelect && options && options[cursor] != null) || inputText.trim().length > 0
      : inputText.trim().length > 0;

    if (isFinal) {
      if (canAdvance) {
        _submitAll(items, stepAnswers, safeStep, stepAnswer, onSubmit);
      }
    } else {
      setState({ ...state, currentStep: safeStep + 1 });
    }
    return true;
  }

  // ---- Enter
  if (key.name === 'return') {
    const canProceed = hasOptions
      ? multiSelect
        ? checked.size > 0 || inputText.trim().length > 0
        : (options && options[cursor] != null) || inputText.trim().length > 0
      : inputText.trim().length > 0;

    if (!canProceed) {
      // Nothing selected/filled — let the key propagate (don't block)
      return false;
    }

    if (isFinal) {
      _submitAll(items, stepAnswers, safeStep, stepAnswer, onSubmit);
    } else {
      setState({ ...state, currentStep: safeStep + 1 });
    }
    return true;
  }

  // ---- Navigation (options mode)
  if (hasOptions) {
    if (key.name === 'up') {
      updateStep({ cursor: Math.max(0, cursor - 1) });
      return true;
    }
    if (key.name === 'down') {
      updateStep({ cursor: Math.min(options!.length - 1, cursor + 1) });
      return true;
    }
    if (key.name === 'space' && multiSelect) {
      const newChecked = new Set(checked);
      if (newChecked.has(cursor)) newChecked.delete(cursor);
      else newChecked.add(cursor);
      updateStep({ checked: newChecked });
      return true;
    }
    // Number shortcuts
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1) {
      const num = parseInt(key.sequence, 10);
      if (!isNaN(num) && num >= 1 && num <= 9 && num - 1 < options!.length) {
        const targetIdx = num - 1;
        if (multiSelect) {
          const newChecked = new Set(checked);
          if (newChecked.has(targetIdx)) newChecked.delete(targetIdx);
          else newChecked.add(targetIdx);
          updateStep({ cursor: targetIdx, checked: newChecked });
        } else {
          updateStep({ cursor: targetIdx });
        }
        return true;
      }
      // Non-numeric printable char → insert into Other field at caret
      if (key.sequence !== '\t') {
        const pos = caretPos(inputText, stepAnswer.inputCursor);
        updateStep({
          inputText: inputText.slice(0, pos) + key.sequence + inputText.slice(pos),
          inputCursor: pos + 1,
        });
        return true;
      }
    }
    // Backspace in Other field (delete char before caret). Ctrl+H is an
    // alternate backspace some terminals emit — accept it too.
    if (key.name === 'backspace' || key.sequence === '\x7f' || (key.ctrl && key.name === 'h')) {
      const pos = caretPos(inputText, stepAnswer.inputCursor);
      if (pos > 0) {
        updateStep({
          inputText: inputText.slice(0, pos - 1) + inputText.slice(pos),
          inputCursor: pos - 1,
        });
      }
      return true;
    }
  } else {
    // ── Free-text mode — caret-aware single-line editor ──
    const pos = caretPos(inputText, stepAnswer.inputCursor);
    if (key.name === 'left') {
      updateStep({ inputCursor: Math.max(0, pos - 1) });
      return true;
    }
    if (key.name === 'right') {
      updateStep({ inputCursor: Math.min(inputText.length, pos + 1) });
      return true;
    }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      updateStep({ inputCursor: 0 });
      return true;
    }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      updateStep({ inputCursor: inputText.length });
      return true;
    }
    if (key.name === 'backspace' || key.sequence === '\x7f' || (key.ctrl && key.name === 'h')) {
      if (pos > 0) {
        updateStep({
          inputText: inputText.slice(0, pos - 1) + inputText.slice(pos),
          inputCursor: pos - 1,
        });
      }
      return true;
    }
    if (key.name === 'delete') {
      if (pos < inputText.length) {
        updateStep({ inputText: inputText.slice(0, pos) + inputText.slice(pos + 1) });
      }
      return true;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1) {
      updateStep({
        inputText: inputText.slice(0, pos) + key.sequence + inputText.slice(pos),
        inputCursor: pos + 1,
      });
      return true;
    }
  }

  return false;
}

/** Build combined answer string and call onSubmit */
function _submitAll(
  items: QuestionItem[],
  stepAnswers: StepAnswer[],
  currentStep: number,
  currentStepAnswer: StepAnswer,
  onSubmit: (answer: string) => void,
) {
  // Ensure current step answer is included
  const answers = stepAnswers.map((sa, i) => i === currentStep ? currentStepAnswer : sa);

  const combined = items
    .map((item, i) => {
      const sa = answers[i] ?? emptyStepAnswer();
      const resolved = resolveAnswer(sa, item.options, item.multiSelect);
      return items.length > 1
        ? `[Q${i + 1}: ${item.question}] ${resolved}`
        : resolved;
    })
    .filter(Boolean)
    .join('\n');

  onSubmit(combined);
}

/** Resolve answer string for one step */
function resolveAnswer(step: StepAnswer, options?: QuestionOption[], multiSelect?: boolean): string {
  const parts: string[] = [];
  if (options && options.length > 0) {
    if (multiSelect) {
      [...step.checked].sort((a, b) => a - b).forEach((i) => {
        if (options[i]) parts.push(options[i]!.value);
      });
    } else {
      if (options[step.cursor]) parts.push(options[step.cursor]!.value);
    }
  }
  if (step.inputText.trim()) parts.push(step.inputText.trim());
  return parts.join(', ');
}
