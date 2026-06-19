/**
 * Shared types and constants for the canvas workflow editor.
 */

import {
  Play, Bot, Cpu, Wrench, GitBranch, Zap, Terminal,
  Trash2, Copy, ArrowRight, Edit3, Eye, Repeat, GitMerge, Braces, List, Globe, Clock,
} from 'lucide-react';
import type { ReactNode } from 'react';
import i18n from '../../i18n';

// ─── Context menu ───

export interface CtxMenu {
  x: number;
  y: number;
  type: 'canvas' | 'node' | 'edge';
  nodeId?: string;
  edgeId?: string;
}

export interface CanvasMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  k?: string;
  danger?: boolean;
}

// ─── Menu items ───

export const getCanvasItems = (): CanvasMenuItem[] => [
  { id: 'add-leader',    label: i18n.t('canvas.menu.addLeader', 'Add Leader'),     icon: <Bot size={13}/>, k: '' },
  { id: 'add-agent',     label: i18n.t('canvas.menu.addAgent'),     icon: <Cpu size={13}/>, k: 'A' },
  { id: 'add-tool',      label: i18n.t('canvas.menu.addTool'),      icon: <Wrench size={13}/>, k: 'T' },
  { id: 'add-template',  label: i18n.t('canvas.menu.addTemplate', 'Add Template'), icon: <Terminal size={13}/>, k: '' },
  { id: 'add-variable_assigner', label: i18n.t('canvas.menu.addVariableAssigner', 'Add Assigner'), icon: <Braces size={13}/>, k: '' },
  { id: 'add-variable_aggregator', label: i18n.t('canvas.menu.addVariableAggregator', 'Add Aggregator'), icon: <GitMerge size={13}/>, k: '' },
  { id: 'add-list_operator', label: i18n.t('canvas.menu.addListOperator', 'Add List Op'), icon: <List size={13}/>, k: '' },
  { id: 'add-http_request', label: i18n.t('canvas.menu.addHttpRequest', 'Add HTTP'), icon: <Globe size={13}/>, k: '' },
  { id: 'add-json_extractor', label: i18n.t('canvas.menu.addJsonExtractor', 'Add JSON Extractor'), icon: <Braces size={13}/>, k: '' },
  { id: 'add-condition', label: i18n.t('canvas.menu.addCondition'), icon: <GitBranch size={13}/>, k: 'C' },
  { id: 'add-loop',      label: i18n.t('canvas.menu.addLoop', 'Add Loop'),         icon: <Repeat size={13}/>, k: '' },
  { id: 'add-parallel',  label: i18n.t('canvas.menu.addParallel', 'Add Parallel'), icon: <GitMerge size={13}/>, k: '' },
  { id: 'add-schedule_trigger', label: i18n.t('canvas.menu.addScheduleTrigger', 'Add Schedule'), icon: <Clock size={13}/>, k: '' },
  { id: 'add-input',     label: i18n.t('canvas.menu.addInput'),     icon: <Terminal size={13}/>, k: 'I' },
  { id: 'add-output',    label: i18n.t('canvas.menu.addOutput'),    icon: <Zap size={13}/>, k: 'O' },
  { id: 'sep1', label: '—' },
  { id: 'fit-view',      label: i18n.t('canvas.menu.fitView'),      icon: <Eye size={13}/>, k: 'F' },
  { id: 'reset',         label: i18n.t('canvas.menu.resetCanvas'),  icon: <Trash2 size={13}/>, k: '' },
];

export const getNodeItems = (): CanvasMenuItem[] => [
  { id: 'node-run',      label: i18n.t('canvas.menu.runFromNode'),  icon: <Play size={13}/>, k: 'R' },
  { id: 'node-connect',  label: i18n.t('canvas.menu.connectTo'),    icon: <ArrowRight size={13}/>, k: 'L' },
  { id: 'node-duplicate',label: i18n.t('canvas.menu.duplicateNode'),icon: <Copy size={13}/>, k: 'D' },
  { id: 'node-edit',     label: i18n.t('canvas.menu.editNode'),     icon: <Edit3 size={13}/>, k: 'E' },
  { id: 'sep2', label: '—' },
  { id: 'node-delete',   label: i18n.t('canvas.menu.deleteNode'),   icon: <Trash2 size={13}/>, k: 'Del', danger: true },
];

export const getEdgeItems = (): CanvasMenuItem[] => [
  { id: 'edge-sequence', label: i18n.t('canvas.menu.edgeSequence', 'Mark Sequence'), icon: <ArrowRight size={13}/>, k: '' },
  { id: 'edge-loop', label: i18n.t('canvas.menu.edgeLoop', 'Mark Loop Body'), icon: <Repeat size={13}/>, k: '' },
  { id: 'edge-data', label: i18n.t('canvas.menu.edgeData', 'Mark Data Mapping'), icon: <Wrench size={13}/>, k: '' },
  { id: 'edge-condition-true', label: i18n.t('canvas.menu.edgeConditionTrue', 'Mark Condition True'), icon: <GitBranch size={13}/>, k: 'T' },
  { id: 'edge-condition-false', label: i18n.t('canvas.menu.edgeConditionFalse', 'Mark Condition False'), icon: <GitBranch size={13}/>, k: 'F' },
  { id: 'sep1', label: '—' },
  { id: 'edge-delete', label: i18n.t('canvas.menu.deleteEdge'), icon: <Trash2 size={13}/>, k: 'Del', danger: true },
];
