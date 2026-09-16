// Development-only visual fixtures. Vite removes this import from release builds.
import type { Entry, Favorite, Location, Server } from './core';
export const previewHome = '/Users/demo';
export const previewServer: Server = { id: 'preview', label: 'NAS（示例）', host: 'nas.local', port: 445, share: 'Public', username: '', domain: '', remember: false };
export const previewFavorites: Favorite[] = [
  { id: 'preview-local', label: '项目', location: { connection: null, path: '/Users/demo/Projects' } },
  { id: 'preview-nas', label: '工作文档', location: { connection: 'preview', path: '/工作文档' } },
];
const entry = (name: string, isDir: boolean, i: number): Entry => ({ name, isDir, size: isDir ? 0 : (i + 1) * 23784, modified: 1788829200 - i * 93000, isLink: false });
const local = ['Applications', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Projects', 'Public', 'Screenshots', 'Workspace'].map((name, i) => entry(name, true, i));
local.push(...['README.md', 'config.json', 'notes.txt', '项目说明.pdf'].map((name, i) => entry(name, false, i)));
const remote = ['Archive', 'Backup', 'Documents', 'Downloads', 'Media', 'Music', 'Photos', 'Projects', 'Public', 'Software', 'Team', 'Videos', '共享资料', '工作文档'].map((name, i) => entry(name, true, i));
remote.push(entry('readme.txt', false, 1));
export async function previewList(loc: Location): Promise<Entry[]> {
  if (loc.connection === 'preview') return loc.path === '/' ? remote : [entry('示例文件.txt', false, 1)];
  return loc.path === previewHome ? local : [entry('示例文档.md', false, 1), entry('示例图片.png', false, 2)];
}
