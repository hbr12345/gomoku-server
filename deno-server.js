// deno-server.js - 五子棋在线对战服务器（Deno Deploy 云端版，无外部依赖）
// 部署：Deno Deploy 连接 GitHub 仓库，入口文件选 deno-server.js
// 逻辑与本地 gobang-server.exe 完全一致

const PORT = parseInt(Deno.env.get("PORT") || "8080");
const rooms = {};

console.log("五子棋在线对战服务器已启动，端口：" + PORT);

function broadcast(roomId, excludeWs, message) {
    const room = rooms[roomId];
    if (!room) return;
    room.players.forEach(player => {
        if (player.ws !== excludeWs && player.ws.readyState === 1) { // 1 = OPEN
            player.ws.send(JSON.stringify(message));
        }
    });
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, (req) => {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("五子棋在线对战服务器运行中", { status: 200 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const url = new URL(req.url);
    const roomId = url.searchParams.get("roomId") || "";
    const role = parseInt(url.searchParams.get("role")) || 0;

    let currentRoomId = roomId;
    let currentRole = role;
    console.log("客户端连接：房间" + roomId + "，角色" + role);

    socket.onmessage = (e) => {
        try {
            const message = JSON.parse(e.data);
            console.log("收到消息：", message);

            switch (message.type) {
                case "createRoom":
                    if (rooms[message.roomId]) {
                        socket.send(JSON.stringify({ type: "error", msg: "房间已存在" }));
                        return;
                    }
                    rooms[message.roomId] = {
                        players: [{ role: message.role, ready: false, ws: socket }],
                        gameStarted: false,
                        currentPlayer: 1
                    };
                    currentRoomId = message.roomId;
                    currentRole = message.role;
                    socket.send(JSON.stringify({ type: "createRoomSuccess", roomId: message.roomId }));
                    break;

                case "joinRoom": {
                    const room = rooms[message.roomId];
                    if (!room) {
                        socket.send(JSON.stringify({ type: "error", msg: "房间不存在" }));
                        return;
                    }
                    if (room.players.length >= 2) {
                        socket.send(JSON.stringify({ type: "error", msg: "房间已满" }));
                        return;
                    }
                    room.players.push({ role: message.role, ready: false, ws: socket });
                    currentRoomId = message.roomId;
                    currentRole = message.role;
                    broadcast(message.roomId, socket, { type: "playerJoined", role: message.role });
                    socket.send(JSON.stringify({ type: "joinRoomSuccess", roomId: message.roomId }));
                    break;
                }

                case "playerReady": {
                    const readyRoom = rooms[message.roomId];
                    if (!readyRoom) return;
                    const player = readyRoom.players.find(p => p.role === message.role);
                    if (player) player.ready = true;
                    broadcast(message.roomId, socket, { type: "playerReady", role: message.role });
                    if (readyRoom.players.every(p => p.ready)) {
                        readyRoom.gameStarted = true;
                        readyRoom.players.forEach(p => {
                            if (p.ws.readyState === 1) {
                                p.ws.send(JSON.stringify({ type: "gameStart", currentPlayer: readyRoom.currentPlayer }));
                            }
                        });
                    }
                    break;
                }

                case "move": {
                    const moveRoom = rooms[message.roomId];
                    if (!moveRoom || !moveRoom.gameStarted) return;
                    if (moveRoom.currentPlayer !== message.player) return;
                    broadcast(message.roomId, socket, {
                        type: "move", row: message.row, col: message.col, player: message.player
                    });
                    moveRoom.currentPlayer = message.player === 1 ? 2 : 1;
                    break;
                }

                case "gameOver":
                    broadcast(message.roomId, socket, {
                        type: "gameOver", winner: message.winner, reason: message.reason
                    });
                    break;

                case "leaveRoom": {
                    const leaveRoom = rooms[message.roomId];
                    if (leaveRoom) {
                        leaveRoom.players = leaveRoom.players.filter(p => p.ws !== socket);
                        broadcast(message.roomId, socket, { type: "playerLeft", role: currentRole });
                        if (leaveRoom.players.length === 0) delete rooms[message.roomId];
                    }
                    socket.close();
                    break;
                }
            }
        } catch (err) {
            console.error("消息处理错误：", err);
        }
    };

    socket.onclose = () => {
        console.log("客户端断开连接：房间" + currentRoomId + "，角色" + currentRole);
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            room.players = room.players.filter(p => p.ws !== socket);
            broadcast(currentRoomId, socket, { type: "playerLeft", role: currentRole });
            if (room.players.length === 0) delete rooms[currentRoomId];
        }
    };

    socket.onerror = (err) => {
        console.error("WebSocket错误：", err);
    };

    return response;
});