import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { getDatabase } from './lib/db-instance.mjs';
import Logger from './lib/logger.mjs';
import { SERVER_CONFIG } from './config.mjs';

const db = getDatabase();
const logger = new Logger(SERVER_CONFIG.DISCORD_WEBHOOK_URL);

const server = createServer();
const wss = new WebSocketServer({ server, perMessageDeflate: false });

const connectedClients = new Map();
const activeStreams = new Map();
const streamViewers = new Map();
const streamChatHistory = new Map();
const globalChatHistory = [];
const globalConnectedUsers = new Set();

function generateFingerprint(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ip + ua).digest('hex').substring(0, 16);
}

function generateUserId() {
  return crypto.randomBytes(16).toString('hex');
}

function parseUserAgent(ua) {
  let browser = 'Unknown', os = 'Unknown', deviceType = 'Desktop';
  if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Safari')) browser = 'Safari';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';
  if (ua.includes('Mobile')) deviceType = 'Mobile';
  return { browser, os, deviceType };
}

function broadcastToAll(message) {
  const messageStr = JSON.stringify(message);
  connectedClients.forEach((client) => {
    if (client.ws.readyState === 1) {
      try {
        client.ws.send(messageStr);
      } catch (error) {
        console.error('Erreur broadcast:', error);
      }
    }
  });
}

function broadcastToStream(streamKey, message) {
  const viewers = streamViewers.get(streamKey);
  if (!viewers) return;
  const messageStr = JSON.stringify(message);
  viewers.forEach(clientId => {
    const client = connectedClients.get(clientId);
    if (client && client.ws.readyState === 1) {
      try {
        client.ws.send(messageStr);
      } catch (error) {
        console.error('Erreur broadcast stream:', error);
      }
    }
  });
}

function broadcastToGlobalChat(message) {
  const messageStr = JSON.stringify(message);
  globalConnectedUsers.forEach(clientId => {
    const client = connectedClients.get(clientId);
    if (client && client.ws.readyState === 1) {
      try {
        client.ws.send(messageStr);
      } catch (error) {
        console.error('Erreur broadcast global:', error);
      }
    }
  });
}

function addMessageToHistory(message, streamKey = null) {
  if (streamKey) {
    if (!streamChatHistory.has(streamKey)) {
      streamChatHistory.set(streamKey, []);
    }
    const history = streamChatHistory.get(streamKey);
    history.push(message);
    if (history.length > 50) history.shift();
  } else {
    globalChatHistory.push(message);
    if (globalChatHistory.length > 50) globalChatHistory.shift();
  }
}

async function broadcastAdminData() {
  try {
    const [bannedUsers, mutedUsers, activityLogs, chatMessages] = await Promise.all([
      db.getBannedUsers(),
      db.getMutedUsers(),
      db.getActivityLogs(100),
      db.all('SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT 100')
    ]);

    const connectedUsersArray = Array.from(connectedClients.values()).map(c => ({
      id: c.id,
      username: c.username,
      ip: c.ip,
      fingerprint: c.fingerprint,
      page: c.page,
      connectTime: c.connectTime,
      role: c.role
    }));

    const streams = await db.getActiveStreams();
    const streamStats = {
      totalStreams: streams.length,
      currentViewers: Array.from(streamViewers.values()).reduce((sum, viewers) => sum + viewers.size, 0),
      peakViewers: streams.reduce((max, s) => Math.max(max, s.viewer_count || 0), 0),
      totalViews: streams.reduce((sum, s) => sum + (s.viewer_count || 0), 0),
      isLive: streams.some(s => s.is_live)
    };

    const adminData = {
      type: 'admin_data_update',
      bannedUsers,
      mutedUsers,
      activityLogs,
      connectedUsers: connectedUsersArray,
      chatMessages,
      streamStats
    };

    connectedClients.forEach((client) => {
      if ((client.role === 'admin' || client.role === 'moderator') && client.ws.readyState === 1) {
        try {
          client.ws.send(JSON.stringify(adminData));
        } catch (error) {
          console.error('Erreur broadcast admin:', error);
        }
      }
    });
  } catch (error) {
    console.error('Erreur broadcastAdminData:', error);
  }
}

