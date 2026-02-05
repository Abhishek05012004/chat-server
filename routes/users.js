const express = require("express")
const router = express.Router()
const User = require("../models/User")
const FriendRequest = require("../models/FriendRequest")
const authMiddleware = require("../middleware/auth")

// Get all users (excluding current user)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user._id } }).select("-password -otp -otpExpiry")

    res.status(200).json({ users })
  } catch (error) {
    console.error("[v0] Get users error:", error)
    res.status(500).json({ message: "Server error while fetching users" })
  }
})

// Search users
router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { query } = req.query

    if (!query) {
      return res.status(400).json({ message: "Search query is required" })
    }

    const users = await User.find({
      _id: { $ne: req.user._id },
      $or: [{ username: { $regex: query, $options: "i" } }, { email: { $regex: query, $options: "i" } }],
    }).select("-password -otp -otpExpiry")

    res.status(200).json({ users })
  } catch (error) {
    console.error("[v0] Search users error:", error)
    res.status(500).json({ message: "Server error while searching users" })
  }
})

// Get user by ID
router.get("/:userId", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("-password -otp -otpExpiry")

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    res.status(200).json({ user })
  } catch (error) {
    console.error("[v0] Get user error:", error)
    res.status(500).json({ message: "Server error while fetching user" })
  }
})

module.exports = router
