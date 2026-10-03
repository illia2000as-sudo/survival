const { app, BrowserWindow, Menu } = require('electron');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // убираем верхнюю панель (Файл, Правка, Вид...)
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    title: 'DeadZone',
    autoHideMenuBar: true,
  });
  win.setMenuBarVisibility(false);
  // F11 - полный экран
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  win.loadFile('index.html');
});

app.on('window-all-closed', () => app.quit());
