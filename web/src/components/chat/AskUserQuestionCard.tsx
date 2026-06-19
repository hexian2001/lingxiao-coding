/**
 * AskUserQuestionCard — 分步向导式问题卡片
 *
 * 支持两种模式：
 * 1. 单问题：直接显示 question + options + Other 输入框 + 确认按钮
 * 2. 多问题向导（questions[]）：分步展示，左滑/Back 返回修改，右滑/Next 下一题，最后统一提交
 *
 * 每题末尾默认附带 "Other" 自由输入框，可选填（如已选预设选项，Other 可留空）。
 */
import { useState } from 'react';
import { MessageSquare, Check, ChevronLeft, ChevronRight, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface AskUserQuestionOption {
  value: string;
  label?: string;
}

export interface AskUserQuestionItem {
  question: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionStructuredAnswer {
  answers: Array<{
    question: string;
    selected: string[];
    otherText?: string;
    answer: string;
  }>;
}

export interface AskUserQuestionCardProps {
  question: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
  /** Multi-question wizard mode */
  questions?: AskUserQuestionItem[];
  onSubmit: (answer: string, structured: AskUserQuestionStructuredAnswer) => void;
  answered?: boolean;
  answeredValue?: string;
}

// ---- Per-step answer state ----
interface StepAnswer {
  selectedIndices: Set<number>;
  otherText: string;
}

function emptyStepAnswer(): StepAnswer {
  return { selectedIndices: new Set(), otherText: '' };
}

/** Resolve the final string answer for a step */
function resolveStepSelectedValues(answer: StepAnswer, options?: AskUserQuestionOption[]): string[] {
  if (!options || options.length === 0) return [];
  return [...answer.selectedIndices]
    .sort((a, b) => a - b)
    .map((i) => options[i]?.value)
    .filter((value): value is string => Boolean(value));
}

function resolveStepAnswer(answer: StepAnswer, options?: AskUserQuestionOption[]): string {
  const parts: string[] = [];
  parts.push(...resolveStepSelectedValues(answer, options));
  if (answer.otherText.trim()) {
    parts.push(answer.otherText.trim());
  }
  return parts.join(', ');
}

// ---- Single-step question UI ----
interface StepViewProps {
  item: AskUserQuestionItem;
  stepAnswer: StepAnswer;
  onChange: (next: StepAnswer) => void;
  /** Whether this is the only/last step (show Submit instead of Next) */
  isFinal: boolean;
  stepIndex: number;
  totalSteps: number;
  onBack?: () => void;
  onNext: () => void;
  canGoBack: boolean;
  submitted: boolean;
}

function StepView({
  item,
  stepAnswer,
  onChange,
  isFinal,
  stepIndex,
  totalSteps,
  onBack,
  onNext,
  canGoBack,
  submitted,
}: StepViewProps) {
  const { t } = useTranslation();
  const hasOptions = item.options && item.options.length > 0;
  const { selectedIndices, otherText } = stepAnswer;

  const handleOptionClick = (idx: number) => {
    if (submitted) return;
    if (item.multiSelect) {
      const next = new Set(selectedIndices);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      onChange({ ...stepAnswer, selectedIndices: next });
    } else {
      const next = new Set<number>();
      if (!selectedIndices.has(idx)) next.add(idx);
      onChange({ ...stepAnswer, selectedIndices: next });
    }
  };

  // Can proceed: either at least one option selected OR other text filled
  const canProceed = selectedIndices.size > 0 || otherText.trim().length > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Step header */}
      {totalSteps > 1 && (
        <div className="flex items-center gap-2">
          {/* Progress dots */}
          <div className="flex items-center gap-1">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`rounded-full transition-all ${
                  i === stepIndex
                    ? 'w-4 h-1.5 bg-accent-brand'
                    : i < stepIndex
                    ? 'w-1.5 h-1.5 bg-accent-brand/40'
                    : 'w-1.5 h-1.5 bg-border-default'
                }`}
              />
            ))}
          </div>
          <span className="text-[10px] text-text-tertiary font-mono">
            {stepIndex + 1} / {totalSteps}
          </span>
        </div>
      )}

      {/* Question text */}
      <p className="text-sm text-text-primary leading-5 font-medium">{item.question}</p>

      {/* Options */}
      {hasOptions && (
        <div className="flex flex-col gap-1.5">
          {item.options!.map((opt, idx) => {
            const label = opt.label || opt.value;
            const isSelected = selectedIndices.has(idx);
            return (
              <button
                key={opt.value + idx}
                onClick={() => handleOptionClick(idx)}
                disabled={submitted}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm text-left transition-all ${
                  isSelected
                    ? 'border-accent-brand/60 bg-accent-brand/10 text-text-primary'
                    : 'border-border-muted bg-bg-hover hover:border-accent-brand/30 hover:bg-accent-brand/5 text-text-secondary'
                }`}
              >
                {item.multiSelect ? (
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? 'border-accent-brand bg-accent-brand' : 'border-border-default'
                    }`}
                  >
                    {isSelected && <Check size={10} className="text-white" />}
                  </span>
                ) : (
                  <span
                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? 'border-accent-brand bg-accent-brand' : 'border-border-default'
                    }`}
                  >
                    {isSelected && <span className="w-2 h-2 rounded-full bg-white" />}
                  </span>
                )}
                <span className="flex-1">{label}</span>
                {isSelected && !item.multiSelect && (
                  <Check size={13} className="text-accent-brand shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Other / free-text input */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-tertiary">
          {hasOptions ? t('question.otherOptional') : t('question.type_answer_placeholder')}
        </label>
        <input
          value={otherText}
          onChange={(e) => onChange({ ...stepAnswer, otherText: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canProceed && !submitted) onNext();
          }}
          disabled={submitted}
          placeholder={hasOptions ? t('question.supplementPlaceholder') : t('question.answerPlaceholder')}
          className="w-full px-3 py-1.5 rounded-lg text-sm bg-bg-secondary border border-border-muted focus:border-accent-brand/60 focus:outline-none text-text-primary placeholder-text-tertiary disabled:opacity-50"
        />
      </div>

      {/* Footer: Back + status + Next/Submit */}
      <div className="flex items-center justify-between mt-1">
        <button
          onClick={onBack}
          disabled={!canGoBack || submitted}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-text-secondary border border-border-muted hover:border-border-default hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={13} />
          {t('question.back')}
        </button>

        <span className="text-[11px] text-text-tertiary">
          {item.multiSelect
            ? selectedIndices.size > 0
              ? t('question.selectedCount', { count: selectedIndices.size })
              : t('question.multiSelectHint')
            : selectedIndices.size > 0
            ? t('question.selected')
            : otherText.trim()
            ? t('question.filled')
            : t('question.selectOrFill')}
        </span>

        <button
          onClick={onNext}
          disabled={!canProceed || submitted}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-accent-brand text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-accent-brand/90 transition-colors"
        >
          {isFinal ? (
            <>
              <Send size={11} />
              {t('question.submit')}
            </>
          ) : (
            <>
              {t('question.next')}
              <ChevronRight size={13} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ---- Main Card ----
export function AskUserQuestionCard({
  question,
  options,
  multiSelect,
  questions,
  onSubmit,
  answered,
  answeredValue,
}: AskUserQuestionCardProps) {
  const { t } = useTranslation();

  // Normalize to wizard items
  const wizardItems: AskUserQuestionItem[] =
    questions && questions.length > 0
      ? questions
      : [{ question, options, multiSelect }];

  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<StepAnswer[]>(() =>
    wizardItems.map(() => emptyStepAnswer())
  );
  const [submitted, setSubmitted] = useState(false);

  const isDone = submitted || answered;

  const updateAnswer = (idx: number, next: StepAnswer) => {
    setAnswers((prev) => prev.map((a, i) => (i === idx ? next : a)));
  };

  const handleNext = () => {
    if (currentStep < wizardItems.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      // Final step — build human-readable summary plus structured per-question answers.
      const structured: AskUserQuestionStructuredAnswer = {
        answers: wizardItems.map((item, i) => {
          const answer = answers[i] ?? emptyStepAnswer();
          const stepStr = resolveStepAnswer(answer, item.options);
          return {
            question: item.question,
            selected: resolveStepSelectedValues(answer, item.options),
            otherText: answer.otherText.trim() || undefined,
            answer: stepStr,
          };
        }),
      };
      const combined = structured.answers
        .map((entry, i) => wizardItems.length > 1 ? `[Q${i + 1}: ${entry.question}] ${entry.answer}` : entry.answer)
        .filter(Boolean)
        .join('\n');
      setSubmitted(true);
      onSubmit(combined, structured);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  // Derive answered display
  const answeredDisplay = answeredValue
    ? answeredValue
    : null;

  return (
    <div className="my-2 rounded-xl border border-accent-brand/30 bg-accent-brand/5 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-start gap-2.5 border-b border-accent-brand/20">
        <MessageSquare size={15} className="text-accent-brand shrink-0 mt-0.5" />
        <p className="text-xs font-semibold text-accent-brand/80 uppercase tracking-wide">
          {isDone ? t('question.answered') : wizardItems.length > 1 ? t('question.multipleQuestions', { count: wizardItems.length }) : t('question.asking')}
        </p>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {isDone ? (
          <div className="flex items-start gap-2 text-sm">
            <Check size={13} className="text-accent-green shrink-0 mt-0.5" />
            <span className="text-text-primary italic whitespace-pre-wrap break-words">
              {answeredDisplay || t('question.submitted')}
            </span>
          </div>
        ) : (
          <StepView
            item={wizardItems[currentStep] ?? wizardItems[0]!}
            stepAnswer={answers[currentStep] ?? emptyStepAnswer()}
            onChange={(next) => updateAnswer(currentStep, next)}
            isFinal={currentStep === wizardItems.length - 1}
            stepIndex={currentStep}
            totalSteps={wizardItems.length}
            onBack={handleBack}
            onNext={handleNext}
            canGoBack={currentStep > 0}
            submitted={submitted}
          />
        )}
      </div>
    </div>
  );
}
