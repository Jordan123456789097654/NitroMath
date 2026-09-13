// Real-Time WebRTC Voice Mesh Engine with Spatial 3D Audio, Voice Changer FX, Screen Share & Active Speaker Glow Rings
import { getCurrentUser } from './auth.js';
import { getSharedSocket } from './socket.js';
import { initBoardGames, cleanupBoardGames } from './boardgames.js';

let voiceSocket = null;
let activeChannelId = null;
let activeChannelName = 'General Voice Lounge';
let localStream = null;
let processedStream = null;
let localScreenStream = null;

let peerConnections = {}; // targetSocketId -> RTCPeerConnection
let peerPannerNodes = {}; // targetSocketId -> StereoPannerNode
let pendingIceCandidates = {}; // targetSocketId -> Array of RTCIceCandidate
let peerVolumes = {}; // targetSocketId -> volume float (0.0 to 1.5)

function cleanSocketId(id) {
  if (!id) return '';
  return id.replace(/^\/voice#/, '');
}

function isSelfSocket(socketId) {
  if (!voiceSocket || !voiceSocket.id) return false;
  return cleanSocketId(socketId) === cleanSocketId(voiceSocket.id);
}

let isMuted = false;
let isDeafened = false;
let currentVoicePreset = 'normal';

// Voice Activation & Push-to-Talk (PTT)
let voiceActivationMode = 'voice_activity'; // 'voice_activity' | 'ptt'
let isPttPressed = false;
let isSpatialAudioEnabled = true;

// Audio Context & Level Detection
let audioCtx = null;
let micSource = null;
let micAnalyser = null;
let audioCheckInterval = null;
let isSpeakingLocally = false;
const peerSpeakingStates = {}; // socketId -> boolean
let fxNodes = [];

// Default STUN-only config, used until /api/voice/ice-config responds (or if
// it fails). STUN alone often can't establish a connection on networks that
// restrict raw UDP — see fetchIceConfig() below, which adds a TURN relay
// server when the deployment has one configured.
let RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ]
};

async function fetchIceConfig() {
  try {
    const res = await fetch('/api/voice/ice-config');
    const data = await res.json();
    if (data && data.success && Array.isArray(data.iceServers) && data.iceServers.length) {
      RTC_CONFIG = { iceServers: data.iceServers };
    }
  } catch (e) {}
}

window.setPeerVolume = (socketId, val) => {
  const num = parseFloat(val);
  peerVolumes[socketId] = num;
  const audioEl = document.getElementById(`audio-peer-${socketId}`);
  if (audioEl) {
    audioEl.volume = Math.min(1.0, Math.max(0.0, num));
  }
  const labelMain = document.getElementById(`vol-val-${socketId}`);
  if (labelMain) labelMain.textContent = `${Math.round(num * 100)}%`;
  const labelSide = document.getElementById(`sidebar-vol-val-${socketId}`);
  if (labelSide) labelSide.textContent = `${Math.round(num * 100)}%`;
};

export function initVoiceRooms() {
  fetchIceConfig();
  setupVoiceUI();
  setupSidebarVoiceDockUI();
  setupPttKeyListeners();
  setupStudyRoomModal();
  connectVoiceSocket();

  // Resume Web Audio Context on click to bypass browser autoplay rules
  window.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  });

  window.toggleScreenShare = async function() {
    if (localScreenStream) {
      localScreenStream.getTracks().forEach(track => track.stop());
      localScreenStream = null;
      alert('🖥️ Screen Share Stopped.');
      return;
    }

    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      alert('🖥️ Screen Share Active! Streaming to channel members.');
      localScreenStream.getVideoTracks()[0].onended = () => {
        localScreenStream = null;
      };
    } catch (err) {
      alert('Screen sharing cancelled or not supported by browser.');
    }
  };
}

function connectVoiceSocket() {
  if (typeof io === 'undefined') return;
  voiceSocket = io('/voice', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10
  });

  setupVoiceSocketListeners();
}

