import { t as tr, preference, saveLanguage, language, localizeError, type Language } from './i18n';
import './style.css';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { createElement, Folder, File, Server as ServerIcon, HardDrive, ArrowLeft, ArrowRight, ArrowUp, RefreshCw, Plus, Star, X, MoreHorizontal, ArrowRightLeft, CircleCheck, Check, CircleAlert, LoaderCircle, Copy, Trash2, Pencil, FolderPlus, Download, Link, Settings2 } from 'lucide';
import { type Location, type Entry, type Settings, type Server, type Task, child, parent, sortEntries, type, bytes, virtualRange, address, parseAddress, terminal, favoritesFor, resizeColumns, ROW_HEIGHT } from './core';
const icons = { Folder, File, ServerIcon, HardDrive, ArrowLeft, ArrowRight, ArrowUp, RefreshCw, Plus, Star, X, MoreHorizontal, ArrowRightLeft, CircleCheck, Check, CircleAlert, LoaderCircle, Copy, Trash2, Pencil, FolderPlus, Download, Link, Settings2 };
type Icon = keyof typeof icons;
function icon(name: Icon) { const el = createElement(icons[name]); el.setAttribute('aria-hidden', 'true'); return el; }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] { const e = document.createElement(tag); e.className = cls; if (text !== undefined)
    e.textContent = text; return e; }
