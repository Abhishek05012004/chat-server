const express = require("express")
const router = express.Router()
const User = require("../models/User")
const auth = require("../middleware/auth")

// Get specific user's profile
router.get("/:userId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("-password -otp -otpExpiry")

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    res.json(user)
  } catch (error) {
    console.error("Get profile error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

// Get current user's own profile
router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password -otp -otpExpiry")

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    res.json(user)
  } catch (error) {
    console.error("Get own profile error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

// Update own profile
router.put("/", auth, async (req, res) => {
  try {
    const { profileImage, bio, username } = req.body
    const userId = req.user._id

    console.log("[v0] Profile update request - New username:", username, "for user ID:", userId)

    const updateData = {}
    if (profileImage !== undefined) updateData.profileImage = profileImage
    if (bio !== undefined) updateData.bio = bio
    if (username !== undefined) {
      const existingUser = await User.findOne({
        username: { $regex: new RegExp(`^${username}$`, "i") },
        _id: { $ne: userId },
      })
      if (existingUser) {
        return res.status(400).json({ message: "Username already taken" })
      }
      updateData.username = username
      console.log("[v0] Username will be updated to:", username)
    }

    const user = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
    }).select("-password -otp -otpExpiry")

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    console.log("[v0] Profile updated - Username now:", user.username)

    res.json({ message: "Profile updated successfully", user })
  } catch (error) {
    console.error("Update profile error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

module.exports = router
