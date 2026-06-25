import { DownloadStatus } from '../utils/downloader';
import { TwitterMedia } from './TwitterMedia';
import { TwitterPost } from './TwitterPost';

export interface DownloadTask {
  gid: string;
  post: TwitterPost;
  media: TwitterMedia;
  fileName: string;
  dir: string;
  totalSize: number;
  completeSize: number;
  status: DownloadStatus;
  error?: string;
  updatedAt: number;
  downloadUrl: string;
  downloadRetryCountRemains: number;
}
