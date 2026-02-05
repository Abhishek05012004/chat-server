const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);

// IMPORTANT: For Render, use the PORT environment variable
const PORT = process.env.PORT || 10000;

// Configure CORS for production
const corsOptions = {
  origin: [
    process.env.CLIENT_URL || "http://localhost:5173",
    "http://localhost:3000" // For local testing
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Configure Socket.IO for Render
const io = new Server(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"], // Important for Render
  allowEIO3: true // For compatibility
});

// FIXED: Handle preflight requests properly
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", corsOptions.origin[0]); // Use first origin
  res.setHeader("Access-Control-Allow-Methods", corsOptions.methods.join(", "));
  res.setHeader("Access-Control-Allow-Headers", corsOptions.allowedHeaders.join(", "));
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.status(200).end();
});

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(
  "/api/uploads/static",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  },
  express.static(uploadsDir, {
    setHeaders: (res, path) => {
      if (path.endsWith(".pdf")) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "inline");
      }
    },
  })
);

// SIMPLIFIED MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/mern-chat")
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
  });

const User = require("./models/User");

app.set("io", io);

const activeCallSessions = {};
const userSockets = {};
const userLoginTime = {};

// Socket.io connection
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("user-online", async (userId, loginTime) => {
    const uid = String(userId);
    socket.userId = uid;
    socket.loginTime = loginTime || Date.now();
    socket.join(`user:${uid}`);
    userSockets[uid] = socket.id;
    userLoginTime[uid] = socket.loginTime;

    console.log(`[SOCKET] User ${uid} joined room user:${uid}, socket ID: ${socket.id}, Login Time: ${socket.loginTime}`);
    console.log(`[SOCKET] Total users online:`, Object.keys(userSockets).length);

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
      );

      if (!user) {
        console.error(`[SOCKET] User not found for id: ${uid}`);
        return;
      }

      io.emit("user-status-changed", { 
        userId: uid, 
        status: "online",
        loginTime: socket.loginTime
      });
      console.log(`[SOCKET] User ${uid} is now online, broadcast sent`);
    } catch (error) {
      console.error("Error updating user status:", error);
    }
  });

  socket.on("user-offline", async (userId) => {
    const uid = String(userId);
    console.log(`[SOCKET] User ${uid} going offline (user-offline event)`);
    
    // Only mark offline if this is the most recent login session
    if (userLoginTime[uid] && userLoginTime[uid] === socket.loginTime) {
      try {
        delete userSockets[uid];
        delete userLoginTime[uid];
        
        await User.findByIdAndUpdate(uid, {
          status: "offline",
          lastSeen: new Date(),
          socketId: null,
        });
        
        socket.broadcast.emit("user-status-changed", { 
          userId: uid, 
          status: "offline" 
        });
        console.log(`[SOCKET] User ${uid} marked offline, broadcast sent`);
      } catch (error) {
        console.error("Error marking user offline:", error);
      }
    } else {
      console.log(`[SOCKET] User ${uid} has another active session, not marking offline`);
    }
  });

  socket.on("call:initiate", (data) => {
    const { callerId, receiverId, offer, callerName, callerProfile, chatId } = data;
    console.log(`[CALL] ${callerId} initiating call to ${receiverId}`);
    
    // Check if receiver is online
    const receiverSocketId = userSockets[receiverId];
    if (!receiverSocketId) {
      console.log(`[CALL] ${receiverId} is offline - socket not found`);
      socket.emit("call:user-offline", {
        receiverId,
        message: "User is offline",
      });
      return;
    }

    // Check if receiver is already in an ACTIVE call
    const receiverSession = activeCallSessions[receiverId];
    if (receiverSession && receiverSession.status === "connected") {
      console.log(`[CALL] ${receiverId} is busy in an active call`);
      socket.emit("call:busy", {
        receiverId,
        message: "User is already on another call",
      });
      return;
    }

    // Check if caller is already in an active call
    const callerSession = activeCallSessions[callerId];
    if (callerSession && callerSession.status === "connected") {
      console.log(`[CALL] ${callerId} is already in an active call`);
      socket.emit("call:busy", {
        receiverId,
        message: "You are already in a call",
      });
      return;
    }

    // Clear any pending call sessions for both users
    if (callerSession && callerSession.status !== "connected") {
      delete activeCallSessions[callerId];
    }
    if (receiverSession && receiverSession.status !== "connected") {
      delete activeCallSessions[receiverId];
    }

    // Track this call session
    const callSessionId = `${callerId}-${receiverId}-${Date.now()}`;
    activeCallSessions[callerId] = {
      sessionId: callSessionId,
      callerId,
      receiverId,
      status: "calling",
      startTime: Date.now(),
    };
    activeCallSessions[receiverId] = {
      sessionId: callSessionId,
      callerId,
      receiverId,
      status: "ringing",
      startTime: Date.now(),
    };

    console.log(`[CALL] Sending offer to receiver ${receiverId}`);
    
    // Set timeout for no answer (30 seconds)
    const noAnswerTimeout = setTimeout(() => {
      const currentReceiverSession = activeCallSessions[receiverId];
      if (currentReceiverSession && currentReceiverSession.status === "ringing") {
        console.log(`[CALL] ${receiverId} did not answer - timeout`);
        
        // Clear call sessions
        delete activeCallSessions[callerId];
        delete activeCallSessions[receiverId];
        
        // Notify caller
        io.to(`user:${callerId}`).emit("call:ended", {
          callerId,
          receiverId,
          reason: "no_answer",
        });
        
        // Notify receiver to clear incoming call UI
        io.to(`user:${receiverId}`).emit("call:ended", {
          callerId,
          receiverId,
          reason: "no_answer_timeout",
        });
      }
    }, 30000);

    // Store timeout ID for cleanup
    activeCallSessions[callerId].noAnswerTimeout = noAnswerTimeout;
    activeCallSessions[receiverId].noAnswerTimeout = noAnswerTimeout;

    // Send offer to receiver with complete caller info
    io.to(`user:${receiverId}`).emit("call:incoming", {
      callerId,
      receiverId,
      offer,
      callerName,
      callerProfile,
      chatId,
      sessionId: callSessionId,
    });
    console.log(`[CALL] Offer sent to ${receiverId}`);
  });

  socket.on("call:accept", (data) => {
    const { callerId, receiverId, answer, receiverName } = data;
    console.log(`[CALL] ${receiverId} accepted call from ${callerId}`);

    // Check if call session exists
    const callerSession = activeCallSessions[callerId];
    const receiverSession = activeCallSessions[receiverId];
    
    if (!callerSession || !receiverSession) {
      console.log(`[CALL] Call session not found`);
      socket.emit("call:session-not-found", { callerId, receiverId });
      return;
    }

    // Clear no answer timeout
    if (callerSession.noAnswerTimeout) {
      clearTimeout(callerSession.noAnswerTimeout);
    }
    if (receiverSession.noAnswerTimeout) {
      clearTimeout(receiverSession.noAnswerTimeout);
    }

    // Update call session status
    callerSession.status = "connected";
    receiverSession.status = "connected";
    delete callerSession.noAnswerTimeout;
    delete receiverSession.noAnswerTimeout;

    // Send answer back to caller
    io.to(`user:${callerId}`).emit("call:answer-received", {
      callerId,
      receiverId,
      answer,
      receiverName,
    });
    
    // Send acceptance notification to both parties
    io.to(`user:${callerId}`).emit("call:accepted-notification", {
      callerId,
      receiverId,
    });
    
    io.to(`user:${receiverId}`).emit("call:accepted-notification", {
      callerId,
      receiverId,
    });
    
    console.log(`[CALL] Answer sent to ${callerId} and acceptance notifications sent`);
  });

  socket.on("call:reject", (data) => {
    const { callerId, receiverId, reason, receiverName } = data;
    console.log(`[CALL] ${receiverId} rejected call from ${callerId}`);

    // Clear no answer timeout
    const callerSession = activeCallSessions[callerId];
    const receiverSession = activeCallSessions[receiverId];
    
    if (callerSession?.noAnswerTimeout) {
      clearTimeout(callerSession.noAnswerTimeout);
    }
    if (receiverSession?.noAnswerTimeout) {
      clearTimeout(receiverSession.noAnswerTimeout);
    }

    // Clear call sessions
    delete activeCallSessions[callerId];
    delete activeCallSessions[receiverId];

    // Send rejection to caller
    io.to(`user:${callerId}`).emit("call:rejected", {
      callerId,
      receiverId,
      reason,
      receiverName: receiverName || "User",
    });
    
    // Also send ended event to receiver to clear UI
    io.to(`user:${receiverId}`).emit("call:ended", {
      callerId,
      receiverId,
      reason: "rejected_by_user",
    });
    
    console.log(`[CALL] Rejection sent to ${callerId}`);
  });

  socket.on("ice-candidate", (data) => {
    const { fromUserId, toUserId, candidate } = data;
    console.log(`[ICE] Candidate from ${fromUserId} to ${toUserId}`);

    // Send ICE candidate to the other user
    io.to(`user:${toUserId}`).emit("ice-candidate", {
      fromUserId,
      toUserId,
      candidate,
    });
  });

  socket.on("call:end", (data) => {
    const { callerId, receiverId, reason } = data;
    console.log(`[CALL] ${callerId} ended call with ${receiverId}, reason: ${reason}`);

    // Verify the call session exists and matches before clearing
    const callerSession = activeCallSessions[callerId];
    const receiverSession = activeCallSessions[receiverId];
    
    // Clear no answer timeouts
    if (callerSession?.noAnswerTimeout) {
      clearTimeout(callerSession.noAnswerTimeout);
    }
    if (receiverSession?.noAnswerTimeout) {
      clearTimeout(receiverSession.noAnswerTimeout);
    }
    
    // Only clear sessions if they match the call being ended
    if (callerSession && callerSession.callerId === callerId && callerSession.receiverId === receiverId) {
      delete activeCallSessions[callerId];
      console.log(`[CALL] Cleared session for caller ${callerId}`);
    }
    
    if (receiverSession && receiverSession.callerId === callerId && receiverSession.receiverId === receiverId) {
      delete activeCallSessions[receiverId];
      console.log(`[CALL] Cleared session for receiver ${receiverId}`);
    }

    // Notify both users about call end
    if (receiverId) {
      io.to(`user:${receiverId}`).emit("call:ended", {
        callerId,
        receiverId,
        reason,
      });
      console.log(`[CALL] End notification sent to receiver ${receiverId}`);
    }
    
    if (callerId) {
      io.to(`user:${callerId}`).emit("call:ended", {
        callerId,
        receiverId,
        reason,
      });
      console.log(`[CALL] End notification sent to caller ${callerId}`);
    }
    
    console.log(`[CALL] Call ended, sessions cleared. Remaining sessions:`, Object.keys(activeCallSessions));
  });

  // Join chat room
  socket.on("join-chat", (chatId) => {
    socket.join(chatId);
  });

  socket.on("send-message", (message) => {
    socket.to(message.chatId).emit("receive-message", message);
    io.emit("unread-count-changed", { chatId: message.chatId });
  });

  socket.on("message-delivered", (data) => {
    socket.to(data.chatId).emit("message-delivered-update", {
      chatId: data.chatId,
      messageId: data.messageId,
      userId: data.userId,
    });
  });

  socket.on("message-seen", (data) => {
    socket.to(data.chatId).emit("message-seen-update", {
      chatId: data.chatId,
      messageId: data.messageId,
      userId: data.userId,
    });
    io.emit("unread-count-changed", { chatId: data.chatId });
  });

  socket.on("typing", (data) => {
    socket.to(data.chatId).emit("user-typing", data);
  });

  socket.on("stop-typing", (data) => {
    socket.to(data.chatId).emit("user-stop-typing", data);
  });

  socket.on("message-reacted", (data) => {
    socket.to(data.chatId).emit("message-reaction-update", data);
  });

  socket.on("unread-count-changed", (data) => {
    io.emit("unread-count-changed", data);
  });

  socket.on("profile-updated", (data) => {
    socket.broadcast.emit("user-profile-updated", data);
  });

  socket.on("disconnect", async () => {
    const userId = socket.userId;
    const loginTime = socket.loginTime;
    
    console.log(`[SOCKET] User ${userId} disconnected, login time: ${loginTime}`);
    
    if (userId) {
      // Only mark offline if this is the most recent login session
      if (userLoginTime[userId] && userLoginTime[userId] === loginTime) {
        // Handle active calls
        const userSession = activeCallSessions[userId];
        if (userSession) {
          const otherUserId = userSession.callerId === userId ? userSession.receiverId : userSession.callerId;
          
          // Notify other user that call ended due to disconnect
          if (otherUserId) {
            io.to(`user:${otherUserId}`).emit("call:ended", {
              callerId: userSession.callerId,
              receiverId: userSession.receiverId,
              reason: "disconnected",
            });
          }
          
          // Clear no answer timeouts
          if (userSession.noAnswerTimeout) {
            clearTimeout(userSession.noAnswerTimeout);
          }
          
          // Clear call sessions
          delete activeCallSessions[userId];
          delete activeCallSessions[otherUserId];
        }

        // Remove from userSockets and userLoginTime
        delete userSockets[userId];
        delete userLoginTime[userId];

        try {
          await User.findByIdAndUpdate(userId, { 
            status: "offline", 
            lastSeen: new Date(),
            socketId: null 
          });
          
          socket.broadcast.emit("user-status-changed", {
            userId,
            status: "offline",
          });
          console.log(`[SOCKET] User ${userId} marked offline due to disconnect`);
        } catch (error) {
          console.error("Error updating user status:", error);
        }
      } else {
        console.log(`[SOCKET] User ${userId} has another active session, not marking offline`);
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/friends", require("./routes/friends"));
app.use("/api/chats", require("./routes/chats"));
app.use("/api/uploads", require("./routes/uploads"));
app.use("/api/profile", require("./routes/profile"));

// Health check endpoint (REQUIRED for Render)
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    environment: process.env.NODE_ENV || "development",
    websocket: io.engine.clientsCount
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({ 
    message: "MERN Chat API Server",
    version: "1.0.0",
    websocket: "active",
    status: "running",
    environment: process.env.NODE_ENV || "development",
    client_url: process.env.CLIENT_URL || "Not set"
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: "Internal server error",
    message: process.env.NODE_ENV === "production" ? null : err.message
  });
});

// Start server - IMPORTANT: Listen on '0.0.0.0' for Render
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔗 Client URL: ${process.env.CLIENT_URL || "Not set"}`);
  console.log(`🔗 MongoDB: ${mongoose.connection.readyState === 1 ? "Connected" : "Disconnected"}`);
  console.log(`⚡ WebSocket Server: Ready`);
});

// Handle uncaught exceptions to prevent crash
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

module.exports = { io, server };