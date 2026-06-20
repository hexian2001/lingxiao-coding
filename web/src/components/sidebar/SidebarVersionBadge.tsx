import { useEffect, useState } from 'react';
import { getServerToken } from '../../api/headers';

interface VersionCheckData {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes: string;
}

const VERSION_CHECK_TTL = 10 * 60 * 1000; // 10分钟缓存

let cachedVersion: { data: VersionCheckData; timestamp: number } | null = null;

async function fetchVersionCheck(): Promise<VersionCheckData> {
  if (cachedVersion && Date.now() - cachedVersion.timestamp < VERSION_CHECK_TTL) {
    return cachedVersion.data;
  }
  const res = await fetch('/api/v1/version/check', {
    headers: { 'x-lingxiao-token': getServerToken() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { data: VersionCheckData };
  cachedVersion = { data: json.data, timestamp: Date.now() };
  return json.data;
}

/**
 * 侧边栏版本号徽章
 *
 * 显示当前版本号 v1.0.0，如果有新版本则显示橙色小圆点提示。
 * 点击版本号或圆点可触发更新对话框（UpdateNotification 组件监听 CustomEvent）。
 */
export function SidebarVersionBadge() {
  const [versionInfo, setVersionInfo] = useState<VersionCheckData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchVersionCheck()
        .then((data) => {
          if (!cancelled) setVersionInfo(data);
        })
        .catch(() => {
          // 静默失败
        });
    }, 3000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const currentVersion = versionInfo?.current ?? '—';
  const hasUpdate = versionInfo?.hasUpdate ?? false;

  const handleClick = () => {
    if (hasUpdate) {
      // 触发 UpdateNotification 的更新对话框
      window.dispatchEvent(new CustomEvent('lingxiao:show-update-dialog'));
    }
  };

  return (
    <span
      className="inline-flex items-center gap-1.5 cursor-default"
      title={hasUpdate ? `新版本 v${versionInfo?.latest} 可用` : `当前版本 v${currentVersion}`}
      onClick={hasUpdate ? handleClick : undefined}
      role={hasUpdate ? 'button' : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-accent-green" />
      <span className="text-text-tertiary">v{currentVersion}</span>
      {hasUpdate && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-accent-yellow animate-pulse"
          title={`新版本 v${versionInfo?.latest} 可用，点击更新`}
        />
      )}
    </span>
  );
}
