const nodemailer = require("nodemailer")

// Send email using Brevo's HTTPS REST API (Recommended for production on Render Free tier)
const sendEmailViaBrevoAPI = async (email, subject, htmlContent) => {
  const apiKey = process.env.BREVO_SMTP_PASS || process.env.BREVO_API_KEY || process.env.EMAIL_APP_PASSWORD;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER || "abhishekjha2707@gmail.com";

  if (!apiKey) {
    console.error("[v0] Brevo API Key / SMTP Password missing!");
    throw new Error("Brevo API key not configured. Please check environment variables.");
  }

  console.log("[v0] Sending email via Brevo REST API to:", email);

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey.trim(),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      sender: { name: "Chat App", email: senderEmail.trim() },
      to: [{ email: email.trim() }],
      subject: subject,
      htmlContent: htmlContent
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("[v0] Brevo REST API Error:", data);
    throw new Error(data.message || "Failed to send email via Brevo REST API");
  }

  console.log("[v0] Email sent successfully via Brevo REST API");
  return true;
};

// Send email using SMTP (Recommended for localhost/development)
const sendEmailViaSMTP = async (email, subject, htmlContent) => {
  const emailUser = process.env.BREVO_SMTP_USER || process.env.EMAIL_USER;
  const emailPass = process.env.BREVO_SMTP_PASS || process.env.EMAIL_APP_PASSWORD;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER || "abhishekjha2707@gmail.com";

  if (!emailUser || !emailPass) {
    console.error("[v0] SMTP credentials missing!");
    throw new Error("SMTP credentials not configured.");
  }

  const isBrevo = emailUser.includes("brevo") || emailPass.startsWith("xsmtpsib");
  const host = isBrevo ? "smtp-relay.brevo.com" : "smtp.gmail.com";
  const port = isBrevo ? 587 : 465;
  const secure = !isBrevo; // true for Gmail 465, false for Brevo 587 (uses STARTTLS)

  console.log(`[v0] Creating SMTP transporter for: ${emailUser} via ${host}:${port}`);

  const transporter = nodemailer.createTransport({
    host: host,
    port: port,
    secure: secure,
    auth: {
      user: emailUser.trim(),
      pass: emailPass.trim().replace(/\s+/g, ""),
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });

  const mailOptions = {
    from: `"Chat App" <${senderEmail.trim()}>`,
    to: email,
    subject: subject,
    html: htmlContent,
  };

  await transporter.sendMail(mailOptions);
  console.log("[v0] Email sent successfully via SMTP to:", email);
  return true;
};

// Main wrapper to route based on environment
const sendMailWrapper = async (email, subject, htmlContent) => {
  const isProduction = process.env.NODE_ENV === "production";
  
  if (isProduction) {
    try {
      return await sendEmailViaBrevoAPI(email, subject, htmlContent);
    } catch (apiError) {
      console.error("[v0] Brevo API sending failed, attempting SMTP fallback...", apiError.message);
      // Fallback to SMTP in case of issues
      return await sendEmailViaSMTP(email, subject, htmlContent);
    }
  } else {
    // In development, prefer SMTP
    return await sendEmailViaSMTP(email, subject, htmlContent);
  }
};

// Send OTP email
const sendOTPEmail = async (email, otp, username) => {
  const subject = "Verify Your Email - Chat App";
  const htmlContent = `
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
            <h1>Welcome to Chat App!</h1>
          </div>
          <div class="content">
            <h2>Hello ${username},</h2>
            <p>Thank you for registering with Chat App. To complete your registration, please use the following One-Time Password (OTP):</p>
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
  `;
  return await sendMailWrapper(email, subject, htmlContent);
};

// Send Password Reset OTP email
const sendPasswordResetEmail = async (email, otp, username) => {
  const subject = "Reset Your Password - Chat App";
  const htmlContent = `
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
            <p>We received a request to reset your password for your Chat App account. To proceed, please use the following One-Time Password (OTP):</p>
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
  `;
  return await sendMailWrapper(email, subject, htmlContent);
};

module.exports = { sendOTPEmail, sendPasswordResetEmail }
