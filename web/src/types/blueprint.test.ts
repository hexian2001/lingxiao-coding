import assert from 'node:assert/strict';
import test from 'node:test';
import {
  roleHanzi,
  BLUEPRINT_GAP_GLYPH,
  BLUEPRINT_STATUS_GLYPH,
  computeBlueprintCoverage,
  type ProjectBlueprint,
} from './blueprint';

test('roleHanzi: 与 TUI ROLE_HANZI 同源;fullstack 扩展为「贯」(TUI 无此键,蓝图补)', () => {
  assert.equal(roleHanzi('backend'), '枢');
  assert.equal(roleHanzi('frontend'), '屏');
  assert.equal(roleHanzi('fullstack'), '贯'); // 蓝图扩展
  assert.equal(roleHanzi('architect'), '构');
  assert.equal(roleHanzi('verify'), '验');
  assert.equal(roleHanzi('unknown'), '士'); // 默认回退
  assert.equal(roleHanzi(undefined), '士');
});

test('BLUEPRINT 方寸符号:状态几何符 + 缺口符,与 TUI BlueprintPanel 同源', () => {
  assert.equal(BLUEPRINT_STATUS_GLYPH.implement, '◉');
  assert.equal(BLUEPRINT_STATUS_GLYPH.defer, '◓');
  assert.equal(BLUEPRINT_STATUS_GLYPH.not_applicable, '◌');
  assert.equal(BLUEPRINT_GAP_GLYPH, '◇');
});

test('computeBlueprintCoverage: implement 无任务=缺口→拦截派发;defer/na 归类;name 取自 entry', () => {
  const bp: ProjectBlueprint = {
    createdAt: 0,
    updatedAt: 0,
    subsystems: [
      { subsystemId: 'auth', name: '认证登录', description: '登录注册', status: 'implement', taskIds: ['T-1'] },
      { subsystemId: 'api-surface', name: 'API 层', description: '路由控制器', status: 'implement', taskIds: [] }, // 缺口
      { subsystemId: 'rbac', name: '角色权限', description: 'RBAC', status: 'defer', taskIds: [], rationale: '二期' },
      { subsystemId: 'media', name: '媒体上传', description: '文件上传', status: 'not_applicable', taskIds: [], rationale: '本平台纯文本' },
    ],
  };
  const cov = computeBlueprintCoverage(bp);
  assert.equal(cov.readyToDispatch, false);
  assert.deepEqual(cov.uncovered.map((u) => u.id), ['api-surface']);
  assert.deepEqual(cov.uncovered.map((u) => u.name), ['API 层']);
  assert.deepEqual(cov.implemented, ['auth']);
  assert.deepEqual(cov.deferred, ['rbac']);
  assert.deepEqual(cov.notApplicable, ['media']);
});
