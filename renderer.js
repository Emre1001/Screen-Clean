// Window Controls
document.getElementById('min-btn').addEventListener('click', () => window.electronAPI.windowControl('minimize'));
document.getElementById('max-btn').addEventListener('click', () => window.electronAPI.windowControl('maximize'));
document.getElementById('close-btn').addEventListener('click', () => window.electronAPI.windowControl('close'));

// PeerJS Networking
let peer;
let conn;
let incomingCallConfig = null;
let streamInstance = null;
let isHost = false;

// UI Elements
const hostCodeEl = document.getElementById('host-code');
const joinCodeIn = document.getElementById('join-code');
const joinBtn = document.getElementById('join-btn');
const joinStatus = document.getElementById('join-status');
const confirmModal = document.getElementById('confirm-modal');
const settingsModal = document.getElementById('settings-modal');
const acceptBtn = document.getElementById('accept-btn');
const rejectBtn = document.getElementById('reject-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');

// Global Shortcut Listener
window.electronAPI.onShortcut((value) => {
    if (value === 'stop') {
        if (isHost && streamInstance) {
            stopScreenShare();
            if (conn) conn.send({ type: 'error', message: 'Host hat die Übertragung beendet.' });
        } else if (!isHost && conn) {
            disconnectBtn.click();
        }
    }
});
const perfModeSelect = document.getElementById('perf-mode-select');
const dynamicSettings = document.getElementById('dynamic-settings');
const manualSettings = document.getElementById('manual-settings');

const dynamicSlider = document.getElementById('dynamic-slider');
const manualRes = document.getElementById('manual-res');
const manualFps = document.getElementById('manual-fps');
const manualBitrate = document.getElementById('manual-bitrate');

const allowControlToggle = document.getElementById('allow-control');

// Custom Dropdown Logic
document.querySelectorAll('.custom-select').forEach(select => {
    const trigger = select.querySelector('.select-trigger');
    const options = select.querySelectorAll('.option');

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close all other dropdowns
        document.querySelectorAll('.custom-select').forEach(other => {
            if (other !== select) other.classList.remove('active');
        });
        select.classList.toggle('active');
    });

    options.forEach(option => {
        option.addEventListener('click', () => {
            const value = option.dataset.value;
            const label = option.innerText;
            select.dataset.value = value;
            trigger.querySelector('span').innerText = label;
            select.classList.remove('active');

            // Trigger change logic based on ID
            if (select.id === 'perf-mode-select') {
                dynamicSettings.style.display = value === 'dynamic' ? 'flex' : 'none';
                manualSettings.style.display = value === 'manual' ? 'flex' : 'none';
            }
        });
    });
});

// Close dropdowns on outside click
window.addEventListener('click', () => {
    document.querySelectorAll('.custom-select').forEach(select => select.classList.remove('active'));
});

document.getElementById('open-settings').addEventListener('click', () => settingsModal.classList.add('show'));
document.getElementById('close-settings').addEventListener('click', () => settingsModal.classList.remove('show'));

function copyCode() {
    navigator.clipboard.writeText(hostCodeEl.innerText);
    const tooltip = document.querySelector('.tooltiptext');
    tooltip.innerText = "Kopiert!";
    setTimeout(() => tooltip.innerText = "Kopieren", 2000);
}

// Generate 12-digit code
function generateCode() {
    return Math.floor(100000000000 + Math.random() * 900000000000).toString();
}

async function initPeer(customId = null) {
    const id = customId || generateCode();
    // Use PeerJS public server with Google STUN servers for NAT traversal (Internet connectivity)
    peer = new Peer(id, {
        config: {
            'iceServers': [
                { 'urls': 'stun:stun.l.google.com:19302' },
                { 'urls': 'stun:stun1.l.google.com:19302' },
                { 'urls': 'stun:stun2.l.google.com:19302' },
                { 'urls': 'stun:stun3.l.google.com:19302' },
                { 'urls': 'stun:stun4.l.google.com:19302' },
            ],
            'sdpSemantics': 'unified-plan'
        }
    });
    
    return new Promise((resolve) => {
        peer.on('open', (peerId) => {
            resolve(peerId);
        });
        
        peer.on('connection', (connection) => {
            conn = connection;
            setupHostConnection();
        });

        // Receiving a call (Host)
        peer.on('call', (call) => {
            incomingCallConfig = call;
            confirmModal.classList.add('show');
        });
        
        peer.on('error', (err) => {
            console.error('Peer error:', err);
            joinStatus.innerText = "Fehler: " + err.message;
            joinBtn.disabled = false;
        });
    });
}

