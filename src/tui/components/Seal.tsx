/**
 * Seal — 朱砂印（国风签名元件，Ink 版）。
 *
 * 朱砂底 + 暖金单字的静态印章。仅于英雄时刻（开场 / 完成 / 告别）克制部署 = 一点朱砂。
 * 不做闪烁/动画，保「不干扰」。char + 色取自 design/iconography.ts 单一事实源。
 */
import React from 'react';
import { Text } from 'ink';
import { SEAL_BG, SEAL_FG } from '../design/iconography.js';

interface SealProps {
  /** 印章字（如 凌 / 成 / 别）。单字最佳。 */
  char: string;
}

export const Seal: React.FC<SealProps> = ({ char }) => (
  <Text backgroundColor={SEAL_BG} color={SEAL_FG} bold>{` ${char} `}</Text>
);

export default Seal;
