// deno-server.js - 五子棋在线对战服务器（Deno Deploy 云端版，无外部依赖）
// 部署：Deno Deploy 连接 GitHub 仓库，入口文件选 deno-server.js
// 支持：创建/加入房间、准备、落子、悔棋（对手同意制）、观战、离开房间

const PORT = parseInt(Deno.env.get("PORT") || "8080");
const rooms = {};

console.log("五子棋在线对战服务器已启动，端口：" + PORT);

// 广播给房间内除 excludeWs 外的所有连接（玩家+观战者）
function broadcast(roomId, excludeWs, message) {
    const room = rooms[roomId];
    if (!room) return;
    room.players.forEach(player => {
        if (player.ws !== excludeWs && player.ws.readyState === 1) { // 1 = OPEN
            player.ws.send(JSON.stringify(message));
        }
    });
}

// 初始化15x15空棋盘
function emptyBoard() {
    return Array.from({ length: 15 }, () => Array(15).fill(0));
}

// 房间快照（观战者加入时返回完整状态，用于恢复棋盘）
function roomSnapshot(room) {
    return {
        board: room.board,
        moves: room.moves,
        currentPlayer: room.currentPlayer,
        gameStarted: room.gameStarted,
        gameOver: room.gameOver,
        players: room.players.map(p => ({
            role: p.role,
            ready: p.ready,
            isSpectator: !!p.isSpectator
        }))
    };
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
                        players: [{ role: message.role, ready: false, ws: socket, isSpectator: false }],
                        gameStarted: false,
                        gameOver: false,
                        currentPlayer: 1,
                        board: emptyBoard(),
                        moves: [],
                        pendingUndo: null
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
                    // 玩家数量（不含观战者）达到2即为满
                    if (room.players.filter(p => !p.isSpectator).length >= 2) {
                        socket.send(JSON.stringify({ type: "error", msg: "房间已满" }));
                        return;
                    }
                    room.players.push({ role: message.role, ready: false, ws: socket, isSpectator: false });
                    currentRoomId = message.roomId;
                    currentRole = message.role;
                    broadcast(message.roomId, socket, { type: "playerJoined", role: message.role });
                    socket.send(JSON.stringify({ type: "joinRoomSuccess", roomId: message.roomId }));
                    break;
                }

                case "spectate": {
                    const room = rooms[message.roomId];
                    if (!room) {
                        socket.send(JSON.stringify({ type: "error", msg: "房间不存在" }));
                        return;
                    }
                    if (room.players.length >= 6) { // 2名玩家 + 最多4名观战者
                        socket.send(JSON.stringify({ type: "error", msg: "观战人数已满" }));
                        return;
                    }
                    room.players.push({ role: 3, ready: false, ws: socket, isSpectator: true });
                    currentRoomId = message.roomId;
                    currentRole = 3;
                    socket.send(JSON.stringify({
                        type: "spectateSuccess",
                        roomId: message.roomId,
                        ...roomSnapshot(room)
                    }));
                    break;
                }

                case "playerReady": {
                    const readyRoom = rooms[message.roomId];
                    if (!readyRoom) return;
                    const player = readyRoom.players.find(p => p.role === message.role && !p.isSpectator);
                    if (player) player.ready = true;
                    broadcast(message.roomId, socket, { type: "playerReady", role: message.role });
                    if (readyRoom.players.filter(p => !p.isSpectator).every(p => p.ready)) {
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
                    if (!moveRoom || !moveRoom.gameStarted || moveRoom.gameOver) return;
                    if (moveRoom.currentPlayer !== message.player) return;
                    if (moveRoom.board[message.row]?.[message.col] !== 0) return; // 防重复落子
                    moveRoom.board[message.row][message.col] = message.player;
                    moveRoom.moves.push({ row: message.row, col: message.col, player: message.player });
                    broadcast(message.roomId, socket, {
                        type: "move", row: message.row, col: message.col, player: message.player
                    });
                    moveRoom.currentPlayer = message.player === 1 ? 2 : 1;
                    break;
                }

                case "gameOver":
                    const overRoom = rooms[message.roomId];
                    if (overRoom) overRoom.gameOver = true;
                    broadcast(message.roomId, socket, {
                        type: "gameOver", winner: message.winner, reason: message.reason
                    });
                    break;

                case "undoRequest": {
                    const undoRoom = rooms[message.roomId];
                    if (!undoRoom || !undoRoom.gameStarted || undoRoom.gameOver) return;
                    if (undoRoom.moves.length === 0) {
                        socket.send(JSON.stringify({ type: "error", msg: "没有可撤销的棋子" }));
                        return;
                    }
                    if (undoRoom.pendingUndo) {
                        socket.send(JSON.stringify({ type: "error", msg: "已有悔棋请求待处理" }));
                        return;
                    }
                    const opponent = undoRoom.players.find(p => p.role !== message.role && !p.isSpectator);
                    if (!opponent) return;
                    undoRoom.pendingUndo = { requester: message.role };
                    if (opponent.ws.readyState === 1) {
                        opponent.ws.send(JSON.stringify({ type: "undoRequest", role: message.role, roomId: message.roomId }));
                    }
                    socket.send(JSON.stringify({ type: "undoRequested" }));
                    break;
                }

                case "undoResponse": {
                    const respRoom = rooms[message.roomId];
                    if (!respRoom || !respRoom.pendingUndo) return;
                    const requesterRole = respRoom.pendingUndo.requester;
                    const requester = respRoom.players.find(p => p.role === requesterRole);
                    respRoom.pendingUndo = null;
                    if (message.accept) {
                        const lastMove = respRoom.moves.pop();
                        if (lastMove) {
                            respRoom.board[lastMove.row][lastMove.col] = 0;
                            respRoom.currentPlayer = lastMove.player;
                        }
                        broadcast(message.roomId, null, {
                            type: "undoApplied",
                            row: lastMove ? lastMove.row : -1,
                            col: lastMove ? lastMove.col : -1,
                            currentPlayer: respRoom.currentPlayer
                        });
                    } else {
                        if (requester && requester.ws.readyState === 1) {
                            requester.ws.send(JSON.stringify({ type: "undoDenied" }));
                        }
                    }
                    break;
                }

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