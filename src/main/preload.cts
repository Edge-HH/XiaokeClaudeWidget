import { contextBridge, ipcRenderer } from 'electron';

function subscribe(channel: string, callback: (value: unknown) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('desktopBridge', {
  state: () => ipcRenderer.invoke('desktop:state'),
  attachment: () => ipcRenderer.invoke('desktop:attachment'),
  save: (config: unknown, secret: string) => ipcRenderer.invoke('desktop:save', config, secret),
  remove: (id: string) => ipcRenderer.invoke('desktop:remove', id),
  activate: (id: string) => ipcRenderer.invoke('desktop:activate', id),
  organizations: (id: string, secret: string) => ipcRenderer.invoke('desktop:organizations', id, secret),
  testSource: (config: unknown, secret: string) => ipcRenderer.invoke('desktop:test-source', config, secret),
  refresh: () => ipcRenderer.invoke('desktop:refresh'),
  downloadAssets: () => ipcRenderer.invoke('desktop:download-assets'),
  importAssets: () => ipcRenderer.invoke('desktop:import-assets'),
  openSettings: () => ipcRenderer.send('desktop:open-settings'),
  closeSettings: () => ipcRenderer.send('desktop:close-settings'),
  setHit: (hit: boolean, editing: boolean, menuOpen: boolean) => ipcRenderer.send('desktop:hit', hit, editing, menuOpen),
  ready: () => ipcRenderer.invoke('desktop:ready'),
  rendererFailed: () => ipcRenderer.send('desktop:renderer-failed'),
  placementApplied: (revision: number) => ipcRenderer.send('desktop:placement-applied', revision),
  onPlacement: (callback: (value: unknown) => void) => subscribe('desktop:placement', callback),
  onSnapshot: (callback: (value: unknown) => void) => subscribe('desktop:snapshot', callback),
  onPointer: (callback: (value: unknown) => void) => subscribe('desktop:pointer', callback),
});
