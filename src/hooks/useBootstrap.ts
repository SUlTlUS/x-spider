import { useEffect, useState } from 'react';
import { downloadEngine } from '../utils/downloader';

export function useBootstrap() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      interface BootConfig {
        name: string;
        fn: () => Promise<void>;
      }
      const flows: BootConfig[] = [
        {
          name: 'download',
          async fn() {
            try {
              await downloadEngine.bootstrap();
            } catch (err) {
              log.error(err);
              throw new Error('启动下载引擎失败');
            }
          },
        },
      ];

      for (const item of flows) {
        try {
          log.info(`Boot ${item.name}`);
          await item.fn();
        } catch (err: any) {
          log.error(`UI Boot error name=${item.name}`, err);
          setError(typeof err === 'string' ? err : err?.message);
          return;
        }
      }

      setReady(true);
    })();
  }, []);

  return { ready, error };
}
