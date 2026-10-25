const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// LiveKit Cloud Credentials (для приватного репозитория)
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://octanevc-tzsmlvtk.livekit.cloud';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'APIznX5jQRcqBmK';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'SrEexgvzH2uxK9PWaCdANc8lG3MP4GNP3gOrM7eu0E1';

// Хранилище комнат и подключенных веб-сокетов телеметрии:
// roomId -> { players: Map(userId -> { ws, volume, isMuted, position, look }) }
const rooms = new Map();

// Коды быстрого входа: code -> { roomId, userId, username, expiresAt }
const quickCodes = new Map();

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            players: new Map()
        });
    }
    return rooms.get(roomId);
}

// Периодическая очистка просроченных кодов (каждые 15 сек)
setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of quickCodes.entries()) {
        if (entry.expiresAt < now) {
            quickCodes.delete(code);
        }
    }
}, 15000);

// Генерация JWT токена LiveKit
async function generateLiveKitToken(roomId, userId, username) {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: String(userId),
        name: String(username || 'Player ' + userId),
        ttl: '6h'
    });

    at.addGrant({
        roomJoin: true,
        room: String(roomId),
        canPublish: true,
        canSubscribe: true,
        canPublishData: true
    });

    return await at.toJwt();
}

// API для Roblox сервера: создание 4-значного кода
app.post('/api/create_code', (req, res) => {
    const { roomId, userId, username } = req.body;
    if (!roomId || !userId) {
        return res.status(400).json({ error: 'Missing roomId or userId' });
    }

    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (quickCodes.has(code));

    quickCodes.set(code, {
        roomId: String(roomId),
        userId: Number(userId),
        username: String(username || 'Player'),
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 минут
    });

    res.json({ success: true, code });
});

// Проверка 4-значного кода клиентом из браузера и выдача токена LiveKit
app.get('/api/resolve_code/:code', async (req, res) => {
    const entry = quickCodes.get(req.params.code);
    if (!entry || entry.expiresAt < Date.now()) {
        return res.status(404).json({ error: 'Код не найден или истёк!' });
    }

    try {
        const token = await generateLiveKitToken(entry.roomId, entry.userId, entry.username);
        res.json({
            livekitUrl: LIVEKIT_URL,
            token: token,
            roomId: entry.roomId,
            userId: entry.userId,
            username: entry.username
        });
    } catch (err) {
        console.error('Ошибка создания LiveKit токена:', err);
        res.status(500).json({ error: 'Не удалось создать токен LiveKit' });
    }
});

// Прямой запрос токена (по roomId и userId)
app.post('/api/get_token', async (req, res) => {
    const { roomId, userId, username } = req.body;
    if (!roomId || !userId) {
        return res.status(400).json({ error: 'Missing roomId or userId' });
    }

    try {
        const token = await generateLiveKitToken(roomId, userId, username);
        res.json({
            livekitUrl: LIVEKIT_URL,
            token: token
        });
    } catch (err) {
        console.error('Ошибка создания LiveKit токена:', err);
        res.status(500).json({ error: 'Не удалось создать токен LiveKit' });
    }
});

// API для Roblox сервера: синхронизация позиций персонажей
app.post('/api/sync', (req, res) => {
    const { roomId, players } = req.body;
    if (!roomId || !Array.isArray(players)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const room = getOrCreateRoom(String(roomId));
    const talkingStatuses = {};

    for (const p of players) {
        const uId = Number(p.userId);
        let playerEntry = room.players.get(uId);
        if (playerEntry) {
            playerEntry.position = { x: p.x, y: p.y, z: p.z };
            playerEntry.look = { x: p.lookX, y: p.lookY, z: p.lookZ };
            talkingStatuses[uId] = {
                connected: true,
                volume: playerEntry.volume || 0,
                isMuted: playerEntry.isMuted || false
            };
        }
    }

    // Транслируем координаты в браузеры игроков для 3D PannerNode
    const posPayload = JSON.stringify({
        type: 'positions_update',
        positions: players
    });

    for (const [_, client] of room.players.entries()) {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(posPayload);
        }
    }

    // Возвращаем уровни громкости в Roblox для анимации спикера над головой
    res.json({
        success: true,
        voices: talkingStatuses
    });
});

// WebSocket телеметрии позиций и громкости
wss.on('connection', (ws) => {
    let currentRoomId = null;
    let currentUserId = null;

    ws.on('message', (messageText) => {
        try {
            const data = JSON.parse(messageText);

            if (data.type === 'telemetry_join') {
                currentRoomId = String(data.roomId);
                currentUserId = Number(data.userId);

                const room = getOrCreateRoom(currentRoomId);
                const existing = room.players.get(currentUserId);
                if (existing && existing.ws && existing.ws !== ws) {
                    existing.ws.close();
                }

                room.players.set(currentUserId, {
                    ws,
                    userId: currentUserId,
                    username: data.username || 'Player',
                    volume: 0,
                    isMuted: false,
                    position: { x: 0, y: 0, z: 0 },
                    look: { x: 0, y: 0, z: -1 }
                });
            } else if (data.type === 'volume_update') {
                if (!currentRoomId || !currentUserId) return;
                const room = rooms.get(currentRoomId);
                if (!room) return;
                const p = room.players.get(currentUserId);
                if (p) {
                    p.volume = Math.max(0, Math.min(100, Math.round(data.volume || 0)));
                    p.isMuted = !!data.isMuted;
                }
            }
        } catch (err) {
            console.error('WS Error:', err);
        }
    });

    ws.on('close', () => {
        if (currentRoomId && currentUserId) {
            const room = rooms.get(currentRoomId);
            if (room) {
                room.players.delete(currentUserId);
                if (room.players.size === 0) {
                    rooms.delete(currentRoomId);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[Octane Voice Server] Running on http://localhost:${PORT}`);
    console.log(`[LiveKit Cloud Connected] Target: ${LIVEKIT_URL}`);
});
