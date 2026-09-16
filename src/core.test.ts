import { describe, it, expect } from 'vitest';
import { parent, child, sortEntries, virtualRange, parseAddress, address, favoritesFor, resizeColumns, type Favorite, type Server } from './core';
describe('paths', () => {
  it('keeps filesystem and share roots', () => {
    expect(parent({ connection: null, path: 'C:\\' }).path).toBe('C:\\');
    expect(parent({ connection: null, path: '/Users/me' }).path).toBe('/Users');
    expect(parent({ connection: 'nas', path: '/' }).path).toBe('/');
    expect(child({ connection: 'nas', path: '/' }, '资料').path).toBe('/资料');
  });
  it('roundtrips unicode, spaces, # and custom ports', () => {
    const s: Server = { id: 'a', host: 'nas', share: '资料', port: 1445, label: 'NAS', username: '', domain: '', remember: false };
    const loc = { connection: 'a', path: '/a #1/照片' };
    expect(parseAddress(address(loc, [s]), [s], '/')).toEqual(loc);
    expect(() => parseAddress('smb://user:secret@nas/资料', [s], '/')).toThrow();
  });
});
it('virtualizes ten thousand entries to a bounded DOM window', () => {
  const range = virtualRange(150000, 600, 10000);
  expect(range.end - range.start).toBeLessThan(40);
  expect(range.start).toBeGreaterThan(3900);
});
it('keeps directories first even when sorting descending', () => {
  const e = (name: string, isDir: boolean) => ({ name, isDir, size: 0, modified: null, isLink: false });
  expect(sortEntries([e('file2', false), e('folder', true), e('file10', false)], 'name', -1).map(e => e.name)).toEqual(['folder', 'file10', 'file2']);
});
it('scopes favorites to the local disk or one exact connection instance', () => {
  const favorite = (id: string, connection: string | null): Favorite => ({ id, label: id, location: { connection, path: `/${id}` } });
  const favorites = [favorite('local', null), favorite('nas-a', 'a'), favorite('nas-b', 'b')];
  expect(favoritesFor(favorites, null).map(f => f.id)).toEqual(['local']);
  expect(favoritesFor(favorites, 'a').map(f => f.id)).toEqual(['nas-a']);
});
describe('column resizing', () => {
  it('moves a boundary without changing the combined width', () => {
    expect(resizeColumns([240, 83, 94, 125], 1, 20)).toEqual([240, 103, 74, 125]);
  });
  it('stops when either neighboring column reaches its minimum width', () => {
    expect(resizeColumns([100, 83, 64, 125], 0, -40)).toEqual([95, 88, 64, 125]);
    expect(resizeColumns([240, 83, 64, 125], 2, 100)).toEqual([240, 83, 99, 90]);
  });
});
