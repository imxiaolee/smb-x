import { child, type Entry, type Location } from './core';

export interface DropTarget {
    location: Location;
    entry?: Entry;
    busy: boolean;
}
export function dropDestination(target: DropTarget): Location | null {
    if (target.busy || target.entry?.isLink) return null;
    return target.entry?.isDir ? child(target.location, target.entry.name) : { ...target.location };
}
type NativeDrop = { type: 'leave' } | {
    type: 'enter' | 'over' | 'drop';
    position: { x: number; y: number };
    paths?: string[];
};
export function handleNativeDrop<T extends DropTarget>(event: NativeDrop, scale: number, handlers: {
    clear: () => void;
    target: (x: number, y: number) => T | null;
    highlight: (target: T) => void;
    transfer: (sources: Location[], destination: Location) => void;
}) {
    handlers.clear();
    if (event.type === 'leave') return;
    // Tauri reports physical pixels; DOM hit testing uses CSS pixels.
    const target = handlers.target(event.position.x / scale, event.position.y / scale);
    const destination = target && dropDestination(target);
    if (!target || !destination) return;
    if (event.type !== 'drop') {
        handlers.highlight(target);
        return;
    }
    const sources = [...new Set(event.paths || [])].filter(path => path.length > 0).map(path => ({ connection: null, path }));
    if (sources.length) handlers.transfer(sources, destination);
}
