import { useViewStore } from '../stores/viewStore';
import { lazy, Suspense, useState, type ComponentType, type LazyExoticComponent } from 'react';
import ChatView from './chat/ChatView';
import PlaceholderView from './PlaceholderView';

const ChangesView = lazy(() => import('./changes/ChangesView'));
const TasksView = lazy(() => import('./tasks/TasksView'));
const DaemonView = lazy(() => import('./daemon/DaemonView'));
const MetricsView = lazy(() => import('./metrics/MetricsView'));
const StatsView = lazy(() => import('./stats/StatsView'));
const LogsView = lazy(() => import('./logs/LogsView'));
const EditorView = lazy(() => import('./editor/EditorView'));
const CanvasView = lazy(() => import('./canvas/CanvasView'));
const ArtifactView = lazy(() => import('./artifacts/ArtifactView'));
const TracesView = lazy(() => import('./traces/TracesView'));
const SettingsView = lazy(() => import('./settings/SettingsView'));
const PluginsView = lazy(() => import('./plugins/PluginsView'));
const KeybindingsView = lazy(() => import('./keybindings/KeybindingsView'));
const DocsView = lazy(() => import('./docs/DocsView'));
const WikiView = lazy(() => import('./wiki/WikiView'));
const MemoryView = lazy(() => import('./memory/MemoryView'));
const GitView = lazy(() => import('./git/GitView'));
const GraphView = lazy(() => import('./blackboard/GraphView'));
const DesignMarketView = lazy(() => import('./design-market/DesignMarketView'));
const TerminalPane = lazy(() => import('./canvas/TerminalPane'));
const CommandCenterView = lazy(() => import('./agents/CommandCenterView'));
const BlueprintView = lazy(() => import('./blueprint/BlueprintView'));
const LangfuseView = lazy(() => import('./langfuse/LangfuseView'));
const GitActivityView = lazy(() => import('./git/GitActivityView'));

type ViewComponent = ComponentType | LazyExoticComponent<ComponentType>;

function TerminalView() {
  const [id] = useState(() => `standalone-${crypto.randomUUID()}`);
  return (
    <div className="codex-chat-surface flex flex-col h-full">
      <div className="lingxiao-cloud-line codex-topbar flex items-center gap-2 px-4 py-2.5 border-b border-border-muted backdrop-blur-2xl shrink-0">
        <span className="text-[12px] font-semibold text-text-secondary">Terminal</span>
      </div>
      <div className="flex-1 min-h-0">
        <TerminalPane terminalId={id} />
      </div>
    </div>
  );
}

function ViewLoading() {
  return (
    <div className="flex h-full flex-1 items-center justify-center text-text-tertiary">
      <div className="flex items-center gap-2 text-xs">
        <span className="h-3 w-3 rounded-full border-2 border-accent-brand border-t-transparent animate-spin" />
        <span>Loading view...</span>
      </div>
    </div>
  );
}

const viewComponents: Record<string, ViewComponent> = {
  chat: ChatView,
  changes: ChangesView,
  tasks: TasksView,
  workers: DaemonView,
  metrics: MetricsView,
  stats: StatsView,
  logs: LogsView,
  editor: EditorView,
  canvas: CanvasView,
  artifact: ArtifactView,
  traces: TracesView,
  settings: SettingsView,
  plugins: PluginsView,
  keybindings: KeybindingsView,
  docs: DocsView,
  wiki: WikiView,
  memory: MemoryView,
  git: GitView,
  blackboard: GraphView,
  terminal: TerminalView,
  team: CommandCenterView,
  'design-market': DesignMarketView,
  blueprint: BlueprintView,
  langfuse: LangfuseView,
  'git-activity': GitActivityView,
};

export default function MainContent() {
  const mainView = useViewStore((s) => s.mainView);
  const Component = viewComponents[mainView] || PlaceholderView;
  return (
    <div className="codex-chat-surface flex-1 flex flex-col h-full min-w-0 overflow-hidden">
      <Suspense fallback={<ViewLoading />}>
        <Component />
      </Suspense>
    </div>
  );
}
