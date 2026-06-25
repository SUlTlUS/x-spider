import { usePollSystemProxyUrl } from './background-tasks/usePollSystemProxyUrl';
import { useDownloadEngineBinding } from './background-tasks/useDownloadEngineBinding';
import { useTaskNotifications } from './background-tasks/useTaskNotifications';
import { useAutoCheckUpdate } from './background-tasks/useAutoCheckUpdate';

export function useRunBackgroundTasks() {
  useTaskNotifications();
  useAutoCheckUpdate();
  usePollSystemProxyUrl();
  useDownloadEngineBinding();
}
