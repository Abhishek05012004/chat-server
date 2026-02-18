const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const dotenv = require("dotenv")
const http = require("http")
const { Server } = require("socket.io")
const path = require("path")
const fs = require("fs")

dotenv.config()

const app = express()
const server = http.createServer(app)

// CORS configuration - updated with your Vercel URL
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://chat-client-pink-eight.vercel.app" // Your Vercel URL
]

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes("localhost")) {
      callback(null, true)
    } else {
      console.log(`CORS blocked origin: ${origin}`)
      callback(new Error("Not allowed by CORS"))
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}

app.use(cors(corsOptions))

// Handle preflight requests
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*")
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    res.header("Access-Control-Allow-Credentials", "true")
    return res.status(200).end()
  }
  next()
})

app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads")
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Serve static files with proper headers
app.use(
  "/api/uploads/static",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("X-Content-Type-Options", "nosniff")
    next()
  },
  express.static(uploadsDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".pdf")) {
        res.setHeader("Content-Type", "application/pdf")
        res.setHeader("Content-Disposition", "inline")
      }
    },
  }),
)

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/mern-chat")
  .then(() => console.log("MongoDB Connected Successfully"))
  .catch((err) => {
    console.error("MongoDB Connection Error:", err)
  })

const User = require("./models/User")

// Socket.io configuration - updated with Vercel URL
const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      // Allow requests with no origin
      if (!origin) return callback(null, true)
      
      if (allowedOrigins.indexOf(origin) !== -1 || origin.includes("localhost")) {
        callback(null, true)
      } else {
        callback(new Error("Not allowed by CORS"))
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
})

app.set("io", io)

const activeCallSessions = {}
const userSockets = {}
const userLoginTime = {}

