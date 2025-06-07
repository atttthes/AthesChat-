# -*- coding: utf-8 -*-
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
import random
import requests
from collections import defaultdict

# Configuração do aplicativo Flask
app = Flask(__name__)
app.config['SECRET_KEY'] = 'sua_chave_secreta_aqui!'  # Altere para uma chave mais segura

# Configuração do SocketIO
socketio = SocketIO(
    app,
    async_mode='eventlet',
    cors_allowed_origins="*"  # Em produção, restrinja aos seus domínios
)

# Estruturas de dados para gerenciamento do chat
waiting_users = []  # Lista de usuários esperando pareamento
active_rooms = {}   # Mapeamento de IDs de sessão para salas
user_locations = {}  # Armazena localizações dos usuários

def get_user_location(ip_address):
    """Obtém a localização aproximada baseada no IP"""
    try:
        response = requests.get(f'https://ipapi.co/{ip_address}/json/')
        if response.status_code == 200:
            data = response.json()
            return data.get('region', 'Localização desconhecida')
    except:
        return 'Localização desconhecida'
    return 'Localização desconhecida'

@app.route('/')
def home():
    """Rota principal que serve a página do chat"""
    try:
        return render_template('index.html')
    except Exception as e:
        return str(e), 500

@socketio.on('connect')
def handle_connect():
    """Lida com novas conexões de clientes"""
    print(f"Novo cliente conectado: {request.sid}")
    # Obtém o IP do cliente e sua localização
    ip_address = request.remote_addr
    user_locations[request.sid] = get_user_location(ip_address)

@socketio.on('join')
def handle_join():
    """Emparelha usuários em salas de chat"""
    try:
        if waiting_users:
            # Encontra um parceiro disponível
            partner = waiting_users.pop(0)
            room_id = f"room_{random.randint(1000, 9999)}"
            
            # Registra os usuários na sala
            active_rooms[request.sid] = room_id
            active_rooms[partner] = room_id
            
            # Adiciona ambos à sala
            join_room(room_id, sid=request.sid)
            join_room(room_id, sid=partner)
            
            # Notifica os usuários
            emit('chat_start', {
                'room': room_id,
                'message': 'Chat conectado com sucesso!',
                'partner_location': user_locations.get(partner, 'Localização desconhecida')
            }, room=room_id)
        else:
            # Adiciona à lista de espera
            waiting_users.append(request.sid)
            emit('waiting', {'message': 'Procurando um parceiro...'})
    except Exception as e:
        emit('error', {'message': str(e)})

@socketio.on('message')
def handle_message(data):
    """Processa mensagens do chat"""
    try:
        room_id = active_rooms.get(request.sid)
        if room_id:
            # Envia a mensagem para todos na sala EXCETO para o remetente
            emit('message', {
                'text': data['text'],
                'senderId': request.sid  # Envia o ID do remetente
            }, room=room_id, include_self=False)
    except Exception as e:
        emit('error', {'message': str(e)})

@socketio.on('disconnect')
def handle_disconnect():
    """Lida com desconexões de usuários"""
    try:
        if request.sid in waiting_users:
            waiting_users.remove(request.sid)
        
        room_id = active_rooms.pop(request.sid, None)
        if room_id:
            leave_room(room_id)
            emit('partner_disconnected', {
                'message': 'Seu parceiro saiu do chat'
            }, room=room_id)
        
        # Remove a localização do usuário desconectado
        user_locations.pop(request.sid, None)
    except Exception as e:
        print(f"Erro na desconexão: {str(e)}")

if __name__ == '__main__':
    # Configurações para desenvolvimento
    socketio.run(
        app,
        host='0.0.0.0',
        port=5000,
        debug=True,
        use_reloader=True,
        allow_unsafe_werkzeug=True
    )
