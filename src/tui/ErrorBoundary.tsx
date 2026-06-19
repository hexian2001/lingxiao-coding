/**
 * ErrorBoundary — TUI 组件错误隔离
 *
 * 捕获子组件渲染时的异常，防止单个组件崩溃影响整体。
 * 支持错误状态显示 + 自动恢复。
 *
 * 用法:
 * <ErrorBoundary renderError={(error) => <Text color={tuiTheme.semantic.status.failed}>Error: {error.message}</Text>}>
 *   <MyComponent />
 * </ErrorBoundary>
 */

import React, { Component, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { t } from '../i18n.js';

interface ErrorBoundaryProps {
  children: ReactNode;
  renderError?: (error: Error, retry: () => void) => ReactNode;
  /** 组件名称 (用于日志) */
  componentName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
      retryCount: 0,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const name = this.props.componentName || 'Unknown';
    console.error(t('tui.error.component_crashed_log', name), error.message);
    if (errorInfo.componentStack) {
      console.error(t('tui.error.component_stack_log'), errorInfo.componentStack.slice(0, 200));
    }
  }

  /**
   * 重试: 重置错误状态，强制重新渲染
   */
  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      retryCount: this.state.retryCount + 1,
    });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      // 使用自定义错误渲染
      if (this.props.renderError) {
        return this.props.renderError(this.state.error, this.handleRetry);
      }

      // 默认错误显示
      return (
        <Box flexDirection="column" padding={1}>
          <Text color={tuiTheme.semantic.status.failed}>{t('tui.error.component_error', this.props.componentName || 'Unknown')}</Text>
          <Text color={tuiTheme.semantic.status.blocked} wrap="truncate">{this.state.error.message}</Text>
          <Text color={tuiTheme.semantic.panel.help}>{t('tui.error.component_retry_hint')}</Text>
        </Box>
      );
    }

    // key 变化触发重新挂载 (用于恢复)
    return (
      <React.Fragment key={`eb-${this.state.retryCount}`}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
