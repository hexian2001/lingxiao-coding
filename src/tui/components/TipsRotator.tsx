/**
 * TipsRotator — rotating tips display, changes every 5 seconds
 */
import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { tuiTheme } from '../theme.js';
import { getList } from '../../i18n.js';

const TIP_ROTATE_INTERVAL_MS = 5000;

interface TipsRotatorProps {
  width?: number;
}

export const TipsRotator: React.FC<TipsRotatorProps> = ({ width }) => {
  const tips = getList('tui.tips');
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % (tips.length || 1));
    }, TIP_ROTATE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [tips.length]);

  const tip = tips[tipIndex] ?? '';
  const displayTip = width && tip.length > width - 6
    ? tip.slice(0, width - 9) + '...'
    : tip;

  return (
    <Text>
      <Text color={tuiTheme.semantic.panel.help}>{'> '}</Text>
      <Text color={tuiTheme.semantic.text.secondary} italic>{displayTip}</Text>
    </Text>
  );
};