// Start Host immediately to show code
initPeer().then(id => {
    hostCodeEl.innerText = id;
    isHost = true;
});

// Refresh code button
document.getElementById('refresh-code').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-code');
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.5';
    hostCodeEl.innerText = "Generating...";
    
    if (peer) {
        peer.destroy();
    }
    
    // Small delay to ensure cleanup
    setTimeout(async () => {
        const id = await initPeer();
        hostCodeEl.innerText = id;
        isHost = true;
        btn.style.pointerEvents = 'auto';
        btn.style.opacity = '1';
    }, 100);
});

// Host Logic
function setupHostConnection() {
    conn.on('data', (data) => {
        // Control messages from viewer
        if (!allowControlToggle.querySelector('input').checked) return;
        
        // Pass to Electron main process
        if (data.type) {
            window.electronAPI.sendInputEvent(data.type, data.payload);
        }
    });

    conn.on('close', () => {
        stopScreenShare();
    });
}

acceptBtn.addEventListener('click', async () => {
    confirmModal.classList.remove('show');
    if (!incomingCallConfig) return;

    try {
        const sources = await window.electronAPI.getSources();
        if (sources.length === 0) throw new Error("No screen source found");
        
        const sourceId = sources[0].id; 
        const audioEnabled = setAudio.querySelector('input').checked;
        const perfMode = perfModeSelect.dataset.value;
        
        let frameRate = 60;
        let minHeight = undefined;
        let maxHeight = undefined;

        if (perfMode === 'full-auto') {
            frameRate = 120;
        } else if (perfMode === 'dynamic') {
            frameRate = 60; 
        } else if (perfMode === 'manual') {
            frameRate = parseInt(manualFps.dataset.value);
            const res = parseInt(manualRes.dataset.value);
            if (res > 0) {
                maxHeight = res;
            }
        }
        
        const constraints = {
            audio: audioEnabled ? {
                mandatory: {
                    chromeMediaSource: 'desktop'
                }
            } : false,
            video: {
                mandatory: Object.assign({
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    minFrameRate: 15,
                    maxFrameRate: frameRate
                }, maxHeight ? { maxHeight: maxHeight } : {})
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamInstance = stream;
        
        incomingCallConfig.answer(stream);

        // Apply advanced settings via RTCRtpSender
        incomingCallConfig.peerConnection.addEventListener('signalingstatechange', () => {
            if (incomingCallConfig.peerConnection.signalingState === 'stable') {
                const senders = incomingCallConfig.peerConnection.getSenders();
                for (const sender of senders) {
                    if (sender.track.kind === 'video') {
                        const parameters = sender.getParameters();
                        if (!parameters.encodings) parameters.encodings = [{}];
                        
                        if (perfMode === 'dynamic') {
                            const val = parseInt(dynamicSlider.value);
                            // 1-3: Qualität (maintain-resolution), 4-7: balanced, 8-10: FPS (maintain-framerate)
                            if (val <= 3) parameters.degradationPreference = 'maintain-resolution';
                            else if (val <= 7) parameters.degradationPreference = 'balanced';
                            else parameters.degradationPreference = 'maintain-framerate';
                        } else if (perfMode === 'manual') {
                            const bps = parseInt(manualBitrate.dataset.value);
                            if (bps > 0) {
                                parameters.encodings[0].maxBitrate = bps * 1000;
                            }
                        }
                        
                        sender.setParameters(parameters).catch(e => console.warn('Parameters setting failed', e));
                    }
                }
            }
        });
        
        document.querySelector('.host-icon').innerText = "🔴";
        document.querySelector('.host-icon').style.animation = "pulse 2s infinite";

    } catch (e) {
        console.error("Screen capture failed:", e);
        conn.send({ type: 'error', message: 'Host could not share screen.' });
    }
});

rejectBtn.addEventListener('click', () => {
    confirmModal.classList.remove('show');
    if (conn) conn.close();
    incomingCallConfig = null;
});

function stopScreenShare() {
    if (streamInstance) {
        streamInstance.getTracks().forEach(track => track.stop());
        streamInstance = null;
    }
    document.querySelector('.host-icon').innerText = "🖥️";
    document.querySelector('.host-icon').style.animation = "none";
}

// Viewer Logic
joinBtn.addEventListener('click', async () => {
    const code = joinCodeIn.value.trim();
    if (code.length < 12) {
        joinStatus.innerText = "Bitte 12 Ziffern eingeben.";
        return;
    }

    joinStatus.innerText = "Verbinde...";
    joinBtn.disabled = true;

    if (peer) {
        peer.destroy();
    }
    
    const viewerId = await initPeer(null); 
    isHost = false;

    conn = peer.connect(code);
    
    conn.on('open', () => {
        joinStatus.innerText = "Warte auf Host...";
        
        // Viewer sends a dummy call to trigger answer from Host
        const call = peer.call(code, createEmptyAudioStream());
        
        call.on('stream', (remoteStream) => {
            showVideoPage(remoteStream);
        });
        
        call.on('close', () => {
            backToDashboard();
        });
        call.on('error', () => {
            backToDashboard();
        });
    });

    conn.on('close', () => {
        backToDashboard();
    });
});

function createEmptyAudioStream() {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    return dest.stream;
}

function showVideoPage(stream) {
    document.getElementById('dashboard').classList.remove('active');
    const videoView = document.getElementById('video-view');
    videoView.classList.add('active');
    
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = stream;

    setupRemoteControlListeners(remoteVideo);
}

fullscreenBtn.addEventListener('click', () => {
    const videoView = document.getElementById('video-view');
    if (!document.fullscreenElement) {
        videoView.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message}`);
        });
        fullscreenBtn.innerText = "✖ Exit Fullscreen";
    } else {
        document.exitFullscreen();
        fullscreenBtn.innerText = "⛶ Fullscreen";
    }
});

document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        fullscreenBtn.innerText = "⛶ Fullscreen";
    }
});

function backToDashboard() {
    document.getElementById('video-view').classList.remove('active');
    document.getElementById('dashboard').classList.add('active');
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = null;
    joinBtn.disabled = false;
    joinStatus.innerText = "Verbindung getrennt.";
}

disconnectBtn.addEventListener('click', () => {
    if (conn) conn.close();
    backToDashboard();
});

// Remote Control Context
function setupRemoteControlListeners(videoElement) {
    if (isHost) return;
    
    videoElement.addEventListener('mousemove', (e) => {
        if (!conn || !conn.open) return;
        const rect = videoElement.getBoundingClientRect();
        // Calculate true relative video coordinates, avoiding letterboxing
        // This is a simplified approach, usually we need actual video resolution vs element size
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        
        conn.send({ type: 'mousemove', payload: { x, y } });
    });

    videoElement.addEventListener('mousedown', (e) => {
        if (!conn || !conn.open) return;
        conn.send({ type: 'mousedown', payload: { button: e.button } });
    });

    videoElement.addEventListener('mouseup', (e) => {
        if (!conn || !conn.open) return;
        conn.send({ type: 'mouseup', payload: { button: e.button } });
    });

    window.addEventListener('keydown', (e) => {
        if (!document.getElementById('video-view').classList.contains('active')) return;
        e.preventDefault();
        conn.send({ type: 'keydown', payload: { key: e.key } });
    });

    window.addEventListener('keyup', (e) => {
        if (!document.getElementById('video-view').classList.contains('active')) return;
        e.preventDefault();
        conn.send({ type: 'keyup', payload: { key: e.key } });
    });
}
