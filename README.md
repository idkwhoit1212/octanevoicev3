# Octane 3D Positional Voice Server (LiveKit Cloud Edition)

3D позиционный голосовой чат для Roblox Octane (2021) на базе **LiveKit Cloud SFU** и **Web Audio API**.

## Безопасность (Environment Variables):
Все ключи доступа передаются через системные переменные окружения и **никогда не хранятся в открытом коде**.

В панели вашего хостинга (Render / Railway / VPS) укажите 3 переменные:
- `LIVEKIT_URL`: ваш WebSocket URL от LiveKit (например `wss://octanevc-tzsmlvtk.livekit.cloud`)
- `LIVEKIT_API_KEY`: ваш API Key
- `LIVEKIT_API_SECRET`: ваш API Secret

## Развертывание на Render.com (Бесплатно):
1. Загрузите файлы этого репозитория на GitHub (репозиторий можно делать как **Public**, так и **Private** — ключей в коде нет!).
2. Перейдите на [render.com](https://render.com) ➔ **New ➔ Web Service**.
3. Выберите ваш репозиторий.
4. В разделе **Environment Variables** добавьте:
   - `LIVEKIT_URL`
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
5. Нажмите **Deploy**.
6. Полученный URL скопируйте в модуль Roblox: `ReplicatedStorage.VoiceChat.VoiceConfig.SERVER_URL`.
