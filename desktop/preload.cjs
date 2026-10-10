const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aero', {
  state: () => ipcRenderer.invoke('vpn:state'),
  importProfile: () => ipcRenderer.invoke('vpn:import'),
  connect: id => ipcRenderer.invoke('vpn:connect', id),
  disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
  measure: () => ipcRenderer.invoke('vpn:measure'),
  remove: id => ipcRenderer.invoke('vpn:remove', id),
  openDocs: () => ipcRenderer.invoke('vpn:open-docs')
});
