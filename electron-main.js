const { app, BrowserWindow, Menu } = require('electron');

// Две копии игры сразу не нужны: у них общие сохранения (localStorage)
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
app.on('second-instance', () => { // повторный запуск просто возвращает фокус окну
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // убираем верхнюю панель (Файл, Правка, Вид...)
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#000000',
    title: 'DeadZone',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // игра не открывает новых окон
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { // F11 - полный экран
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12' && !app.isPackaged) { // консоль разработчика только при запуске из исходников
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  win.on('closed', () => { win = null; });
  win.loadFile('index.html');
});

app.on('window-all-closed', () => app.quit());
