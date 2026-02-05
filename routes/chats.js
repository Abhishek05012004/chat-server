const express = require("express")
const router = express.Router()
const Chat = require("../models/Chat")
const Message = require("../models/Message")
const FriendRequest = require("../models/FriendRequest")
const authMiddleware = require("../middleware/auth")

// Get all chats for current user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ participants: req.user._id })
      .populate("participants", "username email status lastSeen profileImage")
      .populate({
        path: "lastMessage",
        populate: { path: "sender", select: "username profileImage" },
      })
      .sort({ updatedAt: -1 })

    const chatsWithUnread = await Promise.all(
      chats.map(async (chat) => {
        const unreadCount = await Message.countDocuments({
          chat: chat._id,
          sender: { $ne: req.user._id },
          "seenBy.user": { $ne: req.user._id },
        })
        return {
          ...chat.toObject(),
          unreadCount,
        }
      }),
    )

    res.status(200).json({ chats: chatsWithUnread })
  } catch (error) {
    console.error("[v0] Get chats error:", error)
    res.status(500).json({ message: "Server error while fetching chats" })
  }
})

// Get or create chat with a user
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" })
    }

    if (userId === req.user._id.toString()) {
      return res.status(400).json({ message: "Cannot chat with yourself" })
    }

    // Check if users are friends
    const friendRequest = await FriendRequest.findOne({
      $or: [
        { sender: req.user._id, receiver: userId },
        { sender: userId, receiver: req.user._id },
      ],
      status: "accepted",
    })

    if (!friendRequest) {
      return res.status(403).json({ message: "You must be friends to start a chat" })
    }

    // Check if chat already exists
    let chat = await Chat.findOne({
      participants: { $all: [req.user._id, userId] },
    })
      .populate("participants", "username email status lastSeen profileImage")
      .populate({
        path: "lastMessage",
        populate: { path: "sender", select: "username profileImage" },
      })

    if (!chat) {
      // Create new chat
      chat = new Chat({
        participants: [req.user._id, userId],
      })
      await chat.save()

      chat = await Chat.findById(chat._id)
        .populate("participants", "username email status lastSeen profileImage")
        .populate({
          path: "lastMessage",
          populate: { path: "sender", select: "username profileImage" },
        })
    }

    res.status(200).json({ chat })
  } catch (error) {
    console.error("[v0] Create chat error:", error)
    res.status(500).json({ message: "Server error while creating chat" })
  }
})

// Get messages for a chat
router.get("/:chatId/messages", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params
    const { page = 1, limit = 50 } = req.query

    // Check if user is part of the chat
    const chat = await Chat.findById(chatId)

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" })
    }

    if (!chat.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized access to this chat" })
    }

    const messages = await Message.find({ chat: chatId })
      .populate("sender", "username email status profileImage")
      .populate("reactions.user", "username profileImage")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    const totalMessages = await Message.countDocuments({ chat: chatId })

    const filteredMessages = messages.reverse().filter((msg) => {
      if (msg.isDeletedForAll) return false
      if (msg.deletedBy && msg.deletedBy.some((d) => d.user.toString() === req.user._id.toString())) {
        return false
      }
      return true
    })

    res.status(200).json({
      messages: filteredMessages,
      totalPages: Math.ceil(totalMessages / limit),
      currentPage: page,
    })
  } catch (error) {
    console.error("[v0] Get messages error:", error)
    res.status(500).json({ message: "Server error while fetching messages" })
  }
})

// Send a message
router.post("/:chatId/messages", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params
    const { content } = req.body

    if (!content || !content.trim()) {
      return res.status(400).json({ message: "Message content is required" })
    }

    // Check if user is part of the chat
    const chat = await Chat.findById(chatId)

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" })
    }

    if (!chat.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized access to this chat" })
    }

    // Create message
    const message = new Message({
      chat: chatId,
      sender: req.user._id,
      content: content.trim(),
      seenBy: [{ user: req.user._id }],
      deliveredTo: [{ user: req.user._id }],
      reactions: [],
    })

    await message.save()

    // Update chat's last message
    chat.lastMessage = message._id
    chat.updatedAt = new Date()
    await chat.save()

    const populatedMessage = await Message.findById(message._id).populate(
      "sender",
      "username email status profileImage",
    )

    res.status(201).json({ message: populatedMessage })
  } catch (error) {
    console.error("[v0] Send message error:", error)
    res.status(500).json({ message: "Server error while sending message" })
  }
})

// Add call log message (WhatsApp-style: video call for n min / no answer / rejected)
router.post("/:chatId/call-log", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params
    const { callStatus, callerId, durationInSeconds } = req.body

    if (!callStatus || !callerId) {
      return res.status(400).json({ message: "callStatus and callerId are required" })
    }

    const validStatuses = ["completed", "no_answer", "rejected"]
    if (!validStatuses.includes(callStatus)) {
      return res.status(400).json({ message: "callStatus must be completed, no_answer, or rejected" })
    }

    const chat = await Chat.findById(chatId)
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" })
    }

    const userIdStr = req.user._id.toString()
    if (!chat.participants.some((p) => p.toString() === callerId) || !chat.participants.some((p) => p.toString() === userIdStr)) {
      return res.status(403).json({ message: "Unauthorized" })
    }

    let content
    let callDuration = null

    if (callStatus === "completed") {
      const mins = durationInSeconds ? Math.floor(durationInSeconds / 60) : 0
      const secs = durationInSeconds ? durationInSeconds % 60 : 0
      if (mins > 0) {
        content = `Video call for ${mins} minute${mins !== 1 ? "s" : ""}`
      } else {
        content = secs > 0 ? `Video call for ${secs} second${secs !== 1 ? "s" : ""}` : "Video call"
      }
      callDuration = durationInSeconds || 0
    } else if (callStatus === "no_answer") {
      content = "Video call - No answer"
    } else {
      content = "Video call rejected"
    }

    const message = new Message({
      chat: chatId,
      sender: callerId,
      content,
      type: "call",
      callDuration: callDuration || undefined,
      seenBy: [{ user: req.user._id }],
      deliveredTo: [{ user: req.user._id }],
      reactions: [],
    })

    await message.save()

    chat.lastMessage = message._id
    chat.updatedAt = new Date()
    await chat.save()

    const populatedMessage = await Message.findById(message._id).populate(
      "sender",
      "username email status profileImage",
    )

    res.status(201).json({ message: populatedMessage })
  } catch (error) {
    console.error("[v0] Call log error:", error)
    res.status(500).json({ message: "Error while saving call log" })
  }
})

