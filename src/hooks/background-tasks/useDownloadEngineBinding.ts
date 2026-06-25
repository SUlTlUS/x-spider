import { useEffect } from 'react';
import { useResolvedProxyUrl } from '../useResolvedProxyUrl';
import { downloadEngine } from '../../utils/downloader';
import { useDownloadStore } from '../../stores/download';
import { useSettingsStore } from '../../stores/settings';

export function useDownloadEngineBinding() {
  const proxyUrl = useResolvedProxyUrl();
  const proxyEnabled = useSettingsStore((state) => state.proxy.enable);

  useEffect(() => {
    downloadEngine.updateProxy(proxyEnabled, proxyUrl);
  }, [proxyEnabled, proxyUrl]);

  const { syncDownloadTaskStatus } = useDownloadStore((state) => ({
    syncDownloadTaskStatus: state.syncDownloadTaskStatus,
  }));

  useEffect(() => {
    async function onDownloadStatusChanged(gid: string) {
      await syncDownloadTaskStatus(gid);
    }

    const unlistenComplete = downloadEngine.onDownloadComplete.listen(
      onDownloadStatusChanged,
    );
    const unlistenError = downloadEngine.onDownloadError.listen(
      onDownloadStatusChanged,
    );
    const unlistenPause = downloadEngine.onDownloadPause.listen(
      onDownloadStatusChanged,
    );
    const unlistenStart = downloadEngine.onDownloadStart.listen(
      onDownloadStatusChanged,
    );
    const unlistenStop = downloadEngine.onDownloadStop.listen(
      onDownloadStatusChanged,
    );

    return () => {
      unlistenComplete();
      unlistenError();
      unlistenPause();
      unlistenStart();
      unlistenStop();
    };
  }, [syncDownloadTaskStatus]);
}
