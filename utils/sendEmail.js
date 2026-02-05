const nodemailer = require("nodemailer")

const createTransporter = () => {
  // Check if email credentials are configured
  const emailUser = process.env.EMAIL_USER?.trim()
  const emailPass = process.env.EMAIL_APP_PASSWORD?.trim().replace(/\s+/g, "")

  if (!emailUser || !emailPass) {
    console.error("[v0] Email credentials missing!")
    console.error("[v0] EMAIL_USER:", emailUser ? "✓ Found" : "✗ Missing")
    console.error("[v0] EMAIL_APP_PASSWORD:", emailPass ? "✓ Found" : "✗ Missing")
    throw new Error("Email credentials not configured. Please check your .env file.")
  }

  console.log("[v0] Creating email transporter for:", emailUser)

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: emailUser,
      pass: emailPass,
    },
  })
}

// Send OTP email
const sendOTPEmail = async (email, otp, username) => {
  try {
    const transporter = createTransporter()

    const mailOptions = {
      from: `"MERN Chat App" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Verify Your Email - MERN Chat App",
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
              .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
              .otp-box { background: white; border: 2px solid #4F46E5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 5px; }
              .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>Welcome to MERN Chat!</h1>
              </div>
              <div class="content">
                <h2>Hello ${username},</h2>
                <p>Thank you for registering with MERN Chat App. To complete your registration, please use the following One-Time Password (OTP):</p>
                <div class="otp-box">${otp}</div>
                <p>This OTP is valid for 10 minutes. Please do not share this code with anyone.</p>
                <p>If you didn't request this registration, please ignore this email.</p>
              </div>
              <div class="footer">
                <p>This is an automated email, please do not reply.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    }

    await transporter.sendMail(mailOptions)
    console.log("[v0] OTP email sent successfully to:", email)
    return true
  } catch (error) {
    console.error("[v0] Error sending OTP email:", error.message)
    throw new Error(`Failed to send OTP email: ${error.message}`)
  }
}

// Send Password Reset OTP email
const sendPasswordResetEmail = async (email, otp, username) => {
  try {
    const transporter = createTransporter()

    const mailOptions = {
      from: `"MERN Chat App" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Reset Your Password - MERN Chat App",
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #EF4444; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
              .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
              .otp-box { background: white; border: 2px solid #EF4444; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 5px; }
              .warning { background: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0; }
              .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🔒 Password Reset Request</h1>
              </div>
              <div class="content">
                <h2>Hello ${username},</h2>
                <p>We received a request to reset your password for your MERN Chat account. To proceed, please use the following One-Time Password (OTP):</p>
                <div class="otp-box">${otp}</div>
                <p>This OTP is valid for 10 minutes. Please do not share this code with anyone.</p>
                <div class="warning">
                  <strong>⚠️ Important:</strong> If you didn't request this password reset, please ignore this email and ensure your account is secure.
                </div>
              </div>
              <div class="footer">
                <p>This is an automated email, please do not reply.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    }

    await transporter.sendMail(mailOptions)
    console.log("[v0] Password reset email sent successfully to:", email)
    return true
  } catch (error) {
    console.error("[v0] Error sending password reset email:", error.message)
    throw new Error(`Failed to send password reset email: ${error.message}`)
  }
}

module.exports = { sendOTPEmail, sendPasswordResetEmail }