// Mark messages as seen
router.post("/:chatId/seen", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params

    // Check if user is part of the chat
    const chat = await Chat.findById(chatId)

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" })
    }

    if (!chat.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized access to this chat" })
    }

    // Mark all messages as seen by current user
    await Message.updateMany(
      {
        chat: chatId,
        sender: { $ne: req.user._id },
        "seenBy.user": { $ne: req.user._id },
      },
      {
        $push: {
          seenBy: {
            user: req.user._id,
            seenAt: new Date(),
          },
        },
      },
    )

    res.status(200).json({ message: "Messages marked as seen" })
  } catch (error) {
    console.error("[v0] Mark seen error:", error)
    res.status(500).json({ message: "Server error while marking messages as seen" })
  }
})

// Mark messages as delivered
router.post("/:chatId/delivered", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params

    // Check if user is part of the chat
    const chat = await Chat.findById(chatId)

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" })
    }

    if (!chat.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized access to this chat" })
    }

    // Mark all messages as delivered to current user
    await Message.updateMany(
      {
        chat: chatId,
        sender: { $ne: req.user._id },
        "deliveredTo.user": { $ne: req.user._id },
      },
      {
        $push: {
          deliveredTo: {
            user: req.user._id,
            deliveredAt: new Date(),
          },
        },
      },
    )

    res.status(200).json({ message: "Messages marked as delivered" })
  } catch (error) {
    console.error("[v0] Mark delivered error:", error)
    res.status(500).json({ message: "Server error while marking messages as delivered" })
  }
})

// Get unread message count
router.get("/:chatId/unread", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params

    const unreadCount = await Message.countDocuments({
      chat: chatId,
      sender: { $ne: req.user._id },
      "seenBy.user": { $ne: req.user._id },
    })

    res.status(200).json({ unreadCount })
  } catch (error) {
    console.error("[v0] Get unread count error:", error)
    res.status(500).json({ message: "Server error while fetching unread count" })
  }
})

router.post("/:chatId/messages/:messageId/react", authMiddleware, async (req, res) => {
  try {
    const { chatId, messageId } = req.params
    const { emoji } = req.body

    if (!emoji) {
      return res.status(400).json({ message: "Emoji is required" })
    }

    // Check if user is part of the chat
    const chat = await Chat.findById(chatId)
    if (!chat || !chat.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized" })
    }

    const message = await Message.findById(messageId)
    if (!message) {
      return res.status(404).json({ message: "Message not found" })
    }

    // Check if user already reacted with this emoji
    const existingReaction = message.reactions.find(
      (r) => r.user.toString() === req.user._id.toString() && r.emoji === emoji,
    )

    if (existingReaction) {
      // Remove reaction
      message.reactions = message.reactions.filter(
        (r) => !(r.user.toString() === req.user._id.toString() && r.emoji === emoji),
      )
    } else {
      // Remove any other reaction from this user (one reaction per user)
      message.reactions = message.reactions.filter((r) => r.user.toString() !== req.user._id.toString())
      // Add new reaction
      message.reactions.push({
        user: req.user._id,
        emoji,
        createdAt: new Date(),
      })
    }

    await message.save()

    const populatedMessage = await Message.findById(messageId)
      .populate("sender", "username email status profileImage")
      .populate("reactions.user", "username profileImage")

    res.status(200).json({ message: populatedMessage })
  } catch (error) {
    console.error("[v0] React to message error:", error)
    res.status(500).json({ message: "Server error while reacting to message" })
  }
})

router.delete("/:chatId/messages/:messageId", authMiddleware, async (req, res) => {
  try {
    const { chatId, messageId } = req.params
    const { deleteType = "me" } = req.body // "me" or "everyone"

    // Check if user is part of the chat
    const chat = await Chat.findById(chatId)
    if (!chat || !chat.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized" })
    }

    const message = await Message.findById(messageId)
    if (!message) {
      return res.status(404).json({ message: "Message not found" })
    }

    const isSender = message.sender.toString() === req.user._id.toString()

    if (deleteType === "everyone") {
      if (!isSender) {
        return res.status(403).json({ message: "Only sender can delete for everyone" })
      }
      message.isDeletedForAll = true
    } else {
      const alreadyDeleted = message.deletedBy.some((d) => d.user.toString() === req.user._id.toString())
      if (!alreadyDeleted) {
        message.deletedBy.push({
          user: req.user._id,
          deletedAt: new Date(),
        })
      }
    }

    await message.save()

    res.status(200).json({ message: "Message deleted successfully" })
  } catch (error) {
    console.error("[v0] Delete message error:", error)
    res.status(500).json({ message: "Server error while deleting message" })
  }
})

module.exports = router
