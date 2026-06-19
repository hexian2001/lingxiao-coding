type ModalItem = { id?: string; agentName?: string; name?: string };

type ModalSyncDeps = {
  getModalType: () => string | null;
  getModalCursor: () => number;
  getModalItems: () => ModalItem[] | undefined;
  setModalType: (next: string | null | ((prev: string | null) => string | null)) => void;
  setModalCursor: (updater: (prev: number) => number) => void;
  setModalData: (next: null) => void;
  onResume: (id: string) => void;
  onDAGSelect?: (agentName: string) => void;
  /** team 模态（Agent 侧栏）选中某 Agent 时聚焦其渠道（= 切到该 Agent 视图）。 */
  onTeamSelect?: (agentName: string) => void;
};

type ModalSync = {
  handleEnter: () => boolean;
  handleEscape: () => boolean;
  handleUp: () => boolean;
  handleDown: () => boolean;
  handlePageUp: (step: number) => boolean;
  handlePageDown: (step: number) => boolean;
};

export const createModalSync = (deps: ModalSyncDeps): ModalSync => {
  const getSelectableItems = () => {
    const modalType = deps.getModalType();
    if (modalType !== 'resume' && modalType !== 'history' && modalType !== 'dag' && modalType !== 'graph' && modalType !== 'team') return undefined;
    return deps.getModalItems();
  };

  const handleEnter = () => {
    const modalType = deps.getModalType();
    if (modalType === 'dag') {
      const items = deps.getModalItems();
      const cursor = deps.getModalCursor();
      const item = items && items[cursor];
      if (item) {
        deps.setModalType(null);
        deps.setModalData(null);
        // Item has an agentName field — jump to that agent's channel
        const agentName = item.agentName || item.name;
        if (agentName && deps.onDAGSelect) {
          deps.onDAGSelect(agentName);
        }
      }
      return true;
    }
    if (modalType === 'team') {
      const items = deps.getModalItems();
      const cursor = deps.getModalCursor();
      const item = items && items[cursor];
      if (item) {
        deps.setModalType(null);
        deps.setModalData(null);
        const agentName = item.agentName || item.name;
        if (agentName && deps.onTeamSelect) {
          deps.onTeamSelect(agentName);
        }
      }
      return true;
    }
    if (modalType !== 'resume' && modalType !== 'history') return false;
    const items = getSelectableItems();
    const cursor = deps.getModalCursor();
    const item = items && items[cursor] ? items[cursor] : undefined;
    if (item && item.id) {
      deps.setModalType(null);
      deps.setModalData(null);
      if (modalType === 'resume') deps.onResume(item.id);
    }
    return true;
  };

  const handleEscape = () => {
    if (!deps.getModalType()) return false;
    deps.setModalType(null);
    return true;
  };

  const handleUp = () => {
    if (!deps.getModalType()) return false;
    const items = getSelectableItems();
    if (!items) return false;
    deps.setModalCursor((prev) => Math.max(0, prev - 1));
    return true;
  };

  const handleDown = () => {
    if (!deps.getModalType()) return false;
    const items = getSelectableItems();
    if (!items) return false;
    const count = items ? items.length : 0;
    deps.setModalCursor((prev) => count > 0 ? Math.min(count - 1, prev + 1) : 0);
    return true;
  };

  const handlePageUp = (step: number) => {
    if (!deps.getModalType()) return false;
    const items = getSelectableItems();
    if (!items) return false;
    deps.setModalCursor((prev) => Math.max(0, prev - Math.max(1, step)));
    return true;
  };

  const handlePageDown = (step: number) => {
    if (!deps.getModalType()) return false;
    const items = getSelectableItems();
    if (!items) return false;
    const count = items.length;
    deps.setModalCursor((prev) => count > 0 ? Math.min(count - 1, prev + Math.max(1, step)) : 0);
    return true;
  };

  return {
    handleEnter,
    handleEscape,
    handleUp,
    handleDown,
    handlePageUp,
    handlePageDown,
  };
};
