// Web Audio Synthesized UI Sound Effects Pack (Retro 8-Bit & Sci-Fi)

let audioCtx = null;
let soundEnabled = true;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

export function initUiSounds() {
  const toggleCheckbox = document.getElementById('ui-sounds-toggle-checkbox');
  const savedState = localStorage.getItem('nitro_ui_sounds_enabled');
  soundEnabled = savedState !== 'false';

  if (toggleCheckbox) {
    toggleCheckbox.checked = soundEnabled;
    toggleCheckbox.addEventListener('change', (e) => {
      soundEnabled = e.target.checked;
      localStorage.setItem('nitro_ui_sounds_enabled', soundEnabled ? 'true' : 'false');
      if (soundEnabled) playUiSound('click');
    });
  }

  // Attach sound triggers to buttons & nav tabs
  document.addEventListener('click', (e) => {
    if (!soundEnabled) return;
    const target = e.target.closest('button, .nav-btn, .btn-pill, .btn-small, a');
    if (target) {
      if (target.classList.contains('nav-btn')) {
        playUiSound('tab');
      } else if (target.classList.contains('primary') || target.classList.contains('danger')) {
        playUiSound('action');
      } else {
        playUiSound('click');
      }
    }
  });
}

export function playUiSound(type = 'click') {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.04);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.04);
    } else if (type === 'tab') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.06);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.start(now);
      osc.stop(now + 0.06);
    } else if (type === 'action') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.setValueAtTime(600, now + 0.04);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    }
  } catch (e) {}
}