function setupVoiceSocketListeners() {
  if (!voiceSocket) return;

  voiceSocket.on('connect', () => {
    fetchVoiceChannels();
  });

  voiceSocket.on('voice_channels_list', ({ channels }) => {
    renderVoiceChannelsList(channels);
  });

  voiceSocket.on('voice_participants', ({ channelId, participants, screenSharer }) => {
    if (channelId === activeChannelId) {
      updateVoiceParticipantsUI(participants);
      updateSidebarVoiceParticipantsUI(participants);
      syncPeerConnections(participants);

      if (screenSharer && !isSelfSocket(screenSharer)) {
        const container = document.getElementById('voice-screen-video-container');
        const label = document.getElementById('voice-screen-sharer-label');
        if (container) container.style.display = 'block';
        if (label) label.textContent = '🖥️ Classmate Screen Share (Live)';
      }
    }
  });

  voiceSocket.on('voice_error', ({ message }) => {
    alert(`🔊 Voice Room Notice: ${message}`);
  });

  // WebRTC Signaling Handlers
  voiceSocket.on('voice_offer', async ({ from, sdp }) => {
    const pc = createPeerConnection(from);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await processPendingIceCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      voiceSocket.emit('voice_answer', { channelId: activeChannelId, targetSocketId: from, sdp: answer });
    } catch (e) {
      console.error('Error handling voice offer:', e);
    }
  });

  voiceSocket.on('voice_answer', async ({ from, sdp }) => {
    const pc = peerConnections[from];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await processPendingIceCandidates(from, pc);
      } catch (e) {
        console.error('Error setting remote description:', e);
      }
    }
  });

  voiceSocket.on('ice_candidate', async ({ from, candidate }) => {
    const pc = peerConnections[from];
    if (pc && candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('ICE candidate add warning:', e);
        }
      } else {
        if (!pendingIceCandidates[from]) pendingIceCandidates[from] = [];
        pendingIceCandidates[from].push(candidate);
      }
    }
  });

  voiceSocket.on('speaking_state', ({ from, isSpeaking }) => {
    peerSpeakingStates[from] = isSpeaking;
    updateParticipantSpeakingUI(from, isSpeaking);
  });

  voiceSocket.on('screen_share_state', ({ sharerSocketId, isSharing }) => {
    const container = document.getElementById('voice-screen-video-container');
    const label = document.getElementById('voice-screen-sharer-label');
    if (!container) return;

    if (isSharing && !isSelfSocket(sharerSocketId)) {
      container.style.display = 'block';
      if (label) label.textContent = '🖥️ Classmate Screen Share (Live)';
    } else if (!isSharing && !isSelfSocket(sharerSocketId)) {
      container.style.display = 'none';
    }
  });
}

async function processPendingIceCandidates(socketId, pc) {
  if (pendingIceCandidates[socketId] && pendingIceCandidates[socketId].length > 0) {
    for (const candidate of pendingIceCandidates[socketId]) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {}
    }
    delete pendingIceCandidates[socketId];
  }
}

function fetchVoiceChannels() {
  if (voiceSocket && voiceSocket.connected) {
    voiceSocket.emit('get_voice_channels');
  }
}

let activeCategoryFilter = 'all';

