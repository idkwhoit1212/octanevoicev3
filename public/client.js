// Octane 3D Positional Voice with LiveKit Cloud
(function () {
    let currentRoom = null;
    let wsTelemetry = null;
    let audioCtx = null;
    let localAnalyser = null;
    let myUserId = null;
    let myRoomId = null;
    let isMuted = false;

    // Хранилище участников: userId -> { panner, gainNode, sourceNode, element }
    const audioNodes = new Map();

    const joinSection = document.getElementById('joinSection');
    const voiceSection = document.getElementById('voiceSection');
    const codeInput = document.getElementById('codeInput');
    const connectBtn = document.getElementById('connectBtn');
    const muteBtn = document.getElementById('muteBtn');
    const micMeter = document.getElementById('micMeter');
    const playerLabel = document.getElementById('playerLabel');
    const peerCountLabel = document.getElementById('peerCountLabel');
    const peersList = document.getElementById('peersList');
    const statusLabel = document.getElementById('statusLabel');

    // Проверяем параметр ?code=1234
    const urlParams = new URLSearchParams(window.location.search);
    const queryCode = urlParams.get('code');
    if (queryCode) {
        codeInput.value = queryCode;
        setTimeout(() => connectWithCode(queryCode), 300);
    }

    connectBtn.addEventListener('click', () => {
        const code = codeInput.value.trim();
        if (code.length === 4) {
            connectWithCode(code);
        } else {
            alert('Введите 4 цифры из чата игры');
        }
    });

    muteBtn.addEventListener('click', toggleMute);

    async function connectWithCode(code) {
        try {
            connectBtn.disabled = true;
            connectBtn.innerText = 'Проверка кода...';

            const resp = await fetch(`/api/resolve_code/${code}`);
            if (!resp.ok) {
                throw new Error('Код не найден или истёк! Запросите новый в игре через /voice');
            }
            const data = await resp.json();
            myRoomId = data.roomId;
            myUserId = Number(data.userId);
            playerLabel.innerText = data.username;

            await connectToLiveKit(data.livekitUrl, data.token);
        } catch (err) {
            alert(err.message || 'Ошибка подключения');
            connectBtn.disabled = false;
            connectBtn.innerText = 'Подключиться';
        }
    }

    async function connectToLiveKit(livekitUrl, token) {
        connectBtn.innerText = 'Подключение к LiveKit...';

        // Инициализируем Web Audio Context
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        // Создаем LiveKit Room
        currentRoom = new LivekitClient.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        // Слушаем входящие аудио-треки других игроков и подключаем их к 3D Panner
        currentRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === LivekitClient.Track.Kind.Audio) {
                setupRemote3DAudio(participant, track);
            }
        });

        currentRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            removeRemoteAudio(participant.identity);
        });

        currentRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            removeRemoteAudio(participant.identity);
            updatePeerListUI();
        });

        currentRoom.on(LivekitClient.RoomEvent.ParticipantConnected, () => {
            updatePeerListUI();
        });

        currentRoom.on(LivekitClient.RoomEvent.Disconnected, () => {
            statusLabel.innerText = 'Отключено от LiveKit';
            document.getElementById('netIndicator').classList.remove('active');
        });

        // Подключаемся к LiveKit Cloud
        await currentRoom.connect(livekitUrl, token);

        // Включаем микрофон
        await currentRoom.localParticipant.setMicrophoneEnabled(true);

        // Получаем локальный аудиотрек для визуализации громкости в HUD
        const localPublication = currentRoom.localParticipant.getTrackPublication(LivekitClient.Track.Kind.Audio);
        if (localPublication && localPublication.track) {
            setupLocalAnalyser(localPublication.track.mediaStreamTrack);
        }

        // Подключаем WebSocket телеметрии для 3D позиций
        connectTelemetryWS();

        joinSection.style.display = 'none';
        voiceSection.style.display = 'block';
        updatePeerListUI();
    }

    function setupRemote3DAudio(participant, track) {
        const remoteUserId = Number(participant.identity);
        if (!remoteUserId || remoteUserId === myUserId) return;

        // Создаем MediaStream из входящего WebRTC трека
        const stream = new MediaStream([track.mediaStreamTrack]);
        const sourceNode = audioCtx.createMediaStreamSource(stream);

        // 3D PannerNode (HRTF пространственный звук)
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 12; // Радиус громкого звука (стады Roblox)
        panner.maxDistance = 160; // Максимальная дистанция слышимости
        panner.rolloffFactor = 1.3;

        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 1.0;

        sourceNode.connect(panner);
        panner.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        // Сохраняем ноду
        audioNodes.set(remoteUserId, {
            panner,
            gainNode,
            sourceNode,
            name: participant.name || `Игрок ${remoteUserId}`
        });

        updatePeerListUI();
    }

    function removeRemoteAudio(identity) {
        const remoteUserId = Number(identity);
        const nodeData = audioNodes.get(remoteUserId);
        if (nodeData) {
            if (nodeData.sourceNode) nodeData.sourceNode.disconnect();
            if (nodeData.panner) nodeData.panner.disconnect();
            if (nodeData.gainNode) nodeData.gainNode.disconnect();
            audioNodes.delete(remoteUserId);
        }
    }

    function connectTelemetryWS() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsTelemetry = new WebSocket(`${wsProtocol}//${window.location.host}`);

        wsTelemetry.onopen = () => {
            wsTelemetry.send(JSON.stringify({
                type: 'telemetry_join',
                roomId: myRoomId,
                userId: myUserId,
                username: playerLabel.innerText
            }));
        };

        wsTelemetry.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);
                if (data.type === 'positions_update') {
                    update3DAudioPositions(data.positions);
                }
            } catch (e) {}
        };
    }

    function update3DAudioPositions(positions) {
        if (!audioCtx) return;

        // Слушатель (Listener) — позиция и поворот нашего персонажа
        const me = positions.find(p => Number(p.userId) === myUserId);
        if (me) {
            const listener = audioCtx.listener;
            const now = audioCtx.currentTime;

            if (listener.positionX) {
                listener.positionX.setValueAtTime(me.x, now);
                listener.positionY.setValueAtTime(me.y, now);
                listener.positionZ.setValueAtTime(me.z, now);
                listener.forwardX.setValueAtTime(me.lookX, now);
                listener.forwardY.setValueAtTime(me.lookY, now);
                listener.forwardZ.setValueAtTime(me.lookZ, now);
                listener.upX.setValueAtTime(0, now);
                listener.upY.setValueAtTime(1, now);
                listener.upZ.setValueAtTime(0, now);
            } else {
                listener.setPosition(me.x, me.y, me.z);
                listener.setOrientation(me.lookX, me.lookY, me.lookZ, 0, 1, 0);
            }
        }

        // Позиция динамиков (PannerNode) других игроков
        for (const p of positions) {
            const uId = Number(p.userId);
            if (uId === myUserId) continue;

            const nodeData = audioNodes.get(uId);
            if (nodeData && nodeData.panner) {
                const now = audioCtx.currentTime;
                if (nodeData.panner.positionX) {
                    nodeData.panner.positionX.setValueAtTime(p.x, now);
                    nodeData.panner.positionY.setValueAtTime(p.y, now);
                    nodeData.panner.positionZ.setValueAtTime(p.z, now);
                } else {
                    nodeData.panner.setPosition(p.x, p.y, p.z);
                }
            }
        }
    }

    async function toggleMute() {
        if (!currentRoom) return;
        isMuted = !isMuted;
        await currentRoom.localParticipant.setMicrophoneEnabled(!isMuted);

        if (isMuted) {
            muteBtn.classList.add('muted');
            muteBtn.innerText = 'Микрофон: ВЫКЛ (Muted)';
        } else {
            muteBtn.classList.remove('muted');
            muteBtn.innerText = 'Микрофон: ВКЛ';
        }

        if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
            wsTelemetry.send(JSON.stringify({
                type: 'volume_update',
                volume: 0,
                isMuted: isMuted
            }));
        }
    }

    function setupLocalAnalyser(mediaStreamTrack) {
        const stream = new MediaStream([mediaStreamTrack]);
        const micSource = audioCtx.createMediaStreamSource(stream);
        localAnalyser = audioCtx.createAnalyser();
        localAnalyser.fftSize = 256;
        micSource.connect(localAnalyser);

        const buffer = new Uint8Array(localAnalyser.frequencyBinCount);
        let lastReportTime = 0;

        function checkVolume() {
            localAnalyser.getByteFrequencyData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) {
                sum += buffer[i];
            }
            const average = sum / buffer.length;
            const volumePercent = isMuted ? 0 : Math.min(100, Math.round((average / 128) * 100));

            micMeter.style.width = volumePercent + '%';

            const now = Date.now();
            if (now - lastReportTime > 80 && wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
                lastReportTime = now;
                wsTelemetry.send(JSON.stringify({
                    type: 'volume_update',
                    volume: volumePercent,
                    isMuted: isMuted
                }));
            }

            requestAnimationFrame(checkVolume);
        }

        requestAnimationFrame(checkVolume);
    }

    function updatePeerListUI() {
        if (!currentRoom) return;
        const count = currentRoom.remoteParticipants.size;
        peerCountLabel.innerText = count;
        peersList.innerHTML = '';
        currentRoom.remoteParticipants.forEach((p) => {
            const div = document.createElement('div');
            div.className = 'peer-item';
            div.innerHTML = `<span>${p.name || p.identity}</span><span style="color:#2ea043">● 3D LiveKit</span>`;
            peersList.appendChild(div);
        });
    }
})();
