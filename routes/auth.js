const express = require("express")
const router = express.Router()
const jwt = require("jsonwebtoken")
const User = require("../models/User")
const { sendOTPEmail, sendPasswordResetEmail } = require("../utils/sendEmail")
const authMiddleware = require("../middleware/auth")

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// Register - Step 1: Check uniqueness and send OTP
router.post("/register", async (req, res) => {
  try {
    const { username, email, phoneNumber } = req.body

    console.log("[v0] Registration attempt - Original username:", username)

    // Validate input
    if (!username || !email || !phoneNumber) {
      return res.status(400).json({ message: "All fields are required" })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" })
    }

    if (phoneNumber.length < 10) {
      return res.status(400).json({ message: "Invalid phone number" })
    }

    const existingUser = await User.findOne({
      $or: [
        { username: { $regex: new RegExp(`^${username}$`, "i") } },
        { email: email.toLowerCase() },
        { phoneNumber },
      ],
    })

    if (existingUser) {
      if (existingUser.username.toLowerCase() === username.toLowerCase()) {
        return res.status(400).json({ message: "Username already exists" })
      }
      if (existingUser.email === email.toLowerCase()) {
        return res.status(400).json({ message: "Email already exists" })
      }
      if (existingUser.phoneNumber === phoneNumber) {
        return res.status(400).json({ message: "Phone number already exists" })
      }
    }

    // Generate OTP
    const otp = generateOTP()
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

    console.log("[v0] Generated OTP:", otp, "for user:", username)
    console.log("[v0] Creating user with username:", username, "- preserving case")

    const tempUser = new User({
      username: username, // Save exactly as provided
      email: email.toLowerCase(), // Email should be lowercase
      phoneNumber,
      password: "temporary", // Will be set later
      otp,
      otpExpiry,
      isVerified: false,
    })

    await tempUser.save()
    console.log("[v0] Temporary user created with ID:", tempUser._id, "- Username saved as:", tempUser.username)

    try {
      await sendOTPEmail(email, otp, username)
      console.log("[v0] OTP email sent successfully")
    } catch (emailError) {
      // Clean up the temporary user if email fails
      await User.findByIdAndDelete(tempUser._id)
      console.error("[v0] Failed to send email, user deleted:", emailError.message)
      return res.status(500).json({
        message: "Failed to send OTP email. Please check your email configuration.",
        error: emailError.message,
      })
    }

    res.status(200).json({
      message: "OTP sent to your email",
      userId: tempUser._id,
    })
  } catch (error) {
    console.error("[v0] Register error:", error)
    res.status(500).json({
      message: "Server error during registration",
      error: error.message,
    })
  }
})

// Verify OTP - Step 2
router.post("/verify-otp", async (req, res) => {
  try {
    const { userId, otp } = req.body

    if (!userId || !otp) {
      return res.status(400).json({ message: "User ID and OTP are required" })
    }

    // Find user
    const user = await User.findById(userId)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Check if already verified
    if (user.isVerified) {
      return res.status(400).json({ message: "User already verified" })
    }

    // Check OTP expiry
    if (user.otpExpiry < new Date()) {
      return res.status(400).json({ message: "OTP has expired" })
    }

    // Verify OTP
    if (user.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" })
    }

    // Mark as verified but don't clear OTP yet (need to set password)
    user.isVerified = true
    await user.save()

    res.status(200).json({
      message: "OTP verified successfully",
      userId: user._id,
    })
  } catch (error) {
    console.error("[v0] Verify OTP error:", error)
    res.status(500).json({ message: "Server error during OTP verification" })
  }
})

// Set Password - Step 3
router.post("/set-password", async (req, res) => {
  try {
    const { userId, password } = req.body

    if (!userId || !password) {
      return res.status(400).json({ message: "User ID and password are required" })
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" })
    }

    // Find user
    const user = await User.findById(userId)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    if (!user.isVerified) {
      return res.status(400).json({ message: "Please verify OTP first" })
    }

    console.log("[v0] Setting password for user:", user.username, "- Current username in DB:", user.username)

    // Set password
    user.password = password
    user.otp = undefined
    user.otpExpiry = undefined
    await user.save()

    console.log("[v0] Password set, username after save:", user.username)

    // Generate JWT token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    })

    res.status(200).json({
      message: "Registration completed successfully",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phoneNumber: user.phoneNumber,
        profileImage: user.profileImage,
      },
    })
  } catch (error) {
    console.error("[v0] Set password error:", error)
    res.status(500).json({ message: "Server error while setting password" })
  }
})

// Resend OTP
router.post("/resend-otp", async (req, res) => {
  try {
    const { userId } = req.body

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" })
    }

    // Find user
    const user = await User.findById(userId)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "User already verified" })
    }

    // Generate new OTP
    const otp = generateOTP()
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000)

    user.otp = otp
    user.otpExpiry = otpExpiry
    await user.save()

    // Send OTP email
    await sendOTPEmail(user.email, otp, user.username)

    res.status(200).json({ message: "OTP resent successfully" })
  } catch (error) {
    console.error("[v0] Resend OTP error:", error)
    res.status(500).json({ message: "Server error while resending OTP" })
  }
})

