/**
 * useAnimation — 30fps 单调时钟，驱动 HomeScreen 的光场采样。
 *
 * 旧版维护 position + colorMap 的剑光引擎；新版只暴露一个单调递增的
 * 帧时间戳 t（ms），组件用它直接采样 LightField。状态最小化，渲染层
 * 决定如何把 t 映射成颜色。
 */

import { useState, useEffect, useRef } from 'react';

/** 帧间隔 ~125ms ≈ 8fps。
 * Ink 每帧要重画上千个着色 cell，帧率过高会让终端渲染器跟不上、出现撕裂/乱码。
 * 8fps 已足够表现柔和呼吸与缓慢扫光，且渲染稳定。 */
export const FRAME_INTERVAL_MS = 125;

export interface UseAnimationResult {
  /** 当前帧的单调时钟（ms），从 hook 挂载起算 */
  t: number;
  /** 动画是否在跑 */
  active: boolean;
}

/**
 * 运行 30fps 动画时钟。
 * @param enabled 是否运行（false 时暂停并清理 timer）
 */
export function useAnimation(enabled: boolean = true): UseAnimationResult {
  const [t, setT] = useState(0);
  const startRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    startRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      const start = startRef.current ?? Date.now();
      setT(Date.now() - start);
    }, FRAME_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled]);

  return { t, active: enabled };
}