function renderVoiceChannelsList(channels) {
  const container = document.getElementById('voice-channels-list');
  if (!container) return;

  if (!channels || channels.length === 0) {
    container.innerHTML = '<div style="color: #94a3b8; padding: 20px; font-size: 0.9rem;">No active voice rooms found. Create one to start!</div>';
    return;
  }

  let filtered = channels;
  if (activeCategoryFilter !== 'all') {
    filtered = channels.filter(c => (c.category || 'Study').toLowerCase() === activeCategoryFilter.toLowerCase());
  }

  container.innerHTML = filtered.map(ch => {
    const isConnected = ch.id === activeChannelId;
    const isFull = ch.participantCount >= ch.limit;
    const isOwner = ch.isDefault ? false : true;

    return `
      <div class="voice-channel-card ${isConnected ? 'connected' : ''}" style="background: rgba(15, 23, 42, 0.75); border: 1px solid ${isConnected ? '#10b981' : 'rgba(255, 255, 255, 0.1)'}; border-radius: 14px; padding: 18px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; backdrop-filter: blur(12px); transition: all 0.2s ease;">
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-size: 0.72rem; font-weight: 900; padding: 3px 9px; border-radius: 99px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; text-transform: uppercase;">
              ${escapeHtml(ch.category || 'General')}
            </span>
            <span style="font-size: 0.75rem; color: #94a3b8; font-weight: 700;">
              👥 ${ch.participantCount}/${ch.limit}
            </span>
          </div>
          <h3 style="color: #fff; font-size: 1.05rem; font-weight: 800; margin: 0 0 4px;">${escapeHtml(ch.name)}</h3>
          <div style="font-size: 0.75rem; color: #94a3b8; display: flex; align-items: center; gap: 8px;">
            <span>⚡ ${ch.bitrate || '96kbps'} HD Audio</span>
            ${ch.screenSharer ? '<span style="color: #fbbf24; font-weight: 800;">🖥️ Screen Share Active</span>' : ''}
          </div>
        </div>

        <div style="display: flex; gap: 8px;">
          ${isConnected ? `
            <button onclick="window.leaveVoiceChannel('${ch.id}')" class="btn-pill" style="background: #ef4444; color: #fff; border: none; flex: 1; justify-content: center; font-weight: 800;">Disconnect</button>
          ` : `
            <button onclick="window.joinVoiceChannel('${ch.id}', '${escapeHtml(ch.name)}')" class="btn-pill primary" style="flex: 1; justify-content: center; font-weight: 800;" ${isFull ? 'disabled' : ''}>
              ${isFull ? 'Full Room' : 'Join Voice Room'}
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');
}

function setupVoiceUI() {
  const muteBtn = document.getElementById('voice-mute-btn');
  const deafenBtn = document.getElementById('voice-deafen-btn');
  const screenBtn = document.getElementById('voice-screen-share-btn');
  const presetSelect = document.getElementById('voice-fx-preset-select');
  const spatialCheck = document.getElementById('voice-spatial-checkbox');

  if (muteBtn) {
    muteBtn.addEventListener('click', toggleMute);
  }
  if (deafenBtn) {
    deafenBtn.addEventListener('click', toggleDeafen);
  }
  if (screenBtn) {
    screenBtn.addEventListener('click', toggleScreenShare);
  }
  if (presetSelect) {
    presetSelect.addEventListener('change', (e) => {
      applyVoicePreset(e.target.value);
    });
  }
  if (spatialCheck) {
    spatialCheck.addEventListener('change', (e) => {
      isSpatialAudioEnabled = e.target.checked;
    });
  }

  // Category Tabs
  const catTabs = document.querySelectorAll('.voice-cat-tab');
  catTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      catTabs.forEach(t => {
        t.style.background = 'rgba(255,255,255,0.05)';
        t.style.color = '#94a3b8';
      });
      tab.style.background = 'rgba(56,189,248,0.15)';
      tab.style.color = '#38bdf8';
      activeCategoryFilter = tab.dataset.cat || 'all';
      fetchVoiceChannels();
    });
  });
}

function setupSidebarVoiceDockUI() {
  const sideMuteBtn = document.getElementById('sidebar-voice-mute-btn');
  const sideDeafenBtn = document.getElementById('sidebar-voice-deafen-btn');
  const sideDisconnectBtn = document.getElementById('sidebar-voice-disconnect-btn');

  if (sideMuteBtn) sideMuteBtn.addEventListener('click', toggleMute);
  if (sideDeafenBtn) sideDeafenBtn.addEventListener('click', toggleDeafen);
  if (sideDisconnectBtn) sideDisconnectBtn.addEventListener('click', () => {
    if (activeChannelId) window.leaveVoiceChannel(activeChannelId);
  });
}