wss.on('connection', async (ws, req) => {
  const clientId = generateUserId();
  const fingerprint = generateFingerprint(req);
  const ip = req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const { browser, os, deviceType } = parseUserAgent(userAgent);

  console.log(`[WS] Connexion: ${clientId} (${ip})`);

  try {
    const banInfo = await db.isUserBanned(fingerprint, ip);
    if (banInfo) {
      ws.send(JSON.stringify({
        type: 'banned',
        message: 'Vous êtes banni.',
        banInfo: { reason: banInfo.reason, bannedAt: banInfo.banned_at, permanent: banInfo.is_permanent }
      }));
      ws.close();
      return;
    }
  } catch (error) {
    console.error('Erreur vérification ban:', error);
  }

  const clientInfo = {
    id: clientId,
    ws: ws,
    ip: ip,
    userAgent: userAgent,
    fingerprint: fingerprint,
    browser: browser,
    os: os,
    deviceType: deviceType,
    connectTime: new Date(),
    lastActivity: new Date(),
    username: null,
    role: 'viewer',
    page: 'unknown',
    currentStream: null
  };

  connectedClients.set(clientId, clientInfo);

  broadcastToAll({ type: 'user_count', count: connectedClients.size });

  ws.send(JSON.stringify({
    type: 'active_streams',
    streams: Array.from(activeStreams.values())
  }));

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      const client = connectedClients.get(clientId);
      if (!client) return;
      client.lastActivity = new Date();

      switch (message.type) {
        case 'user_info':
          client.username = message.username;
          client.page = message.page;
          try {
            await db.addConnectedUser({
              id: clientId,
              username: message.username,
              ip: ip,
              userAgent: userAgent,
              page: message.page,
              fingerprint: fingerprint
            });
          } catch (error) {
            console.error('Erreur ajout user:', error);
          }
          await logger.sendLog('user_connected', {
            username: message.username,
            ip: ip,
            os: os,
            deviceType: deviceType,
            browser: browser,
            page: message.page
          });
          break;

        case 'chat_message':
          try {
            const muteInfo = await db.isUserMuted(fingerprint);
            if (muteInfo) {
              const remaining = new Date(muteInfo.mute_end_time).getTime() - Date.now();
              if (remaining > 0) {
                const minutes = Math.floor(remaining / 60000);
                const seconds = Math.floor((remaining % 60000) / 1000);
                ws.send(JSON.stringify({
                  type: 'mute_notification',
                  message: `Vous êtes mute pour ${minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`}`
                }));
                return;
              }
            }
          } catch (error) {
            console.error('Erreur vérif mute:', error);
          }

          const chatMessage = {
            ...message.message,
            timestamp: new Date().toISOString(),
            ip: ip,
            fingerprint: fingerprint,
            streamKey: client.currentStream
          };

          try {
            await db.addChatMessage(chatMessage);
            broadcastAdminData();
          } catch (error) {
            console.error('Erreur ajout message:', error);
          }

          const targetStreamKey = message.streamKey || client.currentStream;
          if (targetStreamKey) {
            addMessageToHistory(chatMessage, targetStreamKey);
            broadcastToStream(targetStreamKey, { type: 'chat_message', message: chatMessage });
          } else {
            addMessageToHistory(chatMessage);
            broadcastToGlobalChat({ type: 'chat_message', message: chatMessage });
          }
          break;

        case 'join_global_chat':
          globalConnectedUsers.add(clientId);
          client.currentStream = null;
          ws.send(JSON.stringify({
            type: 'global_chat_joined',
            success: true,
            chatHistory: globalChatHistory
          }));
          break;

        case 'leave_global_chat':
          globalConnectedUsers.delete(clientId);
          break;

        case 'join_stream':
          const streamKey = message.streamKey;
          client.currentStream = streamKey;
          globalConnectedUsers.delete(clientId);

          if (!streamViewers.has(streamKey)) {
            streamViewers.set(streamKey, new Set());
          }
          streamViewers.get(streamKey).add(clientId);

          if (!activeStreams.has(streamKey)) {
            activeStreams.set(streamKey, {
              key: streamKey,
              title: `Stream ${streamKey}`,
              description: 'Stream créé automatiquement',
              thumbnail: 'https://images.pexels.com/photos/1763075/pexels-photo-1763075.jpeg?auto=compress&cs=tinysrgb&w=800&h=450&dpr=1',
              startTime: new Date(),
              viewers: 0,
              isLive: true,
              autoDetected: false
            });
            if (!streamChatHistory.has(streamKey)) {
              streamChatHistory.set(streamKey, []);
            }
          }

          const stream = activeStreams.get(streamKey);
          stream.viewers = streamViewers.get(streamKey).size;

          ws.send(JSON.stringify({
            type: 'stream_joined',
            success: true,
            stream: stream,
            chatHistory: streamChatHistory.get(streamKey) || [],
            streamKey: streamKey
          }));

          broadcastToAll({ type: 'stream_updated', stream: stream, streamKey: streamKey });
          break;

        case 'leave_stream':
          if (client.currentStream) {
            const viewers = streamViewers.get(client.currentStream);
            if (viewers) {
              viewers.delete(clientId);
              const stream = activeStreams.get(client.currentStream);
              if (stream) {
                stream.viewers = viewers.size;
                broadcastToAll({ type: 'stream_updated', stream: stream, streamKey: client.currentStream });
              }
            }
            client.currentStream = null;
            globalConnectedUsers.add(clientId);
          }
          break;

        case 'request_admin_data':
          if (client.role === 'admin' || client.role === 'moderator') {
            await broadcastAdminData();
          }
          break;

        case 'authenticate':
          let authSuccess = false;
          let authRole = 'viewer';

          if (message.context === 'main_auth' && message.key === SERVER_CONFIG.ENCRYPTION_KEY) {
            authSuccess = true;
          } else if (message.context === 'admin_access') {
            if (SERVER_CONFIG.ADMIN_ACCESS_CODES.includes(message.password)) {
              authSuccess = true;
              authRole = 'admin';
            }
          } else if (message.context === 'mod_auth') {
            const modPasswords = SERVER_CONFIG.MODERATOR_PASSWORDS;
            if (modPasswords[message.role] === message.password) {
              authSuccess = true;
              authRole = message.role;
            }
          }

          if (authSuccess) {
            client.role = authRole;
            if (authRole === 'admin' || authRole === 'moderator') {
              setTimeout(() => broadcastAdminData(), 500);
            }
          }

          ws.send(JSON.stringify({
            type: 'auth_response',
            success: authSuccess,
            role: authRole,
            context: message.context
          }));
          break;

        case 'login':
          try {
            const user = await db.findUserByUsername(message.username);
            if (user && await bcrypt.compare(message.password, user.password_hash)) {
              client.username = user.username;
              client.role = user.role;
              await db.updateUserLastLogin(user.id);
              ws.send(JSON.stringify({
                type: 'login_response',
                success: true,
                user: { id: user.id, username: user.username, role: user.role }
              }));
              if (user.role === 'admin' || user.role === 'moderator') {
                setTimeout(() => broadcastAdminData(), 500);
              }
            } else {
              ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'Identifiants incorrects' }));
            }
          } catch (error) {
            ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'Erreur connexion' }));
          }
          break;

        case 'register':
          try {
            const existingUser = await db.findUserByUsername(message.username);
            if (existingUser) {
              ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'Nom d\'utilisateur déjà pris' }));
              return;
            }
            const hashedPassword = await bcrypt.hash(message.password, 10);
            const userId = crypto.randomUUID();
            await db.createUser({
              id: userId,
              username: message.username,
              passwordHash: hashedPassword,
              role: 'viewer'
            });
            ws.send(JSON.stringify({ type: 'register_response', success: true, message: 'Compte créé' }));
          } catch (error) {
            ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'Erreur création compte' }));
          }
          break;

        case 'delete_message':
          if (client.role === 'moderator' || client.role === 'admin') {
            try {
              await db.deleteChatMessage(message.messageId);
            } catch (error) {
              console.error('Erreur suppression message:', error);
            }
            if (client.currentStream) {
              const history = streamChatHistory.get(client.currentStream);
              if (history) {
                const index = history.findIndex(msg => msg.id === message.messageId);
                if (index !== -1) history.splice(index, 1);
              }
              broadcastToStream(client.currentStream, {
                type: 'message_deleted',
                messageId: message.messageId,
                streamKey: client.currentStream
              });
            } else {
              const index = globalChatHistory.findIndex(msg => msg.id === message.messageId);
              if (index !== -1) globalChatHistory.splice(index, 1);
              broadcastToAll({ type: 'message_deleted', messageId: message.messageId });
            }
          }
          break;

        case 'admin_action':
          if (client.role === 'admin' || client.role === 'moderator') {
            const actionData = message.data || {};

            switch (message.action) {
              case 'ban':
                try {
                  const banDuration = actionData.duration === 'permanent' ? null : new Date(Date.now() + parseInt(actionData.duration) * 3600000);

                  await db.banUser({
                    fingerprint: actionData.fingerprint,
                    ip: actionData.ip,
                    username: actionData.username,
                    banEndTime: banDuration,
                    reason: actionData.reason,
                    bannedBy: actionData.bannedBy,
                    isPermanent: actionData.duration === 'permanent'
                  });

                  await db.addActivityLog({
                    action_type: 'user_banned',
                    username: actionData.username,
                    ip_address: actionData.ip,
                    fingerprint: actionData.fingerprint,
                    details: { reason: actionData.reason, duration: actionData.duration },
                    severity: 'high',
                    admin_username: actionData.bannedBy
                  });

                  const targetClient = Array.from(connectedClients.values())
                    .find(c => c.fingerprint === actionData.fingerprint);

                  if (targetClient) {
                    targetClient.ws.send(JSON.stringify({
                      type: 'banned',
                      message: `Vous avez été banni. Raison: ${actionData.reason}`
                    }));
                    setTimeout(() => targetClient.ws.close(), 1000);
                  }

                  await broadcastAdminData();
                } catch (error) {
                  console.error('Erreur ban:', error);
                }
                break;

              case 'mute':
                try {
                  const muteEndTime = new Date(Date.now() + parseInt(actionData.duration) * 60000);

                  await db.muteUser({
                    fingerprint: actionData.fingerprint,
                    username: actionData.username,
                    ip: actionData.ip,
                    muteEndTime: muteEndTime,
                    reason: actionData.reason,
                    mutedBy: actionData.mutedBy,
                    muteCount: 1
                  });

                  await db.addActivityLog({
                    action_type: 'user_muted',
                    username: actionData.username,
                    ip_address: actionData.ip,
                    fingerprint: actionData.fingerprint,
                    details: { reason: actionData.reason, duration: `${actionData.duration} min` },
                    severity: 'medium',
                    admin_username: actionData.mutedBy
                  });

                  const targetClient = Array.from(connectedClients.values())
                    .find(c => c.fingerprint === actionData.fingerprint);

                  if (targetClient) {
                    targetClient.ws.send(JSON.stringify({
                      type: 'muted',
                      message: `Vous êtes mute pour ${actionData.duration} minutes. Raison: ${actionData.reason}`
                    }));
                  }

                  await broadcastAdminData();
                } catch (error) {
                  console.error('Erreur mute:', error);
                }
                break;

              case 'unban':
                try {
                  await db.unbanUser(actionData.fingerprint, actionData.ip);

                  await db.addActivityLog({
                    action_type: 'user_unbanned',
                    fingerprint: actionData.fingerprint,
                    details: {},
                    severity: 'low',
                    admin_username: actionData.adminUsername
                  });

                  await broadcastAdminData();
                } catch (error) {
                  console.error('Erreur unban:', error);
                }
                break;

              case 'unmute':
                try {
                  await db.unmuteUser(actionData.fingerprint);

                  await db.addActivityLog({
                    action_type: 'user_unmuted',
                    fingerprint: actionData.fingerprint,
                    details: {},
                    severity: 'low',
                    admin_username: actionData.adminUsername
                  });

                  await broadcastAdminData();
                } catch (error) {
                  console.error('Erreur unmute:', error);
                }
                break;

              case 'delete_message':
                try {
                  await db.deleteChatMessage(actionData.messageId);

                  await db.addActivityLog({
                    action_type: 'message_deleted',
                    details: { messageId: actionData.messageId },
                    severity: 'low',
                    admin_username: actionData.adminUsername
                  });

                  broadcastToAll({
                    type: 'message_deleted',
                    messageId: actionData.messageId
                  });

                  await broadcastAdminData();
                } catch (error) {
                  console.error('Erreur delete message:', error);
                }
                break;
            }
          }
          break;

        case 'admin_command':
          if (client.role === 'admin') {
            let response = { type: 'admin_response', success: false, message: 'Commande inconnue' };

            switch (message.command) {
              case 'list_banned':
                try {
                  const bannedUsers = await db.getBannedUsers();
                  response = {
                    type: 'admin_response',
                    success: true,
                    command: 'list_banned',
                    data: bannedUsers
                  };
                } catch (error) {
                  response.message = 'Erreur récupération bans';
                }
                break;

              case 'list_muted':
                try {
                  const mutedUsers = await db.getMutedUsers();
                  response = {
                    type: 'admin_response',
                    success: true,
                    command: 'list_muted',
                    data: mutedUsers
                  };
                } catch (error) {
                  response.message = 'Erreur récupération mutes';
                }
                break;

              case 'unban_user':
                try {
                  await db.unbanUser(message.params.fingerprint, message.params.ip);
                  response = { type: 'admin_response', success: true, command: 'unban_user', message: 'Utilisateur débanni' };
                } catch (error) {
                  response.message = 'Erreur déban';
                }
                break;

              case 'unmute_user':
                try {
                  await db.unmuteUser(message.params.fingerprint);
                  response = { type: 'admin_response', success: true, command: 'unmute_user', message: 'Utilisateur démuté' };
                } catch (error) {
                  response.message = 'Erreur démute';
                }
                break;
            }

            ws.send(JSON.stringify(response));
          }
          break;
      }
    } catch (error) {
      console.error('[WS] Erreur traitement message:', error);
    }
  });

  ws.on('close', async () => {
    console.log(`[WS] Déconnexion: ${clientId}`);
    const client = connectedClients.get(clientId);
    if (client) {
      if (client.currentStream) {
        const viewers = streamViewers.get(client.currentStream);
        if (viewers) {
          viewers.delete(clientId);
          const stream = activeStreams.get(client.currentStream);
          if (stream) {
            stream.viewers = viewers.size;
            broadcastToAll({ type: 'stream_updated', stream: stream, streamKey: client.currentStream });
          }
        }
      }
      try {
        await db.removeConnectedUser(clientId);
      } catch (error) {
        console.error('Erreur suppression user:', error);
      }
      if (client.username) {
        const sessionDuration = Date.now() - client.connectTime.getTime();
        await logger.sendLog('user_disconnected', {
          username: client.username,
          ip: client.ip,
          os: client.os,
          deviceType: client.deviceType,
          browser: client.browser,
          sessionDuration: logger.formatDuration(sessionDuration)
        });
      }
    }
    connectedClients.delete(clientId);
    broadcastToAll({ type: 'user_count', count: connectedClients.size });
  });

  ws.on('error', (error) => {
    console.error(`[WS] Erreur ${clientId}:`, error);
  });
});

server.on('request', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/api/stream/detect' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const streamKey = data.streamKey || `stream_${Date.now()}`;

        if (data.action === 'start') {
          const streamData = {
            key: streamKey,
            title: data.title || `Stream ${streamKey}`,
            description: data.description || 'Stream RTMP',
            thumbnail: data.thumbnail || 'https://images.pexels.com/photos/1763075/pexels-photo-1763075.jpeg?auto=compress&cs=tinysrgb&w=800&h=450&dpr=1',
            startTime: new Date(),
            viewers: 0,
            isLive: true,
            autoDetected: true,
            rtmpUrl: data.rtmpUrl,
            hlsUrl: data.hlsUrl
          };

          activeStreams.set(streamKey, streamData);

          if (!streamViewers.has(streamKey)) {
            streamViewers.set(streamKey, new Set());
          }
          if (!streamChatHistory.has(streamKey)) {
            streamChatHistory.set(streamKey, []);
          }

          broadcastToAll({ type: 'stream_detected', stream: streamData, streamKey: streamKey });

        } else if (data.action === 'stop') {
          if (activeStreams.has(streamKey)) {
            const stream = activeStreams.get(streamKey);
            stream.isLive = false;
            broadcastToAll({ type: 'stream_ended', streamKey: streamKey, stream: stream });
            setTimeout(() => {
              activeStreams.delete(streamKey);
              streamViewers.delete(streamKey);
            }, 30000);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, streamKey: streamKey }));

      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Erreur' }));
      }
    });
  } else if (req.url === '/api/streams' && req.method === 'GET') {
    const streams = Array.from(activeStreams.values());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, streams }));
  } else if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      status: 'online',
      connectedUsers: connectedClients.size,
      activeStreams: activeStreams.size,
      uptime: process.uptime()
    }));
  } else if (req.url === '/api/logs' && req.method === 'GET') {
    db.getActivityLogs(100).then(logs => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, logs }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
  } else if (req.url === '/api/logs' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const logData = JSON.parse(body);
        db.addActivityLog(logData).then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
      }
    });
  } else if (req.url === '/api/admin/ban' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await db.banUser({
          fingerprint: data.fingerprint,
          ip: data.ip,
          username: data.username,
          reason: data.reason,
          bannedBy: data.bannedBy,
          isPermanent: data.isPermanent !== false
        });
        await db.addActivityLog({
          action_type: 'USER_BANNED',
          username: data.username,
          ip_address: data.ip,
          fingerprint: data.fingerprint,
          details: { reason: data.reason },
          severity: 'high',
          admin_username: data.bannedBy
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
  } else if (req.url === '/api/admin/mute' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await db.muteUser({
          fingerprint: data.fingerprint,
          username: data.username,
          ip: data.ip,
          muteEndTime: data.muteEndTime,
          reason: data.reason,
          mutedBy: data.mutedBy
        });
        await db.addActivityLog({
          action_type: 'USER_MUTED',
          username: data.username,
          ip_address: data.ip,
          fingerprint: data.fingerprint,
          details: { reason: data.reason, duration: data.duration },
          severity: 'medium',
          admin_username: data.mutedBy
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
  } else if (req.url === '/api/admin/banned' && req.method === 'GET') {
    (async () => {
      try {
        const banned = await db.getBannedUsers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, banned }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    })();
  } else if (req.url === '/api/admin/muted' && req.method === 'GET') {
    (async () => {
      try {
        const muted = await db.getMutedUsers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, muted }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    })();
  } else if (req.url === '/api/admin/unban' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await db.unbanUser(data.fingerprint, data.ip);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
  } else if (req.url === '/api/admin/unmute' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await db.unmuteUser(data.fingerprint);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
  } else if (req.url === '/api/admin/activity-logs' && req.method === 'GET') {
    (async () => {
      try {
        const logs = await db.getActivityLogs(100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, logs: logs || [] }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, logs: [] }));
      }
    })();
  } else if (req.url === '/api/admin/banned-users' && req.method === 'GET') {
    (async () => {
      try {
        const banned = await db.getBannedUsers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, users: banned || [] }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, users: [] }));
      }
    })();
  } else if (req.url === '/api/admin/muted-users' && req.method === 'GET') {
    (async () => {
      try {
        const muted = await db.getMutedUsers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, users: muted || [] }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, users: [] }));
      }
    })();
  } else if (req.url === '/api/admin/stream-stats' && req.method === 'GET') {
    (async () => {
      try {
        const stats = {
          activeStreams: activeStreams.size,
          totalViewers: Array.from(streamViewers.values()).reduce((sum, viewers) => sum + viewers.size, 0),
          streams: Array.from(activeStreams.entries()).map(([key, stream]) => ({
            streamKey: key,
            title: stream.title,
            viewers: streamViewers.get(key)?.size || 0,
            startTime: stream.startTime
          }))
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, stats }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, stats: { activeStreams: 0, totalViewers: 0, streams: [] } }));
      }
    })();
  } else if (req.url === '/api/admin/update-settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const settings = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Paramètres sauvegardés' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

setInterval(async () => {
  try {
    await db.clearExpiredMutes();
    const now = Date.now();
    for (const [streamKey, stream] of activeStreams.entries()) {
      const viewers = streamViewers.get(streamKey);
      if (!viewers || viewers.size === 0) {
        const inactiveTime = now - stream.startTime.getTime();
        if (inactiveTime > 1800000) {
          activeStreams.delete(streamKey);
          streamViewers.delete(streamKey);
          streamChatHistory.delete(streamKey);
          broadcastToAll({ type: 'stream_removed', streamKey: streamKey });
        }
      }
    }
  } catch (error) {
    console.error('Erreur nettoyage:', error);
  }
}, 300000);

const PORT = SERVER_CONFIG.WS_PORT;

setInterval(() => {
  broadcastAdminData();
}, 10000);

server.listen(PORT, () => {
  console.log('🚀 [WebSocket] Serveur démarré');
  console.log(`📡 [WebSocket] Port: ${PORT}`);
  console.log('✅ Serveur prêt');
});

process.on('SIGINT', () => {
  console.log('\n🛑 Arrêt serveur...');
  connectedClients.forEach((client) => client.ws.close());
  db.close();
  server.close(() => {
    console.log('✅ Serveur arrêté');
    process.exit(0);
  });
});

export default server;
