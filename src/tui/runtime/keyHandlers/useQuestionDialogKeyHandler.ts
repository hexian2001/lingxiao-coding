import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { handleQuestionDialogKey, type QuestionDialogState } from '../../QuestionDialog.js';
import type { KeyLike } from '../useTuiKeyController.js';

export interface QuestionDialogKeyOptions {
  agentQuestionStateRef: MutableRefObject<QuestionDialogState | null>;
  setAgentQuestionState: Dispatch<SetStateAction<QuestionDialogState | null>>;
  inputBufferRef: MutableRefObject<string>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  handleSubmitRef: MutableRefObject<() => Promise<void>>;
}

/**
 * Returns true if the key was consumed by the question dialog.
 */
export function handleQuestionDialogKeyPress(
  key: KeyLike,
  opts: QuestionDialogKeyOptions,
): boolean {
  const {
    agentQuestionStateRef,
    setAgentQuestionState,
    inputBufferRef,
    setInputBuffer,
    handleSubmitRef,
  } = opts;

  if (!agentQuestionStateRef.current) return false;

  handleQuestionDialogKey(
    {
      name: key.name ?? '',
      sequence: key.sequence,
      ctrl: key.ctrl,
      meta: key.meta,
    },
    agentQuestionStateRef.current,
    {
      setState: (newState) => {
        agentQuestionStateRef.current = newState;
        setAgentQuestionState(newState);
      },
      onSubmit: (answer) => {
        setAgentQuestionState(null);
        inputBufferRef.current = answer;
        setInputBuffer(answer);
        handleSubmitRef.current();
      },
      onCancel: () => setAgentQuestionState(null),
    },
  );
  return true;
}