function setupStudyRoomModal() {
  const openBtn = document.getElementById('open-create-study-room-btn');
  const modal = document.getElementById('create-study-room-modal');
  const closeBtn = document.getElementById('create-study-room-modal-close');
  const form = document.getElementById('create-study-room-form');

  if (openBtn && modal) openBtn.addEventListener('click', () => modal.classList.add('active'));
  if (closeBtn && modal) closeBtn.addEventListener('click', () => modal.classList.remove('active'));

  if (form && modal) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const user = getCurrentUser();
      if (!user) return alert('Please sign in to create voice rooms.');

      const name = document.getElementById('study-room-name-input')?.value;
      const category = document.getElementById('study-room-category-select')?.value;
      const limit = document.getElementById('study-room-limit-input')?.value;
      const password = document.getElementById('study-room-password-input')?.value;

      if (voiceSocket) {
        voiceSocket.emit('create_study_room', { name, category, limit, password, user });
      }

      modal.classList.remove('active');
    });
  }
}

function setupPttKeyListeners() {
  window.addEventListener('keydown', (e) => {
    if (voiceActivationMode === 'ptt' && e.code === 'Space' && !isPttPressed && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      isPttPressed = true;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (voiceActivationMode === 'ptt' && e.code === 'Space' && isPttPressed) {
      isPttPressed = false;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
    }
  });
}

function startAudioLevelDetection(stream) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    micSource = audioCtx.createMediaStreamSource(stream);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    micSource.connect(micAnalyser);

    const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);

    if (audioCheckInterval) clearInterval(audioCheckInterval);
    audioCheckInterval = setInterval(() => {
      if (!micAnalyser || isMuted) {
        if (isSpeakingLocally) {
          isSpeakingLocally = false;
          emitSpeakingState(false);
        }
        return;
      }
      micAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const average = sum / dataArray.length;

      const isSpeaking = average > 22;
      if (isSpeaking !== isSpeakingLocally) {
        isSpeakingLocally = isSpeaking;
        emitSpeakingState(isSpeaking);
      }
    }, 120);
  } catch (e) {
    console.warn('Audio level detection initialization error:', e);
  }
}

function stopAudioLevelDetection() {
  if (audioCheckInterval) clearInterval(audioCheckInterval);
  audioCheckInterval = null;
  isSpeakingLocally = false;
}

function emitSpeakingState(isSpeaking) {
  if (voiceSocket && activeChannelId) {
    voiceSocket.emit('speaking_state', { channelId: activeChannelId, isSpeaking });
  }
  if (voiceSocket) {
    updateParticipantSpeakingUI(voiceSocket.id, isSpeaking);
  }
}

function applyVoicePreset(preset) {
  currentVoicePreset = preset;
  if (!audioCtx || !micSource) return;

  fxNodes.forEach(n => { try { n.disconnect(); } catch(e){} });
  fxNodes = [];

  const destination = audioCtx.createMediaStreamDestination();

  if (preset === 'robot') {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(50, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.5, audioCtx.currentTime);

    micSource.connect(gain);
    osc.connect(gain.gain);
    gain.connect(destination);
    osc.start();
    fxNodes.push(osc, gain);
  } else if (preset === 'echo') {
    const delay = audioCtx.createDelay();
    delay.delayTime.value = 0.25;
    const feedback = audioCtx.createGain();
    feedback.gain.value = 0.4;
    const dryGain = audioCtx.createGain();

    micSource.connect(dryGain);
    dryGain.connect(destination);
    micSource.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(destination);
    fxNodes.push(delay, feedback, dryGain);
  } else {
    micSource.connect(destination);
  }

  processedStream = destination.stream;
  const newTrack = processedStream.getAudioTracks()[0];

  if (newTrack) {
    newTrack.enabled = !isMuted;
    Object.values(peerConnections).forEach(pc => {
      const senders = pc.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender) {
        audioSender.replaceTrack(newTrack);
      }
    });
  }
}

