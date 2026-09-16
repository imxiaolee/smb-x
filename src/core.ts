import { t as tr, language } from './i18n';
export interface Location {
    connection: string | null;
    path: string;
}
export interface Entry {
    name: string;
    isDir: boolean;
    size: number;
    modified: number | null;
    isLink: boolean;
}
export interface Server {
    id: string;
    label: string;
    host: string;
    port: number;
    share: string;
    username: string;
    domain: string;
    remember: boolean;
}
export interface Favorite {
    id: string;
    label: string;
    location: Location;
}
export interface Settings {
    servers: Server[];
    favorites: Favorite[];
}
export interface Task {
    id: string;
    name: string;
    source: Location;
    destination: Location;
    moving: boolean;
    status: string;
    done: number;
    total: number;
    speed: number;
    error: string | null;
    conflict: string | null;
    skipped: number;
}
export const terminal = (s: string) => ['success', 'skipped', 'failed', 'cancelled'].includes(s);
export const favoritesFor = (favorites: Favorite[], connection: string | null) => favorites.filter(f => f.location.connection === connection);
export const ROW_HEIGHT = 28;
export function resizeColumns(widths: number[], boundary: number, delta: number, minimums = [95, 58, 54, 90]) {
    if (widths.length !== 4 || boundary < 0 || boundary >= widths.length - 1)
        return [...widths];
    const resized = [...widths];
    const applied = Math.max(minimums[boundary] - widths[boundary], Math.min(delta, widths[boundary + 1] - minimums[boundary + 1]));
    resized[boundary] += applied;
    resized[boundary + 1] -= applied;
    return resized;
}
export function child(location: Location, name: string): Location {
    const separator = !location.connection && location.path.includes('\\') ? '\\' : '/';
    return { ...location, path: location.path.replace(/[\\/]$/, '') + separator + name };
}
export function parent(location: Location): Location {
    const path = location.path.replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(path))
        return { ...location, path: path + '\\' };
    const pos = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    let result = path.slice(0, Math.max(0, pos)) || '/';
    if (/^[A-Za-z]:$/.test(result))
        result += '\\';
    return { ...location, path: result };
}
export function sortEntries(entries: Entry[], key: 'name' | 'size' | 'modified' | 'type', direction = 1): Entry[] {
    return [...entries].sort((a, b) => {
        if (a.isDir !== b.isDir)
            return a.isDir ? -1 : 1;
        const diff = key === 'name' ? a.name.localeCompare(b.name, language === 'zh' ? 'zh-CN' : 'en-US', { numeric: true }) : key === 'type' ? type(a).localeCompare(type(b)) : (a[key] ?? 0) - (b[key] ?? 0);
        return direction * (diff || a.name.localeCompare(b.name, language === 'zh' ? 'zh-CN' : 'en-US', { numeric: true }));
    });
}
export const type = (e: Entry) => e.isLink ? tr("符号链接") : e.isDir ? tr("文件夹") : e.name.includes('.') ? e.name.split('.').pop()!.toUpperCase() + tr(" 文件") : tr("文件");
export function bytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0)
        return '0 B';
    const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}
export function virtualRange(scroll: number, height: number, count: number) {
    const start = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 8);
    return { start, end: Math.min(count, Math.ceil((scroll + height) / ROW_HEIGHT) + 8) };
}
export function address(loc: Location, servers: Server[]) {
    const s = servers.find(s => s.id === loc.connection);
    if (!loc.connection)
        return loc.path;
    if (!s)
        return `smb://?${loc.path}`;
    const host = s.host.includes(':') && !s.host.startsWith('[') ? `[${s.host}]` : s.host;
    return `smb://${host}${s.port === 445 ? '' : ':' + s.port}/${encodeURIComponent(s.share)}${loc.path.split('/').map(encodeURIComponent).join('/')}`;
}
export function parseAddress(value: string, servers: Server[], home: string): Location {
    const v = value.trim();
    if (v.startsWith('smb://')) {
        const u = new URL(v);
        if (u.username || u.password || u.search || u.hash)
            throw new Error(tr("地址中不要包含密码、查询参数或片段"));
        const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const server = servers.find(s => s.host.replace(/^\[|\]$/g, '').toLowerCase() === u.hostname.replace(/^\[|\]$/g, '').toLowerCase() && s.port === Number(u.port || 445) && s.share.toLowerCase() === parts[0]?.toLowerCase());
        if (!server)
            throw new Error(tr("请先通过「连接服务器」添加此共享"));
        return { connection: server.id, path: '/' + parts.slice(1).join('/') };
    }
    if (v === '~')
        return { connection: null, path: home };
    if (v.startsWith('~/'))
        return { connection: null, path: child({ connection: null, path: home }, v.slice(2)).path };
    if (!v.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(v))
        throw new Error(tr("请输入绝对路径或 smb://服务器/共享/目录"));
    return { connection: null, path: v };
}
