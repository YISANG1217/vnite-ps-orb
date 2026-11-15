(() => {
  const api = window.psOrb;
  const pick = document.getElementById('pick');
  const hint = document.getElementById('hint');
  const shade = document.getElementById('shade');

  let origin = null;
  let rect = null;

  function paint() {
    if (!rect) {
      pick.hidden = true;
      return;
    }
    pick.hidden = false;
    pick.style.left = `${rect.x}px`;
    pick.style.top = `${rect.y}px`;
    pick.style.width = `${rect.width}px`;
    pick.style.height = `${rect.height}px`;
    hint.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} · 松开确认`;
  }

  function begin(event) {
    if (event.button !== 0) return;
    origin = { x: event.clientX, y: event.clientY };
    rect = { x: origin.x, y: origin.y, width: 0, height: 0 };
    shade.style.opacity = '0';
    paint();
  }

  function move(event) {
    if (!origin) return;
    const x = Math.min(origin.x, event.clientX);
    const y = Math.min(origin.y, event.clientY);
    rect = {
      x,
      y,
      width: Math.abs(event.clientX - origin.x),
      height: Math.abs(event.clientY - origin.y)
    };
    paint();
  }

  function end() {
    if (!origin) return;
    origin = null;
    if (!rect || rect.width < 24 || rect.height < 16) {
      rect = null;
      shade.style.opacity = '1';
      hint.textContent = '拖动框选字幕区域 · Esc 取消';
      paint();
      return;
    }
    api.commitRegion(rect);
  }

  document.addEventListener('pointerdown', begin);
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') api.cancelRegion();
  });
  document.addEventListener('contextmenu', event => event.preventDefault());
})();
