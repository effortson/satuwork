/** Injected into macOS/Windows local main/setup pages, outside #app's render cycle. */
(function () {
  const invoke = window.__TAURI_INTERNALS__?.invoke
  if (typeof invoke !== 'function' || window.__satuWindowMounted) return
  window.__satuWindowMounted = true

  const windows = window.__SATUWORK_WINDOW_PLATFORM__ === 'windows'
  const resizeAction = windows ? 'zoom' : 'fullscreen'
  function mount() {
    document.documentElement.classList.add('satu-custom-window', windows ? 'satu-window-windows' : 'satu-window-macos')
    const bar = document.createElement('div')
    bar.id = 'satu-windowbar'
    bar.className = 'satu-windowbar'
    bar.dataset.focused = String(document.hasFocus())
    bar.dataset.platform = windows ? 'windows' : 'macos'
    const button = (action, path, toggle = false) => `<button type="button" class="satu-window-control" data-window-action="${action}" ${toggle ? 'aria-pressed="false"' : ''}><span class="${windows ? 'satu-window-glyph' : 'satu-window-dot'}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="${path}"/></svg></span></button>`
    bar.innerHTML = `<div class="satu-window-controls" role="group">${windows
      ? button('minimize', 'M1.5 6.5h9') + button('zoom', 'M2 2h8v8H2z', true) + button('close', 'm2 2 8 8m0-8-8 8')
      : button('close', 'm4 4 4 4m0-4L4 8') + button('minimize', 'M3 6h6') + button('fullscreen', 'M3 6V3h3m3 3v3H6', true)
    }</div><div class="satu-window-drag" data-window-drag>${windows ? '<span class="satu-window-caption" aria-hidden="true">Satuwork</span>' : ''}</div>`
    const error = document.createElement('div')
    error.className = 'satu-window-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    document.body.appendChild(bar)
    document.body.appendChild(error)
    let busy = false
    let lastState = { fullscreen: false, maximized: false, resizable: true }
    const resizeButton = bar.querySelector(`[data-window-action="${resizeAction}"]`)
    function labels() {
      const en = document.documentElement.lang.startsWith('en')
      bar.querySelector('[role="group"]').setAttribute('aria-label', en ? 'Window controls' : '窗口控制')
      const names = en ? { close: 'Close window', minimize: 'Minimize window', zoom: lastState.maximized ? 'Restore window' : 'Maximize window', fullscreen: lastState.fullscreen ? 'Exit full screen' : 'Enter full screen' } : { close: '关闭窗口', minimize: '最小化窗口', zoom: lastState.maximized ? '还原窗口' : '最大化窗口', fullscreen: lastState.fullscreen ? '退出全屏' : '进入全屏' }
      for (const button of bar.querySelectorAll('[data-window-action]')) {
        const label = names[button.dataset.windowAction]
        button.setAttribute('aria-label', label)
        button.title = label
      }
    }
    async function sync() {
      try {
        lastState = await invoke('desktop_window_state')
        bar.dataset.focused = String(lastState.focused)
        bar.dataset.fullscreen = String(lastState.fullscreen)
        bar.dataset.maximized = String(lastState.maximized)
        resizeButton.disabled = !lastState.resizable || (windows && lastState.fullscreen)
        resizeButton.setAttribute('aria-pressed', String(windows ? lastState.maximized : lastState.fullscreen))
        resizeButton.querySelector('path').setAttribute('d', windows
          ? lastState.maximized ? 'M4 2h6v6M2 4h6v6H2z' : 'M2 2h8v8H2z'
          : lastState.fullscreen ? 'M3 5h2V3m4 4H7v2' : 'M3 6V3h3m3 3v3H6')
        labels()
      } catch { /* The window may already be closing. */ }
    }
    async function act(action) {
      if (busy && action !== 'drag') return
      if (action !== 'drag') busy = true
      error.hidden = true
      try {
        await invoke('desktop_window_action', { action })
        await sync()
      } catch (e) {
        error.textContent = (document.documentElement.lang.startsWith('en') ? 'Window action failed: ' : '窗口操作失败：') + String(e?.message || e)
        error.hidden = false
      } finally { busy = false }
    }
    bar.addEventListener('click', e => {
      const button = e.target.closest('[data-window-action]')
      if (button && !button.disabled) void act(button.dataset.windowAction)
    })
    // Only blank chrome starts a drag. Inputs, navigation and chat controls keep their clicks.
    document.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.defaultPrevented || !e.target.closest) return
      if (e.target.closest('button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]')) return
      if (!e.target.closest('[data-window-drag], .gw-head')) return
      e.preventDefault()
      void act(e.detail === 2 ? 'zoom' : 'drag')
    })
    window.addEventListener('focus', () => { bar.dataset.focused = 'true'; void sync() })
    window.addEventListener('blur', () => { bar.dataset.focused = 'false' })
    window.addEventListener('resize', () => { void sync() })
    new MutationObserver(labels).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    labels()
    void sync()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()