// Forgot Password - Step 1: Request OTP
router.post("/forgot-password", async (req, res) => {
  try {
    const { identifier } = req.body

    if (!identifier) {
      return res.status(400).json({ message: "Username, email, or phone is required" })
    }

    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }, { phoneNumber: identifier }],
    })

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    if (!user.isVerified) {
      return res.status(400).json({ message: "Please verify your email first" })
    }

    // Generate OTP
    const otp = generateOTP()
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

    user.otp = otp
    user.otpExpiry = otpExpiry
    await user.save()

    // Send OTP email
    await sendPasswordResetEmail(user.email, otp, user.username)

    res.status(200).json({
      message: "OTP sent to your registered email",
      userId: user._id,
    })
  } catch (error) {
    console.error("[v0] Forgot password error:", error)
    res.status(500).json({ message: "Server error during password reset request" })
  }
})

// Verify OTP for forgot password - Step 2
router.post("/verify-forgot-otp", async (req, res) => {
  try {
    const { userId, otp } = req.body

    if (!userId || !otp) {
      return res.status(400).json({ message: "User ID and OTP are required" })
    }

    const user = await User.findById(userId)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Check OTP expiry
    if (user.otpExpiry < new Date()) {
      return res.status(400).json({ message: "OTP has expired" })
    }

    // Verify OTP
    if (user.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" })
    }

    res.status(200).json({
      message: "OTP verified successfully",
      userId: user._id,
    })
  } catch (error) {
    console.error("[v0] Verify forgot OTP error:", error)
    res.status(500).json({ message: "Server error during OTP verification" })
  }
})

// Reset Password - Step 3
router.post("/reset-password", async (req, res) => {
  try {
    const { userId, password } = req.body

    if (!userId || !password) {
      return res.status(400).json({ message: "User ID and password are required" })
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" })
    }

    const user = await User.findById(userId)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Set new password
    user.password = password
    user.otp = undefined
    user.otpExpiry = undefined
    await user.save()

    res.status(200).json({
      message: "Password reset successful",
    })
  } catch (error) {
    console.error("[v0] Reset password error:", error)
    res.status(500).json({ message: "Server error while resetting password" })
  }
})

// Resend OTP for forgot password
router.post("/resend-forgot-otp", async (req, res) => {
  try {
    const { userId } = req.body

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" })
    }

    const user = await User.findById(userId)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Generate new OTP
    const otp = generateOTP()
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000)

    user.otp = otp
    user.otpExpiry = otpExpiry
    await user.save()

    // Send OTP email
    await sendPasswordResetEmail(user.email, otp, user.username)

    res.status(200).json({ message: "OTP resent successfully" })
  } catch (error) {
    console.error("[v0] Resend forgot OTP error:", error)
    res.status(500).json({ message: "Server error while resending OTP" })
  }
})

// Login
router.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body

    if (!identifier || !password) {
      return res.status(400).json({ message: "All fields are required" })
    }

    console.log("[v0] Login attempt with identifier:", identifier)

    let user = await User.findOne({ username: identifier })

    // If not found by exact username, try email or phone
    if (!user) {
      user = await User.findOne({
        $or: [{ email: identifier.toLowerCase() }, { phoneNumber: identifier }],
      })
    }

    console.log("[v0] User found:", user ? user.username : "none")

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" })
    }

    if (!user.isVerified) {
      return res.status(401).json({ message: "Please verify your email first" })
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password)

    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials" })
    }

    // Update last seen
    user.lastSeen = new Date()
    user.status = "online"
    await user.save()

    // Generate JWT token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    })

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phoneNumber: user.phoneNumber,
        status: user.status,
        profileImage: user.profileImage,
      },
    })
  } catch (error) {
    console.error("[v0] Login error:", error)
    res.status(500).json({ message: "Server error during login" })
  }
})

// Get current user
router.get("/me", authMiddleware, async (req, res) => {
  try {
    res.status(200).json({
      user: {
        id: req.user._id,
        username: req.user.username,
        email: req.user.email,
        phoneNumber: req.user.phoneNumber,
        status: req.user.status,
        lastSeen: req.user.lastSeen,
        profileImage: req.user.profileImage,
      },
    })
  } catch (error) {
    console.error("[v0] Get me error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

// Logout
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    req.user.status = "offline"
    req.user.lastSeen = new Date()
    await req.user.save()

    res.status(200).json({ message: "Logged out successfully" })
  } catch (error) {
    console.error("[v0] Logout error:", error)
    res.status(500).json({ message: "Server error during logout" })
  }
})

module.exports = router
