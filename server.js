// server.js - 五子棋在线对战服务器（云部署版）
// 支持 Render / Glitch / Railway 等平台的环境变量 PORT
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT, host: '0.0.0.0' });

// 房间存储结构
const rooms = {};

console.log('五子棋在线对战服务器已启动，端口：' + PORT);

// 工具函数：广播消息给房间内指定玩家
function broadcast(roomId, excludeWs, message) {
    const room = rooms[roomId];
    if (!room) return;
    room.players.forEach(player => {
        if (player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws, req) => {
    // 解析URL参数
    const params = new URLSearchParams(req.url.slice(1));
    const roomId = params.get('roomId');
    const role = parseInt(params.get('role'));

    let currentRoomId = roomId;
    let currentRole = role;

    console.log('客户端连接：房间' + roomId + '，角色' + role);

    // 心跳保活（防止云平台判定空闲断开）
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // 处理消息
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log('收到消息：', message);

            switch (message.type) {
                case 'createRoom':
                    if (rooms[message.roomId]) {
                        ws.send(JSON.stringify({ type: 'error', msg: '房间已存在' }));
                        return;
                    }
                    rooms[message.roomId] = {
                        players: [{ role: message.role, ready: false, ws: ws }],
                        gameStarted: false,
                        currentPlayer: 1
                    };
                    currentRoomId = message.roomId;
                    currentRole = message.role;
                    ws.send(JSON.stringify({ type: 'createRoomSuccess', roomId: message.roomId }));
                    break;

                case 'joinRoom':
                    const room = rooms[message.roomId];
                    if (!room) {
                        ws.send(JSON.stringify({ type: 'error', msg: '房间不存在' }));
                        return;
                    }
                    if (room.players.length >= 2) {
                        ws.send(JSON.stringify({ type: 'error', msg: '房间已满' }));
                        return;
                    }
                    room.players.push({ role: message.role, ready: false, ws: ws });
                    currentRoomId = message.roomId;
                    currentRole = message.role;
                    broadcast(message.roomId, ws, { type: 'playerJoined', role: message.role });
                    ws.send(JSON.stringify({ type: 'joinRoomSuccess', roomId: message.roomId }));
                    break;

                case 'playerReady':
                    const readyRoom = rooms[message.roomId];
                    if (!readyRoom) return;
                    const player = readyRoom.players.find(p => p.role === message.role);
                    if (player) player.ready = true;
                    broadcast(message.roomId, ws, { type: 'playerReady', role: message.role });
                    const allReady = readyRoom.players.every(p => p.ready);
                    if (allReady) {
                        readyRoom.gameStarted = true;
                        readyRoom.players.forEach(p => {
                            if (p.ws.readyState === WebSocket.OPEN) {
                                p.ws.send(JSON.stringify({ type: 'gameStart', currentPlayer: readyRoom.currentPlayer }));
                            }
                        });
                    }
                    break;

                case 'move':
                    const moveRoom = rooms[message.roomId];
                    if (!moveRoom || !moveRoom.gameStarted) return;
                    if (moveRoom.currentPlayer !== message.player) return;
                    broadcast(message.roomId, ws, {
                        type: 'move', row: message.row, col: message.col, player: message.player
                    });
                    moveRoom.currentPlayer = message.player === 1 ? 2 : 1;
                    break;

                case 'gameOver':
                    broadcast(message.roomId, ws, {
                        type: 'gameOver', winner: message.winner, reason: message.reason
                    });
                    break;

                case 'leaveRoom':
                    const leaveRoom = rooms[message.roomId];
                    if (leaveRoom) {
                        leaveRoom.players = leaveRoom.players.filter(p => p.ws !== ws);
                        broadcast(message.roomId, ws, { type: 'playerLeft', role: currentRole });
                        if (leaveRoom.players.length === 0) delete rooms[message.roomId];
                    }
                    ws.close();
                    break;
            }
        } catch (e) {
            console.error('消息处理错误：', e);
        }
    });

    // 连接关闭
    ws.on('close', () => {
        console.log('客户端断开连接：房间' + currentRoomId + '，角色' + currentRole);
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            room.players = room.players.filter(p => p.ws !== ws);
            broadcast(currentRoomId, ws, { type: 'playerLeft', role: currentRole });
            if (room.players.length === 0) delete rooms[currentRoomId];
        }
    });

    // 错误处理
    ws.on('error', (err) => {
        console.error('WebSocket错误：', err);
    });
});

// 保活定时器：每30秒检测并终止不活跃连接
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch (e) {}
    });
}, 30000);