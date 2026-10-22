async function update(action = 'status') {
  const status = document.querySelector('#status');
  try {
    const result = await chrome.runtime.sendMessage({ action });
    status.textContent = result.connected ? `已连接 · ${result.attached} 个受控标签页`
      : result.error || (result.connecting ? '正在连接…' : '未连接');
    document.querySelector('#disconnect').disabled = !result.connected && !result.connecting;
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#connect').onclick = () => update('connect');
document.querySelector('#disconnect').onclick = () => update('disconnect');
await update();
setInterval(() => update(), 1000);
