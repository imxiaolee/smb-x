import { describe, expect, it, vi } from 'vitest';
import { dropDestination, handleNativeDrop, type DropTarget } from './drag-drop';

const location = { connection: 'nas', path: '/共享资料' };
const folder = { name: '子目录', isDir: true, isLink: false, size: 0, modified: null };
function fixture(target: DropTarget | null = { location, busy: false }) {
  return { clear: vi.fn(), target: vi.fn(() => target), highlight: vi.fn(), transfer: vi.fn() };
}
describe('native file drops', () => {
  it.each(['/Users/me/照片 #1.png', 'C:\\Users\\me\\照片 #1.png'])('queues an external path as a local copy source: %s', path => {
    const handlers = fixture();
    handleNativeDrop({ type: 'drop', position: { x: 600, y: 400 }, paths: [path] }, 2, handlers);
    expect(handlers.target).toHaveBeenCalledWith(300, 200);
    expect(handlers.transfer).toHaveBeenCalledExactlyOnceWith([{ connection: null, path }], location);
    expect(handlers.highlight).not.toHaveBeenCalled();
  });
  it('copies files and folders into the hovered directory and deduplicates paths', () => {
    const handlers = fixture({ location, busy: false, entry: folder });
    handleNativeDrop({ type: 'drop', position: { x: 10, y: 20 }, paths: ['/tmp/file', '/tmp/folder', '/tmp/file'] }, 1, handlers);
    expect(handlers.transfer).toHaveBeenCalledExactlyOnceWith([{ connection: null, path: '/tmp/file' }, { connection: null, path: '/tmp/folder' }], { connection: 'nas', path: '/共享资料/子目录' });
  });
  it('highlights enter and over, clears leave, and never queues hover events', () => {
    const handlers = fixture();
    handleNativeDrop({ type: 'enter', position: { x: 10, y: 20 }, paths: ['/tmp/file'] }, 1, handlers);
    handleNativeDrop({ type: 'over', position: { x: 30, y: 40 } }, 1, handlers);
    handleNativeDrop({ type: 'leave' }, 1, handlers);
    expect(handlers.highlight).toHaveBeenCalledTimes(2);
    expect(handlers.clear).toHaveBeenCalledTimes(3);
    expect(handlers.target).toHaveBeenCalledTimes(2);
    expect(handlers.transfer).not.toHaveBeenCalled();
  });
  it.each([null, { location, busy: true }, { location, busy: false, entry: { ...folder, isLink: true } }])('rejects drops outside a ready, supported target (%j)', target => {
    const handlers = fixture(target);
    handleNativeDrop({ type: 'drop', position: { x: 10, y: 20 }, paths: ['/tmp/file'] }, 1, handlers);
    expect(handlers.clear).toHaveBeenCalledOnce();
    expect(handlers.transfer).not.toHaveBeenCalled();
  });
  it('ignores empty drops and uses the current directory when hovering a file', () => {
    const handlers = fixture();
    handleNativeDrop({ type: 'drop', position: { x: 10, y: 20 }, paths: [] }, 1, handlers);
    expect(handlers.transfer).not.toHaveBeenCalled();
    expect(dropDestination({ location, busy: false, entry: { ...folder, isDir: false } })).toEqual(location);
  });
});
