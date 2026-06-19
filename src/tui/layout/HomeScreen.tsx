/**
 * HomeScreen — 凌霄剑域启动页：块字「凌霄」logo + 多层光场（呼吸 + 扫光）。
 *
 * 渲染范式移植自 mimo 的实心块字 logo。每个块字 cell 按光场亮度单色着色，
 * 暗底光常驻、accent 主色呼吸、扫光掠过时局部推向近白。配色每次启动从剑域
 * 调色板中随机取一套。无消息时显示，首条消息后切到聊天视图。
 * 低帧率（8fps）+ 缓慢光场，避免终端撕裂闪动。
 */
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import {
  pickGlyph,
  isLitCell,
  type GlyphVariant,
} from '../animation/glyph/lingxiaoGlyph.js';
import { composeWithSword } from '../animation/glyph/swordGlyph.js';
import {
  buildIdleState,
  sampleBrightness,
  shimmerForGlyph,
  DEFAULT_SWEEP,
} from '../animation/LightField.js';
import { brightnessToColor, LINGXIAO_GOLD_PALETTE, type Palette } from '../animation/ColorGradient.js';
import { useAnimation } from '../animation/useAnimation.js';
import { TipsRotator } from '../components/TipsRotator.js';
import { tuiTheme } from '../theme.js';
import { VERSION } from '../../version.js';
import { t as translate } from '../../i18n.js';

interface HomeScreenProps {
  workspace: string;
  modelName: string;
  width?: number;
}

/**
 * 渲染 logo 的一行：逐 cell 采样光场亮度，整格单色着色。
 * 返回一个 <Text> 包裹的若干着色 cell。
 */
function renderGlyphLine(
  line: string,
  rowIndex: number,
  t: number,
  idle: ReturnType<typeof buildIdleState>,
  palette: Palette,
): React.ReactNode {
  const cells: React.ReactNode[] = [];

  for (let x = 0; x < line.length; x++) {
    const ch = line[x];

    if (!isLitCell(ch)) {
      // 空白单元：透明，保持版面
      cells.push(<Text key={x}> </Text>);
      continue;
    }

    // 用 cell 中心采样一次亮度，整格单色渲染。
    // 不再用 backgroundColor 做子像素双采样——逐帧变更前景+背景双色会让终端
    // 渲染器频繁整格重绘、相邻格互相干扰，是撕裂/乱码的主因。单色 fg 渲染稳定得多。
    const b = sampleBrightness(x, rowIndex * 2 + 0.5, t, idle, DEFAULT_SWEEP);
    const fg = brightnessToColor(b, palette);
    cells.push(<Text key={x} color={fg}>{ch}</Text>);
  }

  return <Text key={rowIndex}>{cells}</Text>;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  workspace,
  modelName,
  width = 80,
}) => {
  const { t } = useAnimation(true);

  // 每次启动随机选一套字形（楷锋/宋骨/黑石）与一套调色板，整个会话固定。
  // 字面合成一柄左上贯穿到右下的斜剑，由同一光场点亮。
  const [glyph] = useState<GlyphVariant>(() => composeWithSword(pickGlyph(Math.random())));
  const [palette] = useState<Palette>(() => LINGXIAO_GOLD_PALETTE);

  // 光场几何随所选字体居中，避免换字后光偏出字外。
  const idle = buildIdleState(t, shimmerForGlyph(glyph));

  const maxWsLen = Math.max(20, width - 20);
  const displayWs = workspace.length > maxWsLen
    ? '...' + workspace.slice(-(maxWsLen - 3))
    : workspace;

  return (
    <Box flexDirection="column" alignItems="center" width={width}>
      {/* 块字 logo + 光场 */}
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        {glyph.rows.map((line, i) => (
          <Box key={i}>
            {renderGlyphLine(line, i, t, idle, palette)}
          </Box>
        ))}
      </Box>

      {/* 标题副行 */}
      <Box marginTop={1} justifyContent="center">
        <Text color={palette.accentHex} bold>{translate('tui.home.brand')}</Text>
        <Text color={tuiTheme.semantic.panel.divider}>{'  │  '}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{translate('tui.home.version_prefix')}{VERSION}</Text>
      </Box>

      {/* 轮播提示 */}
      <Box marginTop={1} justifyContent="center">
        <TipsRotator width={width - 8} />
      </Box>

      {/* 输入提示 */}
      <Box marginTop={1} justifyContent="center">
        <Text color={tuiTheme.semantic.panel.help}>
          {translate('tui.home.input_hint')}
        </Text>
      </Box>

      {/* 底部：workspace + model */}
      <Box marginTop={1} justifyContent="center">
        <Text color={tuiTheme.semantic.panel.help}>{displayWs}</Text>
        <Text color={tuiTheme.semantic.panel.divider}>{' │ '}</Text>
        <Text color={tuiTheme.semantic.text.accent}>{modelName}</Text>
      </Box>
    </Box>
  );
};
