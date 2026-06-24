# 工具结果丢失问题修复说明

## 问题描述

Leader在工具执行期间频繁出现结果丢失，表现为：
- 工具已经执行（如 `echo hello`）
- 但Leader在工具完成前就中断了
- 显示 "Leader stopped before this tool executed: interrupted"
- 工具结果没有被持久化到对话历史中

## 根本原因

在 `src/agents/runtime/ToolResponseProcessor.ts` 中，原来的逻辑是：

```typescript
for (const { toolCall, result } of executed) {
  // 处理工具结果
  await persistToolMessage(...);
  emitToolResult(...);
  await afterToolResult?.(toolCall, result, renderedResult);
  
  // ❌ 问题：每个工具结果后立即检查终止条件
  const stop = shouldStopAfterToolResult?.();
  if (stop) {
    earlyStop ??= stop;
  }
}
```

**问题**：当批量执行多个工具时（如 `dispatch_batch` 或并行工具调用），如果：
1. 第一个工具执行完并持久化
2. `shouldStopAfterToolResult()` 检测到某个终止条件（如 Agent 完成信号、session finished）
3. 设置 `earlyStop`
4. **循环继续**，但后续工具的结果虽然已经在 `executeToolCallsBatch` 中执行完成，却因为提前终止而没有被持久化

这导致了"工具执行了但结果丢失"的现象。

## 修复方案

将 `shouldStopAfterToolResult()` 的检查**移到循环外**，确保所有工具结果都先持久化，然后再检查是否需要终止：

```typescript
// ✅ 修复后：先处理所有工具结果
for (const { toolCall, result } of executed) {
  const renderedResult = transformToolResult(toolCall, result);
  const toolMessageContent = (await externalizeImageDataInContent(
    renderedResult,
    toolCall.function.name,
  )) || '';
  const toolMessage: ChatMessage = {
    role: 'tool',
    content: toolMessageContent,
    tool_call_id: toolCall.id,
  };

  await persistToolMessage(toolMessage, toolCall, result, renderedResult);
  emitToolResult(toolCall, toolMessageContent);
  await afterToolResult?.(toolCall, result, renderedResult);
}

// ✅ 所有工具结果处理完毕后，统一检查是否需要提前终止
const stop = shouldStopAfterToolResult?.();
if (stop) {
  earlyStop = stop;
}
```

## 修复效果

1. **工具执行完整性保证**：`executeToolCallsBatch(toolCalls)` 返回的所有结果都会被持久化到数据库
2. **消息历史完整性**：对话历史中不会出现"有 assistant 工具调用但缺少 tool 结果"的残缺状态
3. **终止条件延后检查**：只有在所有工具结果都安全落库后，才判断是否需要提前终止本轮

## 测试验证

修复后，以下场景应该正常工作：

1. **批量工具调用**：`dispatch_batch` 派发多个任务时，所有任务的结果都应该被记录
2. **并行工具执行**：多个只读工具并行执行时，所有结果都应该被持久化
3. **Agent 完成信号**：即使在工具执行期间收到 Agent 完成信号，当前批次的所有工具结果也应该先持久化
4. **Session 终止**：即使 session 被标记为 finished，正在执行的工具结果也应该完整保存

## 相关文件

- `src/agents/runtime/ToolResponseProcessor.ts` - 核心修复
- `src/agents/leader/LeaderToolDispatch.ts` - 调用 ToolScheduler
- `src/agents/LeaderAgent.ts` - executeToolCallsBatch 实现
- `src/agents/runtime/parallelToolBatch.ts` - 并行工具执行逻辑

## 注意事项

此修复不影响正常的中断逻辑：
- 用户中断（ESC）仍然会立即中断 LLM 调用
- `beforeToolCalls` 的提前返回仍然有效
- 异常处理路径的 `onEarlyStop` 仍然会被调用
- 只是确保**已执行完的工具结果**不会因为终止条件而被丢弃