// Socket.io connection (keep all your existing socket logic as is)
io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  socket.on("user-online", async (userId, loginTime) => {
    const uid = String(userId)
    socket.userId = uid
    socket.loginTime = loginTime || Date.now()
    socket.join(`user:${uid}`)
    userSockets[uid] = socket.id
    userLoginTime[uid] = socket.loginTime

    console.log(`[SOCKET] User ${uid} joined room user:${uid}, socket ID: ${socket.id}, Login Time: ${socket.loginTime}`)
    console.log(`[SOCKET] Total users online:`, Object.keys(userSockets).length)

    try {
      const user = await User.findByIdAndUpdate(
        uid,
        { 
          status: "online", 
          lastSeen: new Date(), 
          socketId: socket.id,
          loginTime: socket.loginTime
        },
        { new: true },
      )

      if (!user) {
        console.error(`[SOCKET] User not found for id: ${uid}`)
        return
      }

      io.emit("user-status-changed", { 
        userId: uid, 
        status: "online",
        loginTime: socket.loginTime
      })
      console.log(`[SOCKET] User ${uid} is now online, broadcast sent`)
    } catch (error) {
      console.error("Error updating user status:", error)
    }
  })

  socket.on("user-offline", async (userId) => {
    const uid = String(userId)
    console.log(`[SOCKET] User ${uid} going offline (user-offline event)`)
    
    if (userLoginTime[uid] && userLoginTime[uid] === socket.loginTime) {
      try {
        delete userSockets[uid]
        delete userLoginTime[uid]
        
        await User.findByIdAndUpdate(uid, {
          status: "offline",
          lastSeen: new Date(),
          socketId: null,
        })
        
        socket.broadcast.emit("user-status-changed", { 
          userId: uid, 
          status: "offline" 
        })
        console.log(`[SOCKET] User ${uid} marked offline, broadcast sent`)
      } catch (error) {
        console.error("Error marking user offline:", error)
      }
    } else {
      console.log(`[SOCKET] User ${uid} has another active session, not marking offline`)
    }
  })

  socket.on("call:initiate", (data) => {
    const { callerId, receiverId, offer, callerName, callerProfile, chatId } = data
    console.log(`[CALL] ${callerId} initiating call to ${receiverId}`)
    
    const receiverSocketId = userSockets[receiverId]
    if (!receiverSocketId) {
      console.log(`[CALL] ${receiverId} is offline - socket not found`)
      socket.emit("call:user-offline", {
        receiverId,
        message: "User is offline",
      })
      return
    }

    const receiverSession = activeCallSessions[receiverId]
    if (receiverSession && receiverSession.status === "connected") {
      console.log(`[CALL] ${receiverId} is busy in an active call`)
      socket.emit("call:busy", {
        receiverId,
        message: "User is already on another call",
      })
      return
    }

    const callerSession = activeCallSessions[callerId]
    if (callerSession && callerSession.status === "connected") {
      console.log(`[CALL] ${callerId} is already in an active call`)
      socket.emit("call:busy", {
        receiverId,
        message: "You are already in a call",
      })
      return
    }

    if (callerSession && callerSession.status !== "connected") {
      delete activeCallSessions[callerId]
    }
    if (receiverSession && receiverSession.status !== "connected") {
      delete activeCallSessions[receiverId]
    }

    const callSessionId = `${callerId}-${receiverId}-${Date.now()}`
    activeCallSessions[callerId] = {
      sessionId: callSessionId,
      callerId,
      receiverId,
      status: "calling",
      startTime: Date.now(),
    }
    activeCallSessions[receiverId] = {
      sessionId: callSessionId,
      callerId,
      receiverId,
      status: "ringing",
      startTime: Date.now(),
    }

    console.log(`[CALL] Sending offer to receiver ${receiverId}`)
    
    const noAnswerTimeout = setTimeout(() => {
      const currentReceiverSession = activeCallSessions[receiverId]
      if (currentReceiverSession && currentReceiverSession.status === "ringing") {
        console.log(`[CALL] ${receiverId} did not answer - timeout`)
        
        delete activeCallSessions[callerId]
        delete activeCallSessions[receiverId]
        
        io.to(`user:${callerId}`).emit("call:ended", {
          callerId,
          receiverId,
          reason: "no_answer",
        })
        
        io.to(`user:${receiverId}`).emit("call:ended", {
          callerId,
          receiverId,
          reason: "no_answer_timeout",
        })
      }
    }, 30000)

    activeCallSessions[callerId].noAnswerTimeout = noAnswerTimeout
    activeCallSessions[receiverId].noAnswerTimeout = noAnswerTimeout

    io.to(`user:${receiverId}`).emit("call:incoming", {
      callerId,
      receiverId,
      offer,
      callerName,
      callerProfile,
      chatId,
      sessionId: callSessionId,
    })
    console.log(`[CALL] Offer sent to ${receiverId}`)
  })

  socket.on("call:accept", (data) => {
    const { callerId, receiverId, answer, receiverName } = data
    console.log(`[CALL] ${receiverId} accepted call from ${callerId}`)

    const callerSession = activeCallSessions[callerId]
    const receiverSession = activeCallSessions[receiverId]
    
    if (!callerSession || !receiverSession) {
      console.log(`[CALL] Call session not found`)
      socket.emit("call:session-not-found", { callerId, receiverId })
      return
    }

    if (callerSession.noAnswerTimeout) {
      clearTimeout(callerSession.noAnswerTimeout)
    }
    if (receiverSession.noAnswerTimeout) {
      clearTimeout(receiverSession.noAnswerTimeout)
    }

    callerSession.status = "connected"
    receiverSession.status = "connected"
    delete callerSession.noAnswerTimeout
    delete receiverSession.noAnswerTimeout

    io.to(`user:${callerId}`).emit("call:answer-received", {
      callerId,
      receiverId,
      answer,
      receiverName,
    })
    
    io.to(`user:${callerId}`).emit("call:accepted-notification", {
      callerId,
      receiverId,
    })
    
    io.to(`user:${receiverId}`).emit("call:accepted-notification", {
      callerId,
      receiverId,
    })
    
    console.log(`[CALL] Answer sent to ${callerId} and acceptance notifications sent`)
  })

  socket.on("call:reject", (data) => {
    const { callerId, receiverId, reason, receiverName } = data
    console.log(`[CALL] ${receiverId} rejected call from ${callerId}`)

    const callerSession = activeCallSessions[callerId]
    const receiverSession = activeCallSessions[receiverId]
    
    if (callerSession?.noAnswerTimeout) {
      clearTimeout(callerSession.noAnswerTimeout)
    }
    if (receiverSession?.noAnswerTimeout) {
      clearTimeout(receiverSession.noAnswerTimeout)
    }

    delete activeCallSessions[callerId]
    delete activeCallSessions[receiverId]

    io.to(`user:${callerId}`).emit("call:rejected", {
      callerId,
      receiverId,
      reason,
      receiverName: receiverName || "User",
    })
    
    io.to(`user:${receiverId}`).emit("call:ended", {
      callerId,
      receiverId,
      reason: "rejected_by_user",
    })
    
    console.log(`[CALL] Rejection sent to ${callerId}`)
  })

  socket.on("ice-candidate", (data) => {
    const { fromUserId, toUserId, candidate } = data
    console.log(`[ICE] Candidate from ${fromUserId} to ${toUserId}`)

    io.to(`user:${toUserId}`).emit("ice-candidate", {
      fromUserId,
      toUserId,
      candidate,
    })
  })

  socket.on("call:toggle-media", (data) => {
    const { toUserId, type, enabled } = data
    console.log(`[MEDIA] Toggle ${type} to ${enabled} for ${toUserId}`)
    
    io.to(`user:${toUserId}`).emit("call:toggle-media", {
      type,
      enabled,
      fromUserId: socket.userId
    })
  })

  socket.on("call:end", (data) => {
    const { callerId, receiverId, reason } = data
    console.log(`[CALL] ${callerId} ended call with ${receiverId}, reason: ${reason}`)

    const callerSession = activeCallSessions[callerId]
    const receiverSession = activeCallSessions[receiverId]
    
    if (callerSession?.noAnswerTimeout) {
      clearTimeout(callerSession.noAnswerTimeout)
    }
    if (receiverSession?.noAnswerTimeout) {
      clearTimeout(receiverSession.noAnswerTimeout)
    }
    
    if (callerSession && callerSession.callerId === callerId && callerSession.receiverId === receiverId) {
      delete activeCallSessions[callerId]
      console.log(`[CALL] Cleared session for caller ${callerId}`)
    }
    
    if (receiverSession && receiverSession.callerId === callerId && receiverSession.receiverId === receiverId) {
      delete activeCallSessions[receiverId]
      console.log(`[CALL] Cleared session for receiver ${receiverId}`)
    }

    if (receiverId) {
      io.to(`user:${receiverId}`).emit("call:ended", {
        callerId,
        receiverId,
        reason,
      })
      console.log(`[CALL] End notification sent to receiver ${receiverId}`)
    }
    
    if (callerId) {
      io.to(`user:${callerId}`).emit("call:ended", {
        callerId,
        receiverId,
        reason,
      })
      console.log(`[CALL] End notification sent to caller ${callerId}`)
    }
    
    console.log(`[CALL] Call ended, sessions cleared. Remaining sessions:`, Object.keys(activeCallSessions))
  })

  socket.on("join-chat", (chatId) => {
    socket.join(chatId)
  })

  socket.on("send-message", (message) => {
    socket.to(message.chatId).emit("receive-message", message)
    io.emit("unread-count-changed", { chatId: message.chatId })
  })

  socket.on("message-delivered", (data) => {
    socket.to(data.chatId).emit("message-delivered-update", {
      chatId: data.chatId,
      messageId: data.messageId,
      userId: data.userId,
    })
  })

  socket.on("message-seen", (data) => {
    socket.to(data.chatId).emit("message-seen-update", {
      chatId: data.chatId,
      messageId: data.messageId,
      userId: data.userId,
    })
    io.emit("unread-count-changed", { chatId: data.chatId })
  })

  socket.on("typing", (data) => {
    socket.to(data.chatId).emit("user-typing", data)
  })

  socket.on("stop-typing", (data) => {
    socket.to(data.chatId).emit("user-stop-typing", data)
  })

  socket.on("message-reacted", (data) => {
    socket.to(data.chatId).emit("message-reaction-update", data)
  })

  socket.on("unread-count-changed", (data) => {
    io.emit("unread-count-changed", data)
  })

  socket.on("profile-updated", (data) => {
    socket.broadcast.emit("user-profile-updated", data)
  })

  socket.on("disconnect", async () => {
    const userId = socket.userId
    const loginTime = socket.loginTime
    
    console.log(`[SOCKET] User ${userId} disconnected, login time: ${loginTime}`)
    
    if (userId) {
      if (userLoginTime[userId] && userLoginTime[userId] === loginTime) {
        const userSession = activeCallSessions[userId]
        if (userSession) {
          const otherUserId = userSession.callerId === userId ? userSession.receiverId : userSession.callerId
          
          if (otherUserId) {
            io.to(`user:${otherUserId}`).emit("call:ended", {
              callerId: userSession.callerId,
              receiverId: userSession.receiverId,
              reason: "disconnected",
            })
          }
          
          if (userSession.noAnswerTimeout) {
            clearTimeout(userSession.noAnswerTimeout)
          }
          
          delete activeCallSessions[userId]
          delete activeCallSessions[otherUserId]
        }

        delete userSockets[userId]
        delete userLoginTime[userId]

        try {
          await User.findByIdAndUpdate(userId, { 
            status: "offline", 
            lastSeen: new Date(),
            socketId: null 
          })
          
          socket.broadcast.emit("user-status-changed", {
            userId,
            status: "offline",
          })
          console.log(`[SOCKET] User ${userId} marked offline due to disconnect`)
        } catch (error) {
          console.error("Error updating user status:", error)
        }
      } else {
        console.log(`[SOCKET] User ${userId} has another active session, not marking offline`)
      }
    }
    console.log("User disconnected:", socket.id)
  })
})

// Routes
app.use("/api/auth", require("./routes/auth"))
app.use("/api/users", require("./routes/users"))
app.use("/api/friends", require("./routes/friends"))
app.use("/api/chats", require("./routes/chats"))
app.use("/api/uploads", require("./routes/uploads"))
app.use("/api/profile", require("./routes/profile"))

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    message: "MERN Chat API is running",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    websocket: 'active',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    client_url: "https://chat-client-pink-eight.vercel.app"
  })
})

// Test endpoint for WebSocket connection
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    activeConnections: io.engine.clientsCount,
    activeCallSessions: Object.keys(activeCallSessions).length,
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    client_url: "https://chat-client-pink-eight.vercel.app"
  })
})

const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`)
  console.log(`WebSocket server ready`)
  console.log(`Client URL: https://chat-client-pink-eight.vercel.app`)
})

module.exports = { io }