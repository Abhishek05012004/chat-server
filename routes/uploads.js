const express = require("express")
const router = express.Router()
const multer = require("multer")
const path = require("path")
const fs = require("fs")
const mime = require("mime-types")
const authMiddleware = require("../middleware/auth")
const Chat = require("../models/Chat")
const Message = require("../models/Message")

const uploadsDir = path.join(__dirname, "../uploads")
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9)
    const ext = path.extname(file.originalname)
    cb(null, uniqueSuffix + ext)
  },
})

const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "application/zip",
    "application/x-zip-compressed",
  ]

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new Error("Invalid file type. Only images, PDFs, and documents are allowed."), false)
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
})

router.post("/:chatId/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const { chatId } = req.params

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" })
    }

    // Verify file exists and has content
    if (!fs.existsSync(req.file.path)) {
      return res.status(400).json({ message: "File upload failed - file not saved" })
    }

    const stats = fs.statSync(req.file.path)
    if (stats.size === 0) {
      fs.unlinkSync(req.file.path)
      return res.status(400).json({ message: "File is empty" })
    }

    // Check if user is part of the chat
    const chat = await Chat.findById(chatId)
    if (!chat) {
      fs.unlinkSync(req.file.path)
      return res.status(404).json({ message: "Chat not found" })
    }

    if (!chat.participants.includes(req.user._id)) {
      fs.unlinkSync(req.file.path)
      return res.status(403).json({ message: "Unauthorized" })
    }

    const fileUrl = `/api/uploads/file/${req.file.filename}`

    const message = new Message({
      chat: chatId,
      sender: req.user._id,
      content: req.body.caption || "",
      attachments: [
        {
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          fileSize: req.file.size,
          fileUrl: fileUrl,
          uploadedAt: new Date(),
        },
      ],
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
    console.error("[v0] Upload error:", error)
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    res.status(500).json({ message: error.message || "Upload failed" })
  }
})

router.get("/file/:filename", (req, res) => {
  try {
    const { filename } = req.params
    const filePath = path.join(uploadsDir, filename)

    // Security: prevent directory traversal attacks
    const normalizedPath = path.normalize(filePath)
    const normalizedDir = path.normalize(uploadsDir)

    if (!normalizedPath.startsWith(normalizedDir)) {
      return res.status(403).json({ message: "Access denied" })
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File not found" })
    }

    const stats = fs.statSync(filePath)

    // Validate it's a file and has content
    if (!stats.isFile() || stats.size === 0) {
      return res.status(400).json({ message: "Invalid file" })
    }

    const mimeType = mime.lookup(filePath) || "application/octet-stream"
    const safeName = path.basename(filePath)

    res.setHeader("Content-Type", mimeType)
    res.setHeader("Content-Length", stats.size)
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeName)}"`)
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    res.setHeader("Pragma", "no-cache")
    res.setHeader("Expires", "0")
    res.setHeader("Accept-Ranges", "bytes")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("X-Content-Type-Options", "nosniff")

    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: 64 * 1024,
    })

    fileStream.on("error", (error) => {
      console.error("[v0] Stream error:", error)
      if (!res.headersSent) {
        res.status(500).json({ message: "Download error" })
      }
    })

    fileStream.pipe(res)
  } catch (error) {
    console.error("[v0] Download error:", error)
    if (!res.headersSent) {
      res.status(500).json({ message: "Server error" })
    }
  }
})

router.get("/:chatId/media", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params
    const { type, startDate, endDate } = req.query

    const chat = await Chat.findById(chatId)
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" })
    }

    if (!chat.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized" })
    }

    const filter = {
      chat: chatId,
      attachments: { $exists: true, $ne: [] },
    }

    if (type) {
      filter["attachments.fileType"] = { $regex: type, $options: "i" }
    }

    if (startDate || endDate) {
      filter.createdAt = {}
      if (startDate) filter.createdAt.$gte = new Date(startDate)
      if (endDate) filter.createdAt.$lte = new Date(endDate)
    }

    const messages = await Message.find(filter)
      .populate("sender", "username email profileImage")
      .sort({ createdAt: -1 })

    res.status(200).json({ media: messages })
  } catch (error) {
    console.error("[v0] Media fetch error:", error)
    res.status(500).json({ message: "Error fetching media" })
  }
})

module.exports = router
