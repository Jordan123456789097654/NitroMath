// CRT Retro Monitor Shader Overlay Controller

export function initCrtShader() {
  const toggle = document.getElementById('crt-shader-toggle-checkbox');
  const savedState = localStorage.getItem('nitro_crt_shader_enabled') === 'true';

  if (toggle) {
    toggle.checked = savedState;
    toggle.addEventListener('change', (e) => {
      setCrtShader(e.target.checked);
    });
  }

  setCrtShader(savedState);
}

export function setCrtShader(enabled) {
  localStorage.setItem('nitro_crt_shader_enabled', enabled ? 'true' : 'false');
  let overlay = document.getElementById('crt-overlay-layer');

  if (enabled) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'crt-overlay-layer';
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 99999;
        background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03));
        background-size: 100% 4px, 6px 100%;
        opacity: 0.85;
        box-shadow: inset 0 0 100px rgba(0, 0, 0, 0.7);
      `;
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
  } else if (overlay) {
    overlay.style.display = 'none';
  }
}
