const express = require("express")
const router = express.Router()
const FriendRequest = require("../models/FriendRequest")
const Chat = require("../models/Chat")
const authMiddleware = require("../middleware/auth")
const User = require("../models/User")

// Send friend request
router.post("/request", authMiddleware, async (req, res) => {
  try {
    const { receiverId } = req.body

    if (!receiverId) {
      return res.status(400).json({ message: "Receiver ID is required" })
    }

    if (receiverId === req.user._id.toString()) {
      return res.status(400).json({ message: "Cannot send friend request to yourself" })
    }

    // Check if friend request already exists
    const existingRequest = await FriendRequest.findOne({
      $or: [
        { sender: req.user._id, receiver: receiverId },
        { sender: receiverId, receiver: req.user._id },
      ],
    })

    if (existingRequest) {
      if (existingRequest.status === "pending") {
        return res.status(400).json({ message: "Friend request already sent" })
      }
      if (existingRequest.status === "accepted") {
        return res.status(400).json({ message: "Already friends" })
      }
    }

    // Create new friend request
    const friendRequest = new FriendRequest({
      sender: req.user._id,
      receiver: receiverId,
      status: "pending",
    })

    await friendRequest.save()

    const populatedRequest = await FriendRequest.findById(friendRequest._id)
      .populate("sender", "username email status profileImage")
      .populate("receiver", "username email status profileImage")

    const io = req.app.get("io")
    if (io) {
      io.emit("friend-request-received", {
        receiverId: receiverId,
        senderId: req.user._id,
        senderUsername: populatedRequest.sender.username,
        requestId: friendRequest._id,
      })
    }

    res.status(201).json({
      message: "Friend request sent successfully",
      friendRequest: populatedRequest,
    })
  } catch (error) {
    console.error("Send friend request error:", error)
    res.status(500).json({ message: "Server error while sending friend request" })
  }
})

// Get received friend requests
router.get("/requests/received", authMiddleware, async (req, res) => {
  try {
    const friendRequests = await FriendRequest.find({
      receiver: req.user._id,
      status: "pending",
    })
      .populate("sender", "username email status lastSeen profileImage")
      .populate("receiver", "username email status profileImage")
      .sort({ createdAt: -1 })

    res.status(200).json({ friendRequests })
  } catch (error) {
    console.error("[v0] Get received requests error:", error)
    res.status(500).json({ message: "Server error while fetching friend requests" })
  }
})

// Get sent friend requests
router.get("/requests/sent", authMiddleware, async (req, res) => {
  try {
    const friendRequests = await FriendRequest.find({
      sender: req.user._id,
      status: "pending",
    })
      .populate("sender", "username email status profileImage")
      .populate("receiver", "username email status lastSeen profileImage")
      .sort({ createdAt: -1 })

    res.status(200).json({ friendRequests })
  } catch (error) {
    console.error("[v0] Get sent requests error:", error)
    res.status(500).json({ message: "Server error while fetching friend requests" })
  }
})

// Accept friend request
router.post("/request/:requestId/accept", authMiddleware, async (req, res) => {
  try {
    const friendRequest = await FriendRequest.findById(req.params.requestId)

    if (!friendRequest) {
      return res.status(404).json({ message: "Friend request not found" })
    }

    if (friendRequest.receiver.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Unauthorized to accept this request" })
    }

    if (friendRequest.status !== "pending") {
      return res.status(400).json({ message: "Friend request already processed" })
    }

    // Update friend request status
    friendRequest.status = "accepted"
    await friendRequest.save()

    // Create chat between the two users
    const existingChat = await Chat.findOne({
      participants: { $all: [friendRequest.sender, friendRequest.receiver] },
    })

    if (!existingChat) {
      const chat = new Chat({
        participants: [friendRequest.sender, friendRequest.receiver],
      })
      await chat.save()
    }

    const populatedRequest = await FriendRequest.findById(friendRequest._id)
      .populate("sender", "username email status profileImage")
      .populate("receiver", "username email status profileImage")

    const io = req.app.get("io")
    const acceptedByUser = await User.findById(req.user._id).select("username")
    if (io && acceptedByUser) {
      io.emit("friend-request-accepted", {
        senderId: friendRequest.sender._id,
        acceptedById: req.user._id,
        acceptedByUsername: acceptedByUser.username,
      })
    }

    res.status(200).json({
      message: "Friend request accepted",
      friendRequest: populatedRequest,
    })
  } catch (error) {
    console.error("Accept friend request error:", error)
    res.status(500).json({ message: "Server error while accepting friend request" })
  }
})

// Reject friend request
router.post("/request/:requestId/reject", authMiddleware, async (req, res) => {
  try {
    const friendRequest = await FriendRequest.findById(req.params.requestId)

    if (!friendRequest) {
      return res.status(404).json({ message: "Friend request not found" })
    }

    if (friendRequest.receiver.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Unauthorized to reject this request" })
    }

    if (friendRequest.status !== "pending") {
      return res.status(400).json({ message: "Friend request already processed" })
    }

    // Update friend request status
    friendRequest.status = "rejected"
    await friendRequest.save()

    res.status(200).json({ message: "Friend request rejected" })
  } catch (error) {
    console.error("[v0] Reject friend request error:", error)
    res.status(500).json({ message: "Server error while rejecting friend request" })
  }
})

// Get all friends
router.get("/", authMiddleware, async (req, res) => {
  try {
    // Find all accepted friend requests where user is either sender or receiver
    const friendRequests = await FriendRequest.find({
      $or: [{ sender: req.user._id }, { receiver: req.user._id }],
      status: "accepted",
    })
      .populate("sender", "username email status lastSeen profileImage")
      .populate("receiver", "username email status lastSeen profileImage")

    // Extract friend users
    const friends = friendRequests.map((request) => {
      if (request.sender._id.toString() === req.user._id.toString()) {
        return request.receiver
      } else {
        return request.sender
      }
    })

    res.status(200).json({ friends })
  } catch (error) {
    console.error("[v0] Get friends error:", error)
    res.status(500).json({ message: "Server error while fetching friends" })
  }
})

// Check friend status with a user
router.get("/status/:userId", authMiddleware, async (req, res) => {
  try {
    const friendRequest = await FriendRequest.findOne({
      $or: [
        { sender: req.user._id, receiver: req.params.userId },
        { sender: req.params.userId, receiver: req.user._id },
      ],
    })

    if (!friendRequest) {
      return res.status(200).json({ status: "none" })
    }

    // Determine the relationship status
    const status = friendRequest.status
    const isSender = friendRequest.sender.toString() === req.user._id.toString()

    res.status(200).json({
      status,
      isSender,
      requestId: friendRequest._id,
    })
  } catch (error) {
    console.error("[v0] Check friend status error:", error)
    res.status(500).json({ message: "Server error while checking friend status" })
  }
})

module.exports = router
