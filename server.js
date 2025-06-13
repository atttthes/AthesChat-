// server.js ATUALIZADO

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// O objeto do usuário agora tem um campo 'location'
const connectedUsers = new Map();
const chatPairs = new Map();

io.on('connection', (socket) => {
    console.log(`Novo usuário conectado: ${socket.id}`);
    
    // Inicializamos o usuário com uma localização padrão.
    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido' });
    updateOnlineCount();

    // O evento 'join' agora recebe dados do cliente (a localização).
    socket.on('join', (data) => {
        const currentUser = connectedUsers.get(socket.id);
        if (!currentUser) return;

        // Armazenamos a localização enviada pelo cliente.
        if (data && data.location) {
            currentUser.location = data.location;
        }

        if (currentUser.partnerId) return;

        let partnerFound = false;
        for (const [userId, userData] of connectedUsers) {
            if (userId !== socket.id && !userData.partnerId) {
                currentUser.partnerId = userId;
                userData.partnerId = socket.id;

                chatPairs.set(socket.id, userId);
                chatPairs.set(userId, socket.id);

                socket.emit('chat_start', { partnerId: userId });
                io.to(userId).emit('chat_start', { partnerId: socket.id });

                partnerFound = true;
                break;
            }
        }
        if (!partnerFound) socket.emit('waiting');
    });

    // O evento 'message' agora anexa a localização do remetente.
    socket.on('message', (data) => {
        const senderData = connectedUsers.get(socket.id);
        if (senderData && senderData.partnerId) {
            io.to(senderData.partnerId).emit('message', {
                text: data.text,
                senderId: socket.id,
                replyTo: data.replyTo || null,
                location: senderData.location // Enviando a localização do remetente para o parceiro.
            });
        }
    });

    socket.on('typing', (data) => {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId) {
            io.to(partnerId).emit('typing', { isTyping: data.isTyping });
        }
    });

    socket.on('end_chat', () => {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId) {
            io.to(partnerId).emit('chat_ended');
            
            if (connectedUsers.has(socket.id)) connectedUsers.get(socket.id).partnerId = null;
            if (connectedUsers.has(partnerId)) connectedUsers.get(partnerId).partnerId = null;
            
            socket.emit('chat_ended');
        }
    });

    socket.on('disconnect', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData) return;

        const partnerId = userData.partnerId;
        if (partnerId) {
            io.to(partnerId).emit('partner_disconnected');
            if (connectedUsers.has(partnerId)) connectedUsers.get(partnerId).partnerId = null;
        }

        connectedUsers.delete(socket.id);
        updateOnlineCount();
        console.log(`Usuário desconectado: ${socket.id}`);
    });

    function updateOnlineCount() {
        io.emit('users_online', connectedUsers.size);
    }
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
