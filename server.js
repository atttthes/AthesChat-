const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuração para servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Objeto para armazenar os usuários conectados
const connectedUsers = new Map();

// Objeto para armazenar os pares de chat
const chatPairs = new Map();

io.on('connection', (socket) => {
    console.log(`Novo usuário conectado: ${socket.id}`);
    
    // Adiciona o usuário à lista de conectados
    connectedUsers.set(socket.id, {
        id: socket.id,
        partnerId: null,
        isTyping: false
    });
    
    // Atualiza a contagem de usuários online para todos
    updateOnlineCount();
    
    // Quando um usuário quer iniciar um chat
    socket.on('join', () => {
        // Se já estiver em um chat, não faz nada
        if (connectedUsers.get(socket.id).partnerId) {
            return;
        }
        
        // Procura por um parceiro disponível
        let partnerFound = false;
        for (const [userId, userData] of connectedUsers) {
            if (userId !== socket.id && !userData.partnerId) {
                // Forma o par de chat
                connectedUsers.get(socket.id).partnerId = userId;
                connectedUsers.get(userId).partnerId = socket.id;
                
                chatPairs.set(socket.id, userId);
                chatPairs.set(userId, socket.id);
                
                // Notifica ambos os usuários
                socket.emit('chat_start', { partnerId: userId });
                io.to(userId).emit('chat_start', { partnerId: socket.id });
                
                partnerFound = true;
                break;
            }
        }
        
        if (!partnerFound) {
            socket.emit('waiting');
        }
    });
    
    // Quando um usuário envia uma mensagem
    socket.on('message', (data) => {
        const partnerId = connectedUsers.get(socket.id).partnerId;
        if (partnerId) {
            io.to(partnerId).emit('message', {
                text: data.text,
                senderId: socket.id,
                replyTo: data.replyTo || null
            });
        }
    });
    
    // Quando um usuário está digitando
    socket.on('typing', (data) => {
        const partnerId = connectedUsers.get(socket.id).partnerId;
        if (partnerId) {
            connectedUsers.get(socket.id).isTyping = data.isTyping;
            io.to(partnerId).emit('typing', {
                isTyping: data.isTyping
            });
        }
    });
    
    // Quando um usuário encerra o chat
    socket.on('end_chat', () => {
        const partnerId = connectedUsers.get(socket.id).partnerId;
        if (partnerId) {
            // Notifica o parceiro que o chat foi encerrado
            io.to(partnerId).emit('chat_ended');
            
            // Remove o par de chat
            chatPairs.delete(socket.id);
            chatPairs.delete(partnerId);
            
            // Atualiza o status dos usuários
            connectedUsers.get(socket.id).partnerId = null;
            connectedUsers.get(partnerId).partnerId = null;
            
            // Notifica o usuário que encerrou
            socket.emit('partner_disconnected');
        }
    });
    
    // Quando um usuário desconecta
    socket.on('disconnect', () => {
        const partnerId = connectedUsers.get(socket.id).partnerId;
        
        if (partnerId) {
            // Notifica o parceiro que o chat foi encerrado
            io.to(partnerId).emit('partner_disconnected');
            
            // Remove o par de chat
            chatPairs.delete(socket.id);
            chatPairs.delete(partnerId);
            
            // Atualiza o status do parceiro
            connectedUsers.get(partnerId).partnerId = null;
        }
        
        // Remove o usuário da lista de conectados
        connectedUsers.delete(socket.id);
        
        // Atualiza a contagem de usuários online
        updateOnlineCount();
        
        console.log(`Usuário desconectado: ${socket.id}`);
    });
    
    // Função para atualizar a contagem de usuários online para todos
    function updateOnlineCount() {
        const onlineCount = connectedUsers.size;
        io.emit('users_online', onlineCount);
    }
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log("Servidor rodando na porta " + port);
});