function button(label: string, symbol?: Icon, run?: () => void, cls = '') {
    const b = el('button', cls);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (symbol)
        b.append(icon(symbol));
    if (!symbol || cls.includes('text-button'))
        b.append(el('span', '', label));
    if (run)
        b.onclick = run;
    return b;
}
let settings: Settings = { servers: [], favorites: [] };
let home = '/';
let active = 0;
let tasks: Task[] = [];
let clipboard: {
    sources: Location[];
    moving: boolean;
} | null = null;
let drag: {
    pane: number;
    sources: Location[];
} | null = null;
const app = document.querySelector<HTMLDivElement>('#app')!;
const main = el('main', 'main');
const panesEl = el('div', 'panes');
const queue = el('section', 'queue');
const taskList = el('div', 'task-list');
const queueButton = button(tr("传输队列"), 'ArrowRightLeft', () => setQueue(queue.hidden), 'queue-button');
const queueBadge = el('span', 'queue-badge', '0');
queueBadge.hidden = true;
queueButton.append(queueBadge);
const toast = el('div', 'toast');
toast.setAttribute('role', 'status');
toast.hidden = true;
let toastTimer = 0;
function message(text: string) { toast.textContent = text; toast.hidden = false; window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.hidden = true, 8000); }
document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
async function showSettings() {
    const languages = el('label', 'settings-language-row');
    languages.append(el('span', '', tr('语言')));
    const control = el('span', 'settings-language-control');
    const select = el('select');
    select.name = 'language';
    for (const [value, name] of [['system', tr('跟随系统')], ['zh', '简体中文'], ['en', 'English']]) {
        const option = el('option', '', name);
        option.value = value;
        select.append(option);
    }
    select.value = preference();
    control.append(select);
    languages.append(control);
    const result = await dialog(tr('设置'), tr('选择界面语言，当前浏览位置会保留。'), [languages], [{ label: tr('应用'), value: 'apply' }], 'settings-dialog');
    if (!result) return;
    const next = result.data.get('language') as Language;
    if (next === preference()) return;
    try {
        sessionStorage.setItem('smbx-language-session', JSON.stringify({ locations: panes.map(p => p.location), active, queue: !queue.hidden }));
        saveLanguage(next);
        // Reload only the webview. Rust owns transfers and SMB sessions, which keep running.
        window.location.reload();
    } catch (e) { message(tr('语言设置保存失败：{0}', String(e))); }
}
async function restoreLanguageSession() {
    try {
        const raw = sessionStorage.getItem('smbx-language-session'); sessionStorage.removeItem('smbx-language-session');
        if (!raw) return;
        const snapshot = JSON.parse(raw);
        if (Array.isArray(snapshot.locations)) await Promise.all(panes.map((pane, i) => {
            const loc = snapshot.locations[i];
            return loc && typeof loc.path === 'string' && (loc.connection === null || settings.servers.some(s => s.id === loc.connection)) ? pane.navigate(loc) : Promise.resolve();
        }));
        panes[snapshot.active === 1 ? 1 : 0].activate(); setQueue(snapshot.queue === true);
    } catch { /* Ignore an invalid or unavailable temporary UI snapshot. */ }
}
async function attempt(work: () => Promise<unknown>) { try {
    await work();
}
catch (e) {
    message(String(e));
} }
let previewList: ((loc: Location) => Promise<Entry[]>) | null = null;
const ipc = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (isTauri())
        return invoke<T>(cmd, args).catch(error => Promise.reject(localizeError(String(error))));
    if (cmd === 'list' && previewList)
        return previewList(args!.location as Location) as Promise<T>;
    if (cmd === 'rename_server') {
        const server = settings.servers.find(server => server.id === args!.id);
        if (server)
            server.label = String(args!.label).trim();
        return Promise.resolve(settings as T);
    }
    if (cmd === 'forget_server')
        return Promise.resolve(undefined as T);
    if (cmd === 'update_server')
        return Promise.resolve(args!.server as T);
    return Promise.reject(new Error(tr("界面预览使用示例文件；请用 npm run tauri dev 启动桌面版进行真实操作")));
};
let modalOpen = false;
function dialog(title: string, detail: string, fields: HTMLElement[], actions: {
    label: string;
    value: string;
    danger?: boolean;
}[], cls = ''): Promise<{
    value: string;
    data: FormData;
} | null> {
    if (modalOpen)
        return Promise.resolve(null);
    modalOpen = true;
    return new Promise(resolve => {
        const d = el('dialog', cls);
        d.tabIndex = -1;
        const f = el('form');
        f.method = 'dialog';
        f.append(el('h2', '', title), el('p', 'dialog-detail', detail), ...fields);
        const footer = el('div', 'dialog-actions');
        footer.append(button(tr("取消"), undefined, () => finish(null), 'secondary'));
        for (const a of actions) {
            const b = button(a.label, undefined, undefined, a.danger ? 'danger' : 'primary');
            b.type = 'submit';
            b.value = a.value;
            footer.append(b);
        }
        f.append(footer);
        d.append(f);
        document.body.append(d);
        d.showModal();
        const finish = (result: {
            value: string;
            data: FormData;
        } | null) => { d.close(); d.remove(); modalOpen = false; resolve(result); };
        f.onsubmit = e => { e.preventDefault(); finish({ value: (e.submitter as HTMLButtonElement)?.value || actions[0].value, data: new FormData(f) }); };
        d.oncancel = e => { e.preventDefault(); finish(null); };
        const firstInput = cls === 'settings-dialog' ? null : f.querySelector<HTMLInputElement | HTMLSelectElement>('input:not([type=checkbox]), select');
        if (firstInput) firstInput.focus(); else d.focus({ preventScroll: true });
    });
}
function field(label: string, name: string, value = '', inputType = 'text', required = false) {
    const wrap = el('label', inputType === 'checkbox' ? 'check-field' : 'field');
    const input = el('input');
    input.name = name;
    input.type = inputType;
    input.required = required;
    input.autocomplete = inputType === 'password' ? 'new-password' : 'off';
    if (inputType === 'checkbox')
        input.checked = value === 'true';
    else
        input.value = value;
    if (name === 'port') {
        input.min = '1';
        input.max = '65535';
    }
    if (inputType === 'checkbox')
        wrap.append(input, el('span', '', label));
    else
        wrap.append(el('span', '', label), input);
    return wrap;
}
async function chooseShare(server: Server, password: string | null): Promise<string | null> {
    message(tr("正在读取共享列表…"));
    let shares: string[] = [];
    let detail = tr("选择要连接的共享，或手动输入共享名称。访问权限将在连接时检查。");
    try {
        shares = await ipc<string[]>('list_shares', { server, password });
        if (!shares.length) detail = tr("服务器未返回可见的文件共享，请手动输入共享名称。");
    } catch (error) {
        detail = tr("无法读取共享列表，请手动输入共享名称。错误：{0}", localizeError(String(error)));
    }
    toast.hidden = true;
    const fields: HTMLElement[] = [];
    const manual = field(tr("手动输入共享名称"), 'manualShare', '', 'text', true);
    const input = manual.querySelector('input')!;
    if (shares.length) {
        const wrap = el('label', 'field');
        const select = el('select');
        select.name = 'selectedShare';
        const placeholder = el('option', '', tr("请选择共享"));
        placeholder.value = '';
        select.append(placeholder);
        for (const name of shares) {
            const option = el('option', '', name);
            option.value = name;
            select.append(option);
        }
        select.onchange = () => { input.value = select.value; };
        input.oninput = () => { select.value = input.value; };
        wrap.append(el('span', '', tr("服务器共享")), select);
        fields.push(wrap);
    }
    fields.push(manual);
    const answer = await dialog(tr("选择共享"), detail, fields, [{ label: tr("确认"), value: 'select' }]);
    return answer ? String(answer.data.get('manualShare') || '').trim() || null : null;
}
async function connectServer(existing?: Server, editing = false) {
    const selectedPane = active;
    const fields = [field(tr("显示名称"), 'label', existing?.label || ''), field(tr("服务器地址"), 'host', existing?.host || '', 'text', true), field(tr("端口"), 'port', String(existing?.port || 445), 'number', true), field(tr("共享名称（可选）"), 'share', existing?.share || ''), field(tr("用户名"), 'username', existing?.username || ''), field(tr("密码"), 'password', '', 'password'), field(tr("Domain（可选）"), 'domain', existing?.domain || ''), field(tr("将密码保存到系统钥匙串 / 凭据管理器"), 'remember', String(existing?.remember ?? true), 'checkbox')];
    fields[3].querySelector('input')!.placeholder = tr("留空以获取共享列表");
    const grid = el('div', 'form-grid');
    grid.append(...fields);
    const detail = (editing ? tr("保存连接配置，下次访问时生效。密码留空保留原密码。") : tr("使用 SMB2 / SMB3 连接 NAS 或文件服务器。连接信息会保存到侧栏。")) + tr(" 共享名称留空时，会先连接服务器获取共享列表。");
    if (editing)
        fields[0].querySelector('input')!.readOnly = true;
    const answer = await dialog(editing ? tr("编辑连接") : existing ? tr("连接共享") : tr("连接服务器"), detail + (!editing && existing?.remember ? tr(" 密码留空时使用系统安全存储中的密码。") : ''), [grid], [{ label: editing ? tr("保存") : tr("连接"), value: editing ? 'save' : 'connect' }]);
    if (!answer)
        return;
    const get = (name: string) => String(answer.data.get(name) || '');
    const server: Server = { id: existing?.id || '', label: get('label') || get('host'), host: get('host').trim(), port: Number(get('port')), share: get('share').trim(), username: get('username'), domain: get('domain'), remember: answer.data.has('remember') };
    if (!server.share) {
        const share = await chooseShare(server, !get('password') && (editing || existing?.remember) ? null : get('password'));
        if (!share) return;
        server.share = share;
    }
    if (editing) {
        await attempt(async () => {
            const saved = await ipc<Server>('update_server', { server, password: get('password') || null });
            settings.servers = settings.servers.map(s => s.id === saved.id ? saved : s);
            for (const pane of panes.filter(p => p.location.connection === saved.id)) {
                ++pane.request;
                pane.busy = false;
                pane.root.classList.remove('is-loading');
                pane.location = { connection: saved.id, path: '/' };
                pane.entries = [];
                pane.selection.clear();
                pane.history = [{ ...pane.location }];
                pane.index = 0;
                pane.back.disabled = true;
                pane.forward.disabled = true;
                pane.pathInput.value = address(pane.location, settings.servers);
                pane.resort();
                pane.loading.textContent = tr("连接配置已保存，刷新或选择目录后连接。");
                pane.loading.hidden = false;
            }
            renderPlaces();
            renderTasks();
            message(tr("连接配置已保存"));
        });
        return;
    }
    message(tr("正在连接服务器\u2026"));
    await attempt(async () => {
        const saved = await ipc<Server>('connect', { server, password: !get('password') && existing?.remember ? null : get('password') });
        settings.servers = settings.servers.filter(s => s.id !== saved.id).concat(saved);
        renderPlaces();
        await panes[selectedPane].navigate({ connection: saved.id, path: '/' });
        message(tr("已连接 {0}", saved.label));
    });
}
function renderPlaces() { for (const pane of panes)
    pane.renderPlaces(); }