function createPeerConnection(targetSocketId) {
  if (peerConnections[targetSocketId]) return peerConnections[targetSocketId];

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[targetSocketId] = pc;

  const streamToSend = processedStream || localStream;
  if (streamToSend) {
    streamToSend.getTracks().forEach(track => pc.addTrack(track, streamToSend));
  } else {
    // BUGFIX: users who denied mic access (listen-only mode) had `streamToSend`
    // as null, so no audio track was ever added to the connection. That meant
    // the SDP offer/answer had NO audio m-line at all, so this peer couldn't
    // receive anyone else's audio either — not just fail to send their own.
    // Explicitly add a recvonly audio transceiver so listen-only users still
    // negotiate an audio channel and can hear everyone else.
    try {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    } catch (e) {
      console.warn('Could not add recvonly audio transceiver:', e);
    }
  }

  pc.onicecandidate = (event) => {
    if (event.candidate && voiceSocket) {
      voiceSocket.emit('ice_candidate', {
        channelId: activeChannelId,
        targetSocketId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    let stream = event.streams[0];
    if (!stream) {
      stream = new MediaStream([event.track]);
    }
    const isVideo = event.track.kind === 'video';

    if (isVideo) {
      const screenVideo = document.getElementById('voice-screen-video');
      const screenContainer = document.getElementById('voice-screen-video-container');
      if (screenVideo) {
        screenVideo.srcObject = stream;
        if (screenContainer) screenContainer.style.display = 'block';
      }
      return;
    }

    let audioEl = document.getElementById(`audio-peer-${targetSocketId}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `audio-peer-${targetSocketId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
    audioEl.muted = isDeafened;
    audioEl.volume = Math.min(1.0, Math.max(0.0, peerVolumes[targetSocketId] ?? 1.0));

    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      if (isSpatialAudioEnabled) {
        const peerSource = audioCtx.createMediaStreamSource(stream);
        const panner = audioCtx.createStereoPanner();
        const peerCount = Object.keys(peerConnections).length;
        const panVal = Math.max(-0.8, Math.min(0.8, (peerCount % 2 === 0 ? 0.6 : -0.6) * (0.5 + (peerCount * 0.15))));
        panner.pan.setValueAtTime(panVal, audioCtx.currentTime);
        peerSource.connect(panner);
        peerPannerNodes[targetSocketId] = panner;
      }
    } catch (e) {
      console.warn('Web Audio spatial panning setup warning:', e);
    }

    audioEl.play().catch(err => console.warn(`Peer audio playback deferred for ${targetSocketId}:`, err.message));
  };

  return pc;
}

function syncPeerConnections(participants) {
  if (!participants) return;
  const myCleanId = cleanSocketId(voiceSocket?.id);
  const currentPeerIds = participants.map(p => typeof p === 'object' ? p.socketId : p).filter(id => cleanSocketId(id) !== myCleanId);

  currentPeerIds.forEach(id => {
    const cleanPeerId = cleanSocketId(id);
    const cleanMyId = cleanSocketId(voiceSocket.id);
    if (!peerConnections[id] && cleanMyId < cleanPeerId) {
      const pc = createPeerConnection(id);
      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        voiceSocket.emit('voice_offer', { channelId: activeChannelId, targetSocketId: id, sdp: pc.localDescription });
      }).catch(e => console.error('Error creating offer:', e));
    }
  });

  Object.keys(peerConnections).forEach(id => {
    if (!currentPeerIds.includes(id)) {
      peerConnections[id].close();
      delete peerConnections[id];
      delete peerPannerNodes[id];
      delete pendingIceCandidates[id];
      const audioEl = document.getElementById(`audio-peer-${id}`);
      if (audioEl) audioEl.remove();
    }
  });
}

function toggleMute() {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  if (processedStream) {
    processedStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  updateMuteDeafenUI();
}

function toggleDeafen() {
  isDeafened = !isDeafened;
  if (isDeafened && !isMuted) toggleMute();

  document.querySelectorAll('audio[id^="audio-peer-"]').forEach(el => {
    el.muted = isDeafened;
  });
  updateMuteDeafenUI();
}

async function toggleScreenShare() {
  if (localScreenStream) {
    stopScreenSharing();
    return;
  }

  try {
    localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = localScreenStream.getVideoTracks()[0];

    Object.values(peerConnections).forEach(pc => {
      pc.addTrack(screenTrack, localScreenStream);
    });

    if (voiceSocket && activeChannelId) {
      voiceSocket.emit('screen_share_start', { channelId: activeChannelId });
    }

    screenTrack.onended = () => {
      stopScreenSharing();
    };

    const btn = document.getElementById('voice-screen-share-btn');
    if (btn) btn.textContent = '🛑 Stop Sharing';
  } catch (e) {
    alert('Screen sharing cancelled or unavailable.');
  }
}

function stopScreenSharing() {
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(t => t.stop());
    localScreenStream = null;

    if (voiceSocket && activeChannelId) {
      voiceSocket.emit('screen_share_stop', { channelId: activeChannelId });
    }
  }

  const container = document.getElementById('voice-screen-video-container');
  if (container) container.style.display = 'none';
  const btn = document.getElementById('voice-screen-share-btn');
  if (btn) btn.textContent = '🖥️ Share Screen';
}

function updateMuteDeafenUI() {
  const muteBtn = document.getElementById('voice-mute-btn');
  const muteIcon = document.getElementById('voice-mute-icon');
  const muteText = document.getElementById('voice-mute-text');

  if (muteIcon) muteIcon.textContent = isMuted ? '🎙️❌' : '🎙️';
  if (muteText) muteText.textContent = isMuted ? 'Unmute' : 'Mute';
  if (muteBtn) muteBtn.style.background = isMuted ? '#ef4444' : 'rgba(255,255,255,0.08)';

  const sideMuteIcon = document.getElementById('sidebar-voice-mute-icon');
  const sideMuteText = document.getElementById('sidebar-voice-mute-text');
  if (sideMuteIcon) sideMuteIcon.textContent = isMuted ? '🎙️❌' : '🎙️';
  if (sideMuteText) sideMuteText.textContent = isMuted ? 'Unmute' : 'Mute';

  const deafenBtn = document.getElementById('voice-deafen-btn');
  const deafenIcon = document.getElementById('voice-deafen-icon');
  const deafenText = document.getElementById('voice-deafen-text');

  if (deafenIcon) deafenIcon.textContent = isDeafened ? '🔈' : '🎧';
  if (deafenText) deafenText.textContent = isDeafened ? 'Undeafen' : 'Deafen';
  if (deafenBtn) deafenBtn.style.background = isDeafened ? '#ef4444' : 'rgba(255,255,255,0.08)';

  const sideDeafenIcon = document.getElementById('sidebar-voice-deafen-icon');
  const sideDeafenText = document.getElementById('sidebar-voice-deafen-text');
  if (sideDeafenIcon) sideDeafenIcon.textContent = isDeafened ? '🔈' : '🎧';
  if (sideDeafenText) sideDeafenText.textContent = isDeafened ? 'Deafen' : 'Deafen';
}

window.joinVoiceChannel = async (channelId, channelName) => {
  const user = getCurrentUser();
  if (!user) return alert('Please sign in to join voice channels.');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    if (voiceActivationMode === 'ptt') {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
    }
    startAudioLevelDetection(localStream);
  } catch (e) {
    console.warn('Microphone permission denied, joining in listen-only mode:', e.message);
    localStream = null;
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    alert('🎙️ Joining in Listen-Only Mode (Microphone access was denied or unavailable).');
  }

  activeChannelId = channelId;
  activeChannelName = channelName || 'General Voice Lounge';

  const bar = document.getElementById('voice-connected-bar');
  const label = document.getElementById('voice-connected-label');
  if (bar) bar.style.display = 'flex';
  if (label) label.textContent = `🔊 Connected: ${activeChannelName}`;

  const sideDock = document.getElementById('sidebar-voice-dock');
  const sideLabel = document.getElementById('sidebar-voice-channel-name');
  if (sideDock) sideDock.style.display = 'block';
  if (sideLabel) sideLabel.textContent = activeChannelName;

  if (voiceSocket) {
    voiceSocket.emit('voice_join', { channelId, user });
    initBoardGames(voiceSocket, channelId);
  }

  const sharedSocket = getSharedSocket();
  if (sharedSocket) {
    sharedSocket.emit('update_activity', { activity: `In Voice Room #${activeChannelName}` });
  }

  fetchVoiceChannels();
};

window.leaveVoiceChannel = (channelId) => {
  cleanupBoardGames();
  stopAudioLevelDetection();
  stopScreenSharing();

  if (activeChannelId && voiceSocket) {
    voiceSocket.emit('voice_leave', { channelId: activeChannelId });
  }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  peerPannerNodes = {};

  activeChannelId = null;

  const bar = document.getElementById('voice-connected-bar');
  if (bar) bar.style.display = 'none';

  const sideDock = document.getElementById('sidebar-voice-dock');
  if (sideDock) sideDock.style.display = 'none';

  const sharedSocket = getSharedSocket();
  if (sharedSocket) {
    sharedSocket.emit('update_activity', { activity: 'Exploring Platform' });
  }

  fetchVoiceChannels();
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateVoiceParticipantsUI(participants) {
  const list = document.getElementById('voice-participants-list');
  if (!list) return;

  if (!participants || participants.length === 0) {
    list.innerHTML = '<span style="color: #94a3b8; font-size: 0.8rem;">No participants currently in channel.</span>';
    return;
  }

  list.innerHTML = participants.map((p, idx) => {
    const isObj = typeof p === 'object' && p !== null;
    const socketId = isObj ? (p.socketId || `peer_${idx}`) : p;
    const username = isObj ? (p.username || 'Student') : `Peer #${idx + 1}`;
    const displayName = isObj ? (p.display_name || p.username || 'Student') : `Peer #${idx + 1}`;
    const role = isObj ? (p.role || 'member') : 'member';

    const isSpeaking = peerSpeakingStates[socketId] || (isSelfSocket(socketId) && isSpeakingLocally);

    const isOwner = role === 'owner' || username.toLowerCase() === 'jordandaniels';
    const isPro = role === 'pro' || role === 'vip' || role === 'admin';
    const badgeLabel = isOwner ? '👑 OWNER' : (role ? role.toUpperCase() : 'STUDENT');
    const badgeBg = isOwner ? 'linear-gradient(90deg, #fbbf24, #ef4444)' : (isPro ? 'linear-gradient(90deg, #38bdf8, #818cf8)' : 'rgba(255,255,255,0.12)');
    const badgeColor = isOwner || isPro ? '#000' : '#94a3b8';

    const isSelf = isSelfSocket(socketId);
    const currentVol = peerVolumes[socketId] ?? 1.0;

    return `
      <div id="voice-part-${socketId}" class="voice-participant-chip voice-participant-pill ${isSpeaking ? 'speaking is-speaking' : ''}" style="display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.35); border: 1px solid ${isSpeaking ? '#10b981' : 'rgba(255,255,255,0.1)'}; padding: 6px 14px; border-radius: 99px; font-size: 0.85rem; color: #fff; transition: all 0.2s ease; box-shadow: ${isSpeaking ? '0 0 14px rgba(16, 185, 129, 0.4)' : 'none'};">
        <span class="online-dot voice-avatar ${isSpeaking ? 'speaking' : ''}" style="width: 10px; height: 10px; background: #10b981; border-radius: 50%; display: inline-block;"></span>
        <strong style="color: #fff;">${escapeHtml(displayName)}</strong>
        <span style="font-size: 0.75rem; color: #94a3b8;">(@${escapeHtml(username)})</span>
        <span style="font-size: 0.65rem; font-weight: 900; padding: 2px 7px; border-radius: 6px; background: ${badgeBg}; color: ${badgeColor}; text-transform: uppercase;">${badgeLabel}</span>
        ${!isSelf ? `
          <div style="display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; background: rgba(0,0,0,0.4); padding: 2px 8px; border-radius: 99px; border: 1px solid rgba(255,255,255,0.1);" title="Adjust Peer Volume">
            <span style="font-size: 0.7rem;">🔊</span>
            <input type="range" min="0" max="1.5" step="0.05" value="${currentVol}" oninput="window.setPeerVolume('${socketId}', this.value)" style="width: 55px; height: 3px; accent-color: #38bdf8; cursor: pointer;">
            <span id="vol-val-${socketId}" style="font-size: 0.65rem; color: #38bdf8; font-weight: 800; width: 28px;">${Math.round(currentVol * 100)}%</span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function updateSidebarVoiceParticipantsUI(participants) {
  const tray = document.getElementById('sidebar-voice-participants-tray');
  if (!tray) return;

  if (!participants || participants.length === 0) {
    tray.innerHTML = '<span style="color: #94a3b8; font-size: 0.75rem;">Connecting to channel...</span>';
    return;
  }

  tray.innerHTML = participants.map((p, idx) => {
    const isObj = typeof p === 'object' && p !== null;
    const socketId = isObj ? (p.socketId || `peer_${idx}`) : p;
    const username = isObj ? (p.username || 'Student') : `Peer #${idx + 1}`;
    const displayName = isObj ? (p.display_name || p.username || 'Student') : `Peer #${idx + 1}`;
    const isSpeaking = peerSpeakingStates[socketId] || (isSelfSocket(socketId) && isSpeakingLocally);
    const isSelf = isSelfSocket(socketId);
    const currentVol = peerVolumes[socketId] ?? 1.0;

    return `
      <div id="sidebar-voice-part-${socketId}" class="voice-participant-row ${isSpeaking ? 'speaking is-speaking' : ''}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div id="sidebar-voice-avatar-${socketId}" class="voice-avatar-wrap voice-avatar ${isSpeaking ? 'speaking speaking-ring' : ''}">
            👤
          </div>
          <span style="color: #fff; font-weight: 700; font-size: 0.82rem;">${escapeHtml(displayName)}</span>
        </div>
        ${!isSelf ? `
          <div style="display: flex; align-items: center; gap: 4px;" title="Adjust Volume">
            <input type="range" min="0" max="1.5" step="0.05" value="${currentVol}" oninput="window.setPeerVolume('${socketId}', this.value)" style="width: 45px; height: 3px; accent-color: #10b981; cursor: pointer;">
            <span id="sidebar-vol-val-${socketId}" style="font-size: 0.65rem; color: #10b981; font-weight: 700; width: 26px;">${Math.round(currentVol * 100)}%</span>
          </div>
        ` : `<span style="font-size: 0.7rem; color: #10b981;">● You</span>`}
      </div>
    `;
  }).join('');
}

function updateParticipantSpeakingUI(socketId, isSpeaking) {
  const chip = document.getElementById(`voice-part-${socketId}`);
  if (chip) {
    if (isSpeaking) {
      chip.classList.add('speaking', 'is-speaking');
      chip.style.borderColor = '#10b981';
      chip.style.boxShadow = '0 0 14px rgba(16, 185, 129, 0.4)';
    } else {
      chip.classList.remove('speaking', 'is-speaking');
      chip.style.borderColor = 'rgba(255,255,255,0.1)';
      chip.style.boxShadow = 'none';
    }
  }

  const sidebarRow = document.getElementById(`sidebar-voice-part-${socketId}`);
  if (sidebarRow) {
    if (isSpeaking) {
      sidebarRow.classList.add('speaking', 'is-speaking');
    } else {
      sidebarRow.classList.remove('speaking', 'is-speaking');
    }
  }
}
