/**
 * Email utilities (SMTP)
 * Used for OTP verification
 */
import nodemailer from 'nodemailer'
import { env } from './env'

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS || !env.SMTP_FROM) {
    throw new Error('SMTP is not configured')
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  })

  await transporter.sendMail({
    from: env.SMTP_FROM,
    to,
    subject: 'Your verification code',
    text: `Your verification code is: ${code}`,
    html: `<p>Your verification code is:</p><p><strong>${code}</strong></p>`,
  })
}