async function removeFavorite(favorite: Settings['favorites'][number]) {
    settings = await ipc<Settings>('favorite', { favorite, remove: true });
    renderPlaces();
}
async function removeServer(server: Server) {
    await ipc('forget_server', { id: server.id });
    settings.servers = settings.servers.filter(s => s.id !== server.id);
    settings.favorites = settings.favorites.filter(f => f.location.connection !== server.id);
    await Promise.all(panes.filter(p => p.location.connection === server.id).map(p => p.navigate({ connection: null, path: home })));
    renderPlaces();
}
async function forgetServer(server: Server) {
    if (await confirm(tr("移除连接"), tr("移除 {0} 及其收藏和已保存密码？", server.label)))
        await removeServer(server);
}
function manageServers() {
    if (modalOpen)
        return;
    modalOpen = true;
    const d = el('dialog', 'connection-manager');
    const shell = el('div', 'connection-manager-shell');
    const heading = el('div', 'connection-manager-heading');
    const headingText = el('div');
    headingText.append(el('h2', '', tr("连接管理")), el('p', '', tr("编辑连接信息，或移除不再使用的服务器。")));
    const closeButton = button(tr("关闭连接管理"), 'X');
    heading.append(headingText, closeButton);
    const list = el('div', 'connection-list');
    let removing: string | null = null;
    const finish = () => { d.close(); d.remove(); modalOpen = false; };
    const render = () => {
        list.replaceChildren();
        if (!settings.servers.length)
            list.append(el('div', 'connection-empty', tr("尚未添加服务器连接")));
        for (const server of settings.servers) {
            const row = el('div', 'connection-row');
            const glyph = el('span', 'connection-glyph');
            glyph.append(icon('ServerIcon'));
            const content = el('div', 'connection-content');
            const actions = el('div', 'connection-actions');
            {
                const nameRow = el('div', 'connection-name-editor');
                const input = el('input');
                input.value = server.label;
                input.maxLength = 80;
                input.setAttribute('aria-label', tr("连接显示名称"));
                const fitName = () => { const units = [...input.value].reduce((n, char) => n + (/[^\u0000-\u00ff]/.test(char) ? 2 : 1), 0); nameRow.style.width = `${Math.min(26, Math.max(12, units + 6))}ch`; };
                fitName();
                const saveName = button(tr("保存显示名称"), 'Check', undefined, 'connection-name-save');
                const status = el('span', 'connection-name-status');
                status.setAttribute('role', 'status');
                const save = async () => {
                    const label = input.value.trim();
                    if (!label) {
                        status.textContent = tr("显示名称不能为空");
                        input.focus();
                        return;
                    }
                    if (saveName.disabled)
                        return;
                    const controls = [...d.querySelectorAll<HTMLButtonElement>('button')];
                    controls.forEach(b => b.disabled = true);
                    input.readOnly = true;
                    try {
                        settings = await ipc<Settings>('rename_server', { id: server.id, label });
                        server.label = label;
                        input.value = label;
                        renderPlaces();
                        renderTasks();
                        status.textContent = tr("名称已保存");
                    }
                    catch (e) {
                        status.textContent = String(e);
                    }
                    finally {
                        controls.forEach(b => b.disabled = false);
                        input.readOnly = false;
                    }
                };
                input.oninput = () => { status.textContent = ''; fitName(); };
                input.onkeydown = e => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        void save();
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        input.value = server.label;
                        fitName();
                        status.textContent = '';
                        input.blur();
                    }
                };
                saveName.onclick = () => void save();
                nameRow.append(input, saveName);
                content.append(nameRow, status, el('span', 'connection-endpoint', `${server.host}:${server.port} / ${server.share}`));
                if (removing === server.id) {
                    content.append(el('span', 'connection-remove-note', tr("同时移除此连接的收藏和已保存密码")));
                    actions.append(button(tr("确认移除"), undefined, () => void (async () => {
                        try {
                            await removeServer(server);
                            removing = null;
                            render();
                            message(tr("已移除连接 {0}", server.label));
                        }
                        catch (e) {
                            message(String(e));
                        }
                    })(), 'danger connection-action'), button(tr("取消"), undefined, () => { removing = null; render(); }, 'secondary connection-action'));
                }
                else {
                    actions.append(button(tr("编辑"), undefined, () => { finish(); void connectServer(server, true).finally(manageServers); }, 'secondary connection-action'), button(tr("移除"), undefined, () => { removing = server.id; render(); }, 'connection-remove connection-action'));
                }
            }
            row.append(glyph, content, actions);
            list.append(row);
        }
    };
    const footer = el('div', 'connection-manager-footer');
    footer.append(button(tr("添加连接"), 'Plus', () => { finish(); void connectServer(); }, 'primary text-button'), button(tr("完成"), undefined, finish, 'secondary'));
    closeButton.onclick = finish;
    d.oncancel = e => { e.preventDefault(); finish(); };
    shell.append(heading, list, footer);
    d.append(shell);
    document.body.append(d);
    render();
    d.tabIndex = -1;
    d.showModal();
    d.focus({ preventScroll: true });
}
async function confirm(title: string, detail: string) { return !!await dialog(title, detail, [], [{ label: tr("确认"), value: 'yes', danger: true }]); }
function menu(x: number, y: number, actions: {
    label: string;
    run: () => void;
    disabled?: boolean;
}[]) {
    document.querySelector('.context-menu')?.remove();
    const m = el('div', 'context-menu');
    m.setAttribute('role', 'menu');
    for (const a of actions) {
        const b = button(a.label, undefined, () => { m.remove(); a.run(); });
        b.disabled = !!a.disabled;
        b.setAttribute('role', 'menuitem');
        m.append(b);
    }
    document.body.append(m);
    m.style.left = `${Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 8))}px`;
    const close = (e: Event) => { if (!m.contains(e.target as Node)) {
        m.remove();
        document.removeEventListener('pointerdown', close);
    } };
    document.addEventListener('pointerdown', close);
    m.querySelector('button')?.focus();
}
class Pane {
    root = el('section', 'pane');
    viewport = el('div', 'viewport');
    space = el('div', 'list-space');
    rows = el('div', 'rows');
    pathInput = el('input', 'address');
    addressBar = el('div', 'address-bar');
    breadcrumbs = el('div', 'breadcrumbs');
    subtitle = el('span', 'pane-subtitle');
    counter = el('div', 'pane-footer');
    loading = el('div', 'pane-message');
    sourceSwitch = button(tr("切换本机或服务器"), 'HardDrive', () => this.showSources(), 'source-switch text-button');
    sourceFavorites = el('div', 'source-favorites');
    editSource = button(tr("编辑当前连接"), 'Settings2', () => this.editCurrentServer(), 'edit-source');
    favoriteButton = button(tr("收藏当前目录"), 'Star', () => void this.favorite(), 'favorite-current');
    back = button(tr("后退"), 'ArrowLeft', () => void this.travel(-1));
    forward = button(tr("前进"), 'ArrowRight', () => void this.travel(1));
    entries: Entry[] = [];
    sorted: Entry[] = [];
    selection = new Set<string>();
    anchor = 0;
    request = 0;
    busy = false;
    location: Location = { connection: null, path: '/' };
    history: Location[] = [];
    index = -1;
    sort: 'name' | 'size' | 'modified' | 'type' = 'name';
    direction = 1;
    constructor(public id: number) {
        const heading = el('div', 'pane-heading');
        this.sourceSwitch.oncontextmenu = e => { e.preventDefault(); this.showSourceActions(e.clientX, e.clientY); };
        heading.append(this.sourceSwitch, this.editSource, el('span', 'toolbar-divider'), this.sourceFavorites, el('div', 'toolbar-space'), this.favoriteButton, button(tr("更多操作"), 'MoreHorizontal', () => { const r = heading.getBoundingClientRect(); menu(r.right - 230, r.bottom, this.actions()); }));
        const nav = el('form', 'navigation');
        this.pathInput.setAttribute('aria-label', id === 0 ? tr("左栏路径") : tr("右栏路径"));
        this.pathInput.spellcheck = false;
        this.pathInput.hidden = true;
        this.addressBar.tabIndex = 0;
        this.addressBar.setAttribute('aria-label', this.pathInput.getAttribute('aria-label')!);
        this.addressBar.append(this.breadcrumbs, this.pathInput);
        // A pointer click may focus the container before the breadcrumb receives
        // its click (notably in WebKit). Focus alone must never hide the buttons.
        this.addressBar.onclick = e => {
            if (e.target === this.addressBar || e.target === this.breadcrumbs) this.editAddress();
        };
        this.addressBar.onkeydown = e => {
            if (e.target === this.addressBar && (e.key === 'Enter' || e.key === 'F2')) {
                e.preventDefault(); e.stopPropagation(); this.editAddress();
            }
        };
        this.pathInput.onblur = () => this.renderAddress();
        this.pathInput.onkeydown = e => {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                this.renderAddress(); this.viewport.focus();
            }
        };
        nav.append(this.back, this.forward, button(tr("上级目录"), 'ArrowUp', () => void this.navigate(parent(this.location))), this.addressBar, button(tr("刷新"), 'RefreshCw', () => void this.refresh()));
        nav.onsubmit = e => { e.preventDefault(); void attempt(async () => {
            const location = parseAddress(this.pathInput.value, settings.servers, home);
            this.renderAddress(); this.viewport.focus();
            await this.navigate(location);
        }); };
        const columns = el('div', 'columns');
        const definitions = [['name', tr("名称")], ['type', tr("类型")], ['size', tr("大小")], ['modified', tr("修改时间")]] as const;
        for (const [columnIndex, [key, label]] of definitions.entries()) {
            const b = button(label, undefined, () => { this.direction = this.sort === key ? -this.direction : 1; this.sort = key; this.resort(); columns.querySelectorAll('button').forEach(x => x.removeAttribute('data-sort')); b.dataset.sort = this.direction === 1 ? '↑' : '↓'; });
            if (key === 'name')
                b.dataset.sort = '↑';
            columns.append(b);
            if (columnIndex < definitions.length - 1) {
                const nextLabel = definitions[columnIndex + 1][1];
                const separator = el('span', 'column-resizer');
                separator.tabIndex = 0;
                separator.setAttribute('role', 'separator');
                separator.setAttribute('aria-orientation', 'vertical');
                separator.setAttribute('aria-label', tr("调整{0}和{1}列宽", label, nextLabel));
                separator.title = tr("拖动调整列宽，双击恢复默认宽度");
                separator.onclick = e => e.stopPropagation();
                separator.ondblclick = e => { e.preventDefault(); e.stopPropagation(); this.resetColumnWidths(); };
                separator.onkeydown = e => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
                        return;
                    e.preventDefault();
                    e.stopPropagation();
                    const widths = Array.from(columns.children).map(column => column.getBoundingClientRect().width);
                    this.applyColumnWidths(resizeColumns(widths, columnIndex, e.key === 'ArrowRight' ? 8 : -8));
                };
                separator.onpointerdown = e => {
                    if (e.button !== 0)
                        return;
                    e.preventDefault();
                    e.stopPropagation();
                    const startX = e.clientX;
                    const widths = Array.from(columns.children).map(column => column.getBoundingClientRect().width);
                    const move = (event: PointerEvent) => this.applyColumnWidths(resizeColumns(widths, columnIndex, event.clientX - startX));
                    const finish = () => {
                        document.removeEventListener('pointermove', move);
                        document.removeEventListener('pointerup', finish);
                        document.removeEventListener('pointercancel', finish);
                        document.body.classList.remove('column-resizing');
                    };
                    document.body.classList.add('column-resizing');
                    document.addEventListener('pointermove', move);
                    document.addEventListener('pointerup', finish);
                    document.addEventListener('pointercancel', finish);
                };
                b.append(separator);
            }
        }
        this.viewport.tabIndex = 0;
        this.viewport.setAttribute('role', 'listbox');
        this.viewport.setAttribute('aria-label', id === 0 ? tr("左栏文件") : tr("右栏文件"));
        this.viewport.setAttribute('aria-multiselectable', 'true');
        this.space.append(this.rows);
        this.viewport.append(this.space);
        this.viewport.onscroll = () => this.renderRows();
        new ResizeObserver(() => this.renderRows()).observe(this.viewport);
        this.viewport.onclick = e => { if (!(e.target as HTMLElement).closest('.file-row')) {
            this.selection.clear();
            this.renderRows();
        } };
        this.viewport.oncontextmenu = e => { e.preventDefault(); this.activate(); menu(e.clientX, e.clientY, this.actions()); };
        this.viewport.ondragover = e => { if (drag && drag.pane !== this.id && !this.busy) {
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'copy';
            this.root.classList.add('drop-target');
        } };
        this.viewport.ondragleave = e => { if (!this.viewport.contains(e.relatedTarget as Node))
            this.root.classList.remove('drop-target'); };
        this.viewport.ondrop = e => {
            e.preventDefault();
            this.root.classList.remove('drop-target');
            if (!drag || drag.pane === this.id || this.busy)
                return;
            const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row');
            const entry = row ? this.sorted[Number(row.dataset.index)] : undefined;
            const target = entry?.isDir ? child(this.location, entry.name) : this.location;
            void transfer(drag.sources, target, false);
            drag = null;
        };
        this.root.onpointerdown = () => this.activate();
        this.loading.setAttribute('role', 'status');
        this.loading.hidden = true;
        this.root.append(heading, nav, columns, this.viewport, this.loading, this.counter);
        this.renderPlaces();
        this.activate();
    }
    applyColumnWidths(widths: number[]) {
        this.root.style.setProperty('--column-type', `${widths[1]}px`);
        this.root.style.setProperty('--column-size', `${widths[2]}px`);
        this.root.style.setProperty('--column-modified', `${widths[3]}px`);
    }
    resetColumnWidths() {
        this.root.style.removeProperty('--column-type');
        this.root.style.removeProperty('--column-size');
        this.root.style.removeProperty('--column-modified');
    }
    activate() { active = this.id; document.querySelectorAll('.pane').forEach((p, i) => p.classList.toggle('active', i === active)); }
    showSources() {
        this.activate();
        const r = this.sourceSwitch.getBoundingClientRect();
        const actions: {
            label: string;
            run: () => void;
        }[] = [{ label: tr("本机"), run: () => void this.navigate({ connection: null, path: home }) }];
        for (const server of settings.servers)
            actions.push({ label: server.label, run: () => void attempt(async () => { if (!server.remember)
                    await connectServer(server);
                else
                    await this.navigate({ connection: server.id, path: '/' }); }) });
        actions.push({ label: tr("管理连接\u2026"), run: manageServers });
        menu(r.left, r.bottom, actions);
    }
    showSourceActions(x: number, y: number) {
        const server = settings.servers.find(s => s.id === this.location.connection);
        if (!server)
            return;
        menu(x, y, [{ label: tr("编辑 / 重新连接"), run: () => void connectServer(server) }, { label: tr("移除此连接和已存密码"), run: () => void attempt(() => forgetServer(server)) }]);
    }
    editCurrentServer() {
        const server = settings.servers.find(s => s.id === this.location.connection);
        if (server)
            void connectServer(server);
    }
    renderPlaces() {
        if (this.pathInput.hidden) this.renderAddress();
        const server = settings.servers.find(s => s.id === this.location.connection);
        const label = server?.label || tr("本机");
        this.sourceSwitch.replaceChildren(icon(server ? 'ServerIcon' : 'HardDrive'), el('span', '', label));
        this.sourceSwitch.title = tr("切换位置 \u00B7 当前：{0}", label);
        this.sourceSwitch.setAttribute('aria-label', this.sourceSwitch.title);
        this.editSource.hidden = !server;
        this.sourceFavorites.replaceChildren();
        if (!server) {
            const builtIns: [
                string,
                Location
            ][] = [[tr("主目录"), { connection: null, path: home }], [tr("下载"), child({ connection: null, path: home }, 'Downloads')], [tr("桌面"), child({ connection: null, path: home }, 'Desktop')]];
            for (const [name, location] of builtIns)
                this.sourceFavorites.append(button(name, name === tr("主目录") ? 'HardDrive' : 'Folder', () => void this.navigate(location), 'place text-button'));
        }
        for (const favorite of favoritesFor(settings.favorites, this.location.connection)) {
            const wrap = el('span', 'favorite-place');
            const go = button(favorite.label, undefined, () => void this.navigate(favorite.location), 'place text-button');
            go.title = address(favorite.location, settings.servers);
            go.oncontextmenu = e => { e.preventDefault(); menu(e.clientX, e.clientY, [{ label: tr("取消收藏"), run: () => void attempt(() => removeFavorite(favorite)) }]); };
            wrap.append(go, button(tr("取消收藏 {0}", favorite.label), 'X', () => void attempt(() => removeFavorite(favorite)), 'favorite-remove'));
            this.sourceFavorites.append(wrap);
        }
        const currentFavorite = settings.favorites.some(f => f.location.connection === this.location.connection && f.location.path === this.location.path);
        this.favoriteButton.classList.toggle('is-favorite', currentFavorite);
        this.favoriteButton.title = currentFavorite ? tr("取消收藏当前目录") : tr("收藏当前目录");
        this.favoriteButton.setAttribute('aria-label', this.favoriteButton.title);
    }
    async navigate(loc: Location, historyIndex?: number, refresh = false) {
        const request = ++this.request;
        this.busy = true;
        this.loading.hidden = false;
        this.loading.textContent = tr("正在读取目录\u2026");
        this.root.classList.add('is-loading');
        try {
            const entries = await ipc<Entry[]>('list', { location: loc });
            if (request !== this.request)
                return;
            this.location = { ...loc };
            this.entries = entries;
            this.selection.clear();
            if (historyIndex !== undefined)
                this.index = historyIndex;
            else if (!refresh) {
                this.history = this.history.slice(0, this.index + 1);
                this.history.push({ ...loc });
                this.index++;
            }
            this.pathInput.value = address(loc, settings.servers);
            this.renderAddress();
            this.subtitle.textContent = loc.connection ? settings.servers.find(s => s.id === loc.connection)?.label || 'SMB' : tr("本机");
            this.renderPlaces();
            this.back.disabled = this.index <= 0;
            this.forward.disabled = this.index >= this.history.length - 1;
            this.viewport.scrollTop = 0;
            this.anchor = 0;
            this.resort();
            this.loading.hidden = entries.length > 0;
            this.loading.textContent = tr("空文件夹");
        }
        catch (e) {
            if (request === this.request) {
                this.loading.textContent = tr("无法读取目录：{0}", String(e));
                this.loading.hidden = false;
                this.pathInput.value = address(this.location, settings.servers);
            }
        }
        finally {
            if (request === this.request) {
                this.busy = false;
                this.root.classList.remove('is-loading');
            }
        }
    }
    refresh() { return this.navigate(this.location, undefined, true); }
    async travel(delta: number) { const i = this.index + delta; if (i >= 0 && i < this.history.length)
        await this.navigate(this.history[i], i); }
    resort() { this.sorted = sortEntries(this.entries, this.sort, this.direction); this.renderRows(); }
    selected() { return this.sorted.filter(e => this.selection.has(e.name)).map(e => child(this.location, e.name)); }
    editAddress() {
        if (!this.pathInput.hidden) return;
        this.activate();
        this.pathInput.value = address(this.location, settings.servers);
        this.breadcrumbs.hidden = true;
        this.pathInput.hidden = false;
        this.addressBar.tabIndex = -1;
        this.pathInput.focus(); this.pathInput.select();
    }
    renderAddress() {
        this.pathInput.hidden = true;
        this.pathInput.value = address(this.location, settings.servers);
        this.breadcrumbs.hidden = false;
        this.addressBar.tabIndex = 0;
        this.breadcrumbs.replaceChildren();
        const server = settings.servers.find(s => s.id === this.location.connection);
        const parts: { label: string; location: Location }[] = [];
        if (server) {
            let location: Location = { connection: server.id, path: '/' };
            parts.push({ label: server.host, location: { ...location } }, { label: server.share, location: { ...location } });
            for (const name of this.location.path.split('/').filter(Boolean)) {
                location = child(location, name);
                parts.push({ label: name, location });
            }
        } else {
            let location = { ...this.location };
            for (;;) {
                const previous = parent(location);
                const normalized = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
                const root = normalized(previous.path) === normalized(location.path);
                const label = root ? location.path : location.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()!;
                parts.unshift({ label, location });
                if (root) break;
                location = previous;
            }
        }
        parts.forEach((part, index) => {
            if (index) {
                const separator = el('span', 'breadcrumb-separator');
                separator.setAttribute('aria-hidden', 'true');
                this.breadcrumbs.append(separator);
            }
            const item = button(part.label, undefined, undefined, 'breadcrumb');
            item.onclick = e => {
                e.stopPropagation();
                this.activate();
                void this.navigate(part.location);
            };
            item.title = address(part.location, settings.servers);
            item.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); };
            if (index === parts.length - 1) item.setAttribute('aria-current', 'location');
            this.breadcrumbs.append(item);
        });
        this.breadcrumbs.scrollLeft = this.breadcrumbs.scrollWidth;
    }
    renderRows() {
        this.space.style.height = `${this.sorted.length * ROW_HEIGHT}px`;
        const { start, end } = virtualRange(this.viewport.scrollTop, this.viewport.clientHeight, this.sorted.length);
        this.rows.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
        this.rows.replaceChildren();
        for (let i = start; i < end; i++) {
            const entry = this.sorted[i];
            const row = el('div', 'file-row' + (this.selection.has(entry.name) ? ' selected' : ''));
            row.dataset.index = String(i);
            row.draggable = !entry.isLink;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(this.selection.has(entry.name)));
            row.title = entry.name;
            row.classList.toggle('directory', entry.isDir);
            const name = el('span', 'file-name');
            name.append(icon(entry.isLink ? 'Link' : entry.isDir ? 'Folder' : 'File'), el('span', '', entry.name));
            row.append(name, el('span', 'file-type', type(entry)), el('span', 'file-size', entry.isDir ? '—' : bytes(entry.size)), el('span', 'file-date', entry.modified ? new Date(entry.modified * 1000).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'));
            row.onclick = e => {
                if (e.shiftKey) {
                    const from = Math.min(i, this.anchor);
                    const to = Math.max(i, this.anchor);
                    if (!e.metaKey && !e.ctrlKey)
                        this.selection.clear();
                    for (let j = from; j <= to; j++)
                        this.selection.add(this.sorted[j].name);
                }
                else if (e.metaKey || e.ctrlKey) {
                    this.selection.has(entry.name) ? this.selection.delete(entry.name) : this.selection.add(entry.name);
                    this.anchor = i;
                }
                else {
                    this.selection = new Set([entry.name]);
                    this.anchor = i;
                }
                this.renderSelection();
            };
            row.ondblclick = () => void this.open(entry);
            row.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); if (!this.selection.has(entry.name))
                this.selection = new Set([entry.name]); this.renderSelection(); menu(e.clientX, e.clientY, this.actions()); };
            row.ondragstart = e => { if (!this.selection.has(entry.name))
                this.selection = new Set([entry.name]); drag = { pane: this.id, sources: this.selected() }; e.dataTransfer!.effectAllowed = 'copy'; e.dataTransfer!.setData('text/plain', tr("{0} 个项目", this.selection.size)); };
            row.ondragend = () => { drag = null; document.querySelectorAll('.drop-target').forEach(e => e.classList.remove('drop-target')); };
            row.ondragover = () => { if (drag?.pane !== this.id && entry.isDir)
                row.classList.add('folder-drop'); };
            row.ondragleave = () => row.classList.remove('folder-drop');
            this.rows.append(row);
        }
        this.counter.textContent = tr("{0} 个项目{1}", this.entries.length.toLocaleString(), this.selection.size ? tr(" \u00B7 已选 {0} 项", this.selection.size) : '');
    }
    renderSelection() {
        for (const row of this.rows.querySelectorAll<HTMLElement>('.file-row')) {
            const selected = this.selection.has(this.sorted[Number(row.dataset.index)].name);
            row.classList.toggle('selected', selected);
            row.setAttribute('aria-selected', String(selected));
        }
        this.counter.textContent = tr("{0} 个项目{1}", this.entries.length.toLocaleString(), this.selection.size ? tr(" \u00B7 已选 {0} 项", this.selection.size) : '');
    }
    async open(entry: Entry) {
        if (this.busy)
            return;
        const loc = child(this.location, entry.name);
        if (entry.isDir)
            await this.navigate(loc);
        else if (loc.connection) {
            const answer = await dialog(tr("下载文件"), tr("将 {0} 下载到本机 Downloads 文件夹？", entry.name), [], [{ label: tr("下载"), value: 'download' }]);
            if (answer)
                await transfer([loc], child({ connection: null, path: home }, 'Downloads'), false);
        }
        else
            await attempt(() => ipc('open_local', { location: loc }));
    }
    async favorite() {
        const existing = settings.favorites.find(f => f.location.connection === this.location.connection && f.location.path === this.location.path);
        if (existing) {
            await attempt(() => removeFavorite(existing));
            return;
        }
        const answer = await dialog(tr("收藏目录"), address(this.location, settings.servers), [field(tr("名称"), 'label', this.location.path.split(/[\\/]/).filter(Boolean).pop() || tr("根目录"), 'text', true)], [{ label: tr("收藏"), value: 'save' }]);
        if (answer)
            await attempt(async () => { settings = await ipc<Settings>('favorite', { favorite: { id: crypto.randomUUID(), label: String(answer.data.get('label')), location: this.location }, remove: false }); renderPlaces(); });
    }
    async newFolder() {
        const location = { ...this.location };
        const answer = await dialog(tr("新建文件夹"), address(location, settings.servers), [field(tr("名称"), 'name', tr("新建文件夹"), 'text', true)], [{ label: tr("创建"), value: 'create' }]);
        if (answer)
            await attempt(async () => { await ipc('mkdir', { location, name: answer.data.get('name') }); await this.refresh(); });
    }
    async rename() {
        const selected = this.selected();
        if (selected.length !== 1)
            return;
        const answer = await dialog(tr("重命名"), tr("已有同名项目时不会覆盖。"), [field(tr("名称"), 'name', this.sorted.find(e => this.selection.has(e.name))!.name, 'text', true)], [{ label: tr("保存"), value: 'save' }]);
        if (answer)
            await attempt(async () => { await ipc('rename', { location: selected[0], name: answer.data.get('name') }); await this.refresh(); });
    }
    async delete() {
        const locations = this.selected();
        if (!locations.length)
            return;
        if (await confirm(tr("永久删除 {0} 个项目？", locations.length), tr("文件夹及其内容都会被删除，不会移入废纸篓。此操作无法撤销。")))
            await attempt(async () => { try {
                await ipc('delete', { locations, confirmed: true });
            }
            finally {
                await this.refresh();
            } });
    }
    async copy(moving: boolean) {
        const sources = this.selected();
        if (!sources.length)
            return;
        clipboard = { sources, moving };
        if (!moving && sources.every(source => source.connection === null) && /Macintosh|Mac OS X/.test(navigator.userAgent)) {
            await attempt(async () => { await ipc('copy_local_to_clipboard', { locations: sources }); message(tr("已复制 {0} 项，可在访达或桌面粘贴", sources.length)); });
        }
        else
            message(tr("{0} {1} 项，可在 smb X 中粘贴", moving ? tr("已剪切") : tr("已复制"), sources.length));
    }
    actions() {
        const n = this.selection.size;
        const reveal = n === 1 ? this.selected()[0] : this.location;
        return [
            { label: tr("打开 / 下载"), disabled: n !== 1 || this.busy, run: () => void this.open(this.sorted.find(e => this.selection.has(e.name))!) },
            { label: tr("在访达中显示"), disabled: this.location.connection !== null || n > 1, run: () => void attempt(() => ipc('reveal_local', { location: reveal })) },
            { label: tr("复制到另一栏"), disabled: !n || this.busy, run: () => void transfer(this.selected(), panes[1 - this.id].location, false) },
            { label: tr("移动到另一栏"), disabled: !n || this.busy, run: () => void transfer(this.selected(), panes[1 - this.id].location, true) },
            { label: tr("复制"), disabled: !n, run: () => void this.copy(false) },
            { label: tr("剪切"), disabled: !n, run: () => void this.copy(true) },
            { label: tr("粘贴"), disabled: !clipboard, run: () => { if (clipboard)
                    void transfer(clipboard.sources, this.location, clipboard.moving); } },
            { label: tr("新建文件夹"), disabled: this.busy, run: () => void this.newFolder() },
            { label: tr("重命名"), disabled: n !== 1 || this.busy, run: () => void this.rename() },
            { label: tr("永久删除\u2026"), disabled: !n || this.busy, run: () => void this.delete() },
            { label: tr("刷新"), run: () => void this.refresh() },
        ];
    }
}
const panes = [new Pane(0), new Pane(1)];
async function transfer(sources: Location[], destination: Location, moving: boolean) {
    if (!sources.length)
        return;
    if (moving && !await confirm(tr("移动项目"), tr("将 {0} 项移动到 {1}？每个文件传输成功后才删除其源文件。", sources.length, address(destination, settings.servers))))
        return;
    await attempt(async () => { await ipc('enqueue', { sources, destination, moving }); if (moving)
        clipboard = null; await poll(); message(tr("已添加 {0} 个传输任务", sources.length)); });
}
function setQueue(open: boolean) {
    queue.hidden = !open;
    queueButton.classList.toggle('active', open);
    queueButton.setAttribute('aria-expanded', String(open));
}
const statusNames: Record<string, string> = { queued: tr("等待"), scanning: tr("统计文件"), running: tr("传输中"), conflict: tr("等待确认"), success: tr("成功"), skipped: tr("完成 \u00B7 有跳过"), failed: tr("失败"), cancelled: tr("已取消"), cancelling: tr("正在取消") };
let polling = false;
let taskSignature = '';
let conflictPrompt = false;
async function poll() {
    if (!isTauri() || polling)
        return;
    polling = true;
    try {
        const next = await ipc<Task[]>('tasks');
        const before = new Map(tasks.map(t => [t.id, t.status]));
        const completed = next.some(t => terminal(t.status) && before.has(t.id) && !terminal(before.get(t.id)!));
        if (next.some(t => !before.has(t.id) && !terminal(t.status)))
            setQueue(true);
        tasks = next;
        const signature = JSON.stringify(tasks);
        if (signature !== taskSignature) {
            taskSignature = signature;
            renderTasks();
        }
        const conflict = tasks.find(t => t.status === 'conflict');
        if (conflict && !modalOpen && !conflictPrompt) {
            conflictPrompt = true;
            void (async () => {
                try {
                    const choice = await dialog(tr("目标已存在同名文件"), conflict.conflict || conflict.name, [], [{ label: tr("跳过"), value: 'skip' }, { label: tr("替换"), value: 'replace' }]);
                    await ipc('task_action', { id: conflict.id, action: choice?.value || 'cancel' });
                    await poll();
                }
                catch (e) {
                    message(String(e));
                }
                finally {
                    conflictPrompt = false;
                }
            })();
        }
        if (completed)
            for (const pane of panes)
                if (!pane.busy)
                    void pane.refresh();
    }
    catch (e) {
        message(String(e));
    }
    finally {
        polling = false;
    }
}
function renderTasks() {
    taskList.replaceChildren();
    if (!tasks.length) {
        const empty = el('div', 'queue-empty');
        empty.append(el('span', '', tr("暂无传输任务")));
        taskList.append(empty);
    }
    for (const t of [...tasks].reverse()) {
        const row = el('article', 'task');
        const glyph = icon(t.status === 'success' ? 'CircleCheck' : t.status === 'failed' ? 'CircleAlert' : 'ArrowRightLeft');
        row.append(glyph);
        const info = el('div', 'task-info');
        const top = el('div', 'task-title');
        top.append(el('strong', '', t.name), el('span', `task-state ${t.status}`, `${t.moving ? tr("移动 \u00B7 ") : ''}${statusNames[t.status] || t.status}`));
        const paths = el('div', 'task-path', `${address(t.source, settings.servers)} → ${address(t.destination, settings.servers)}`);
        paths.title = paths.textContent!;
        const track = el('progress');
        track.max = Math.max(t.total, 1);
        track.value = t.status === 'success' ? track.max : t.done;
        const detail = el('div', 'task-detail', `${bytes(t.done)} / ${bytes(t.total)} · ${t.total ? Math.min(100, Math.floor(t.done / t.total * 100)) : t.status === 'success' ? 100 : 0}%${t.speed ? ` · ${bytes(t.speed)}/s` : ''}${t.skipped ? tr(" \u00B7 跳过 {0} 项", t.skipped) : ''}`);
        info.append(top, paths, track, detail);
        if (t.error)
            info.append(el('div', 'task-error', localizeError(t.error)));
        if (t.conflict) {
            const conflict = el('div', 'conflict');
            conflict.append(el('span', '', tr("目标已存在：{0}", t.conflict)));
            const controls = el('div');
            for (const [label, action] of [[tr("替换"), 'replace'], [tr("跳过"), 'skip'], [tr("取消任务"), 'cancel']])
                controls.append(button(label, undefined, () => void attempt(async () => { await ipc('task_action', { id: t.id, action }); await poll(); }), action === 'replace' ? 'primary' : 'secondary'));
            conflict.append(controls);
            info.append(conflict);
        }
        row.append(info);
        if (!terminal(t.status))
            row.append(button(tr("取消任务"), 'X', () => void attempt(async () => { await ipc('task_action', { id: t.id, action: 'cancel' }); await poll(); })));
        else if (['failed', 'cancelled'].includes(t.status))
            row.append(button(tr("重试"), 'RefreshCw', () => void attempt(async () => { await ipc('task_action', { id: t.id, action: 'retry' }); await poll(); })));
        taskList.append(row);
    }
    const pending = tasks.filter(t => !terminal(t.status));
    queueBadge.textContent = String(pending.length);
    queueBadge.hidden = pending.length === 0;
    const summary = `${pending.length ? tr("{0} 个传输任务", pending.length) : tasks.length ? tr("{0} 个已结束任务", tasks.length) : tr("传输队列为空")}${pending.some(t => t.status === 'conflict') ? tr(" \u00B7 等待处理同名冲突") : ''}`;
    queueButton.title = summary;
    queueButton.setAttribute('aria-label', summary);
}
const header = el('header', 'app-header');
const title = el('div', 'window-title');
title.append(el('span', '', 'smb X'));
header.append(title, button(tr("管理连接"), 'Settings2', manageServers, 'manage-connections text-button'), button(tr("连接服务器"), 'Plus', () => void connectServer()), el('div', 'toolbar-space'), queueButton, button(tr("刷新当前栏"), 'RefreshCw', () => void panes[active].refresh()), button(tr("新建文件夹"), 'FolderPlus', () => void panes[active].newFolder()), button(tr("更多操作"), 'MoreHorizontal', () => { const r = header.getBoundingClientRect(); menu(r.right - 215, r.bottom, panes[active].actions()); }));
if (!isMac || !isTauri()) header.append(button(tr('设置'), 'Settings2', () => void showSettings()));
panesEl.append(...panes.map(p => p.root));
const queueHeader = el('div', 'queue-header');
const queueActions = el('div', 'queue-actions');
queueActions.append(button(tr("清除已结束"), undefined, () => void attempt(async () => { await ipc('clear_finished'); await poll(); }), 'text-button'), button(tr("关闭传输队列"), 'X', () => setQueue(false)));
queueHeader.append(el('strong', '', tr("传输队列")), el('span', '', tr("同名目录合并，文件逐项确认")), queueActions);
queue.append(queueHeader, taskList);
queue.hidden = true;
queue.setAttribute('role', 'dialog');
queue.setAttribute('aria-label', tr("传输队列"));
queueButton.setAttribute('aria-expanded', 'false');
main.append(header, panesEl, queue);
app.append(main, toast);
panes[0].activate();
renderPlaces();
renderTasks();
document.addEventListener('pointerdown', e => { const target = e.target as Node; if (!queue.hidden && !queue.contains(target) && !queueButton.contains(target))
    setQueue(false); });
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        document.querySelector('.context-menu')?.remove();
        setQueue(false);
        return;
    }
    if (modalOpen || (e.target as HTMLElement).closest('input,textarea'))
        return;
    const pane = panes[active];
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        pane.editAddress();
    }
    else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        pane.selection = new Set(pane.entries.map(x => x.name));
        pane.renderRows();
    }
    else if (mod && ['c', 'x'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        void pane.copy(e.key.toLowerCase() === 'x');
    }
    else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (clipboard)
            void transfer(clipboard.sources, pane.location, clipboard.moving);
    }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void pane.newFolder();
    }
    else if (e.key === 'F2') {
        e.preventDefault();
        void pane.rename();
    }
    else if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        void pane.refresh();
    }
    else if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
        e.preventDefault();
        void pane.delete();
    }
    else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        void pane.travel(-1);
    }
    else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        void pane.travel(1);
    }
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
        e.preventDefault();
        void pane.navigate(parent(pane.location));
    }
    else if (e.key === 'Enter' && pane.selection.size === 1) {
        e.preventDefault();
        void pane.open(pane.sorted.find(x => pane.selection.has(x.name))!);
    }
    else if (['ArrowDown', 'ArrowUp'].includes(e.key) && pane.sorted.length) {
        e.preventDefault();
        pane.anchor = Math.max(0, Math.min(pane.sorted.length - 1, pane.anchor + (e.key === 'ArrowDown' ? 1 : -1)));
        if (!e.shiftKey)
            pane.selection.clear();
        pane.selection.add(pane.sorted[pane.anchor].name);
        const y = pane.anchor * ROW_HEIGHT;
        if (y < pane.viewport.scrollTop)
            pane.viewport.scrollTop = y;
        if (y + ROW_HEIGHT > pane.viewport.scrollTop + pane.viewport.clientHeight)
            pane.viewport.scrollTop = y + ROW_HEIGHT - pane.viewport.clientHeight;
        pane.renderRows();
    }
});
async function start() {
    if (isTauri()) {
        await listen('open-settings', () => void showSettings());
        await ipc('configure_menu', { english: language === 'en' });
    }
    if (!isTauri()) {
        if (import.meta.env.DEV) {
            const preview = await import('./preview');
            previewList = preview.previewList;
            home = preview.previewHome;
            settings.servers = [preview.previewServer];
            settings.favorites = preview.previewFavorites;
            renderPlaces();
            await Promise.all([panes[0].navigate({ connection: null, path: home }), panes[1].navigate({ connection: 'preview', path: '/' })]);
        }
        else {
            for (const p of panes) {
                p.loading.hidden = false;
                p.loading.textContent = tr("请在桌面应用中打开");
            }
        }
        return;
    }
    await attempt(async () => {
        const initial = await ipc<{
            home: string;
            settings: Settings;
        }>('initial');
        home = initial.home;
        settings = initial.settings;
        renderPlaces();
        await Promise.all(panes.map(p => p.navigate({ connection: null, path: home })));
        await getCurrentWindow().onCloseRequested(async (e) => {
            e.preventDefault();
            await poll();
            if (tasks.some(t => !terminal(t.status))) {
                if (await confirm(tr("关闭smb X？"), tr("未完成的传输将中断，任务不会在下次启动时恢复。关闭前建议取消任务并等待清理完成。")))
                    await getCurrentWindow().destroy();
            }
            else
                await getCurrentWindow().destroy();
        });
    });
    const tick = async () => { await poll(); window.setTimeout(tick, document.hidden ? 2000 : tasks.some(t => !terminal(t.status)) ? 400 : 1500); };
    void tick();
}
void start().then(restoreLanguageSession).catch(e => message(String(e)));
